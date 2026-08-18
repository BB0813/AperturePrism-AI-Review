import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import type { RenderedPrContext } from "./context.js";
import { buildPrReviewRepairRequest, buildPrReviewRequest } from "./prompt.js";
import type { PrReviewContract } from "./types.js";
import { parsePrReviewJson } from "./validate.js";

export type PrReviewerOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across the main call and the bounded repair. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type PrReviewOutcome =
  | {
      outcome: "valid";
      review: PrReviewContract;
      usage: ModelUsage;
      candidate: ModelCandidate;
      attempts: readonly ModelAttemptOutcome[];
      durationMs: number;
    }
  | {
      outcome: "invalid";
      usage: ModelUsage;
      attempts: readonly ModelAttemptOutcome[];
      durationMs: number;
    };

function totalUsage(...usage: readonly ModelUsage[]): ModelUsage {
  return usage.reduce(
    (total, entry) => ({
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * Runs the main review, validates the contract, and performs exactly one
 * bounded repair when it fails. A still-invalid result is reported as
 * `invalid` so the engine can retry the task; nothing is ever published from
 * an unvalidated response.
 */
export async function reviewPullRequest(
  options: PrReviewerOptions,
  context: RenderedPrContext,
): Promise<PrReviewOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const main = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildPrReviewRequest(context),
    deadlineMs: options.deadlineMs,
    retryPolicy: options.retryPolicy,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  const validation = parsePrReviewJson(main.response.content);
  if (validation.outcome === "valid") {
    return {
      outcome: "valid",
      review: validation.review,
      usage: main.response.usage,
      candidate: main.candidate,
      attempts: main.attempts,
      durationMs: now() - startedAt,
    };
  }

  const remainingMs = Math.max(0, options.deadlineMs - (now() - startedAt));
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildPrReviewRepairRequest(
      context,
      main.response.content,
      validation.issues,
    ),
    deadlineMs: remainingMs,
    retryPolicy: options.retryPolicy,
    stickyCandidate: main.candidate,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  const repaired = parsePrReviewJson(repair.response.content);
  const attempts = [...main.attempts, ...repair.attempts];
  const usage = totalUsage(main.response.usage, repair.response.usage);

  if (repaired.outcome === "valid") {
    return {
      outcome: "valid",
      review: repaired.review,
      usage,
      candidate: repair.candidate,
      attempts,
      durationMs: now() - startedAt,
    };
  }
  return { outcome: "invalid", usage, attempts, durationMs: now() - startedAt };
}