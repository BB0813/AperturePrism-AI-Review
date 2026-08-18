import {
  ModelInvocationError,
  nonRetryableModelErrorCategories,
  type ModelAttemptOutcome,
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelProviderAdapter,
  type ModelRoutingResult,
} from "../../../packages/domain/src/index.js";

export * from "./openai-compatible.js";

export type RetryPolicy = {
  /** Attempts allowed per candidate, including the first one. */
  maxAttemptsPerCandidate: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RouteModelInput = {
  candidates: readonly ModelCandidate[];
  request: ModelInvocationRequest;
  /** Total wall-clock budget shared by every candidate, retry, and backoff. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  /** Candidate preferred for this task, tried first when still present. */
  stickyCandidate?: ModelCandidate | undefined;
  signal?: AbortSignal | undefined;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export class ModelRoutingFailedError extends Error {
  readonly attempts: readonly ModelAttemptOutcome[];
  readonly lastCategory: ModelErrorCategory;

  constructor(
    lastCategory: ModelErrorCategory,
    attempts: readonly ModelAttemptOutcome[],
  ) {
    super(`model routing exhausted all candidates: ${lastCategory}`);
    this.name = "ModelRoutingFailedError";
    this.attempts = attempts;
    this.lastCategory = lastCategory;
  }
}

export function candidateKey(candidate: ModelCandidate): string {
  return `${candidate.provider}:${candidate.model}:${candidate.accountName}`;
}

/**
 * Puts the sticky candidate first so a task keeps using the model that already
 * worked for it, without dropping the remaining fallbacks.
 */
export function orderCandidates(
  candidates: readonly ModelCandidate[],
  sticky: ModelCandidate | undefined,
): readonly ModelCandidate[] {
  if (!sticky) return candidates;
  const stickyKey = candidateKey(sticky);
  const preferred = candidates.filter((c) => candidateKey(c) === stickyKey);
  if (preferred.length === 0) return candidates;
  return [
    ...preferred,
    ...candidates.filter((c) => candidateKey(c) !== stickyKey),
  ];
}

export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, policy.maxDelayMs);
}

function toModelError(error: unknown): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new ModelInvocationError("canceled", "invocation was canceled");
  return new ModelInvocationError(
    "unknown",
    error instanceof Error ? error.message : "unknown provider failure",
  );
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelInvocationError("canceled", "wait was canceled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs candidates in order under a single logical deadline. Adapters classify
 * failures; this router decides whether to retry the same candidate, move to
 * the next one, or stop.
 */
export async function routeModelInvocation(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
  input: RouteModelInput,
): Promise<ModelRoutingResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const deadlineAt = now() + input.deadlineMs;
  const attempts: ModelAttemptOutcome[] = [];
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  input.signal?.addEventListener("abort", abortOuter, { once: true });

  const remaining = () => deadlineAt - now();
  let lastCategory: ModelErrorCategory = "unknown";

  try {
    if (input.signal?.aborted)
      throw new ModelRoutingFailedError("canceled", attempts);

    for (const candidate of orderCandidates(
      input.candidates,
      input.stickyCandidate,
    )) {
      const adapter = adapters.get(candidate.provider);
      if (!adapter) {
        lastCategory = "model_not_found";
        attempts.push({
          candidate,
          startedAt: new Date(now()),
          finishedAt: new Date(now()),
          usage: null,
          errorCategory: "model_not_found",
        });
        continue;
      }

      for (
        let attempt = 1;
        attempt <= input.retryPolicy.maxAttemptsPerCandidate;
        attempt += 1
      ) {
        if (remaining() <= 0) {
          lastCategory = "timeout";
          throw new ModelRoutingFailedError(lastCategory, attempts);
        }

        const startedAt = new Date(now());
        try {
          const response = await withDeadline(
            adapter,
            candidate,
            input.request,
            controller.signal,
            remaining(),
          );
          attempts.push({
            candidate,
            startedAt,
            finishedAt: new Date(now()),
            usage: response.usage,
            errorCategory: null,
          });
          return { response, candidate, attempts };
        } catch (error) {
          const modelError = toModelError(error);
          lastCategory = modelError.category;
          attempts.push({
            candidate,
            startedAt,
            finishedAt: new Date(now()),
            usage: null,
            errorCategory: modelError.category,
          });

          if (modelError.category === "canceled")
            throw new ModelRoutingFailedError("canceled", attempts);
          if (nonRetryableModelErrorCategories.includes(modelError.category))
            break;
          if (attempt === input.retryPolicy.maxAttemptsPerCandidate) break;

          const delay = Math.min(
            modelError.retryAfterMs ??
              backoffDelayMs(attempt, input.retryPolicy),
            Math.max(0, remaining()),
          );
          if (remaining() - delay <= 0) {
            lastCategory = "timeout";
            throw new ModelRoutingFailedError(lastCategory, attempts);
          }
          await sleep(delay, controller.signal);
        }
      }
    }

    throw new ModelRoutingFailedError(lastCategory, attempts);
  } finally {
    input.signal?.removeEventListener("abort", abortOuter);
  }
}

async function withDeadline(
  adapter: ModelProviderAdapter,
  candidate: ModelCandidate,
  request: ModelInvocationRequest,
  signal: AbortSignal,
  budgetMs: number,
): Promise<ModelInvocationResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await adapter.invoke(candidate, request, controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted)
      throw new ModelInvocationError("timeout", "candidate exceeded deadline");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
