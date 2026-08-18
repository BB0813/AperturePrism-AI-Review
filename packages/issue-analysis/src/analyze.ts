import {
  parseIssueAnalysisJson,
  type GradedIssueAnalysis,
} from "../../../packages/contracts/src/index.js";
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
import type { IssueContext } from "./context.js";
import {
  buildIssueAnalysisRepairRequest,
  buildIssueAnalysisRequest,
} from "./prompt.js";

export type IssueAnalyzerOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across main call, retries, and the repair. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type IssueAnalysisOutcome =
  | {
      outcome: "valid";
      analysis: GradedIssueAnalysis;
      usage: ModelUsage;
      candidate: ModelCandidate;
      attempts: readonly ModelAttemptOutcome[];
      /** Wall-clock time consumed by the model phase, including the repair. */
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
 * Runs the main analysis, validates the contract, and performs exactly one
 * bounded repair when the contract fails. A still-invalid result is reported
 * as `invalid` so the engine can retry the task; no automatic decision is
 * ever published from an unvalidated response.
 */
export async function analyzeIssue(
  options: IssueAnalyzerOptions,
  context: IssueContext,
): Promise<IssueAnalysisOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const main = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildIssueAnalysisRequest(context),
    deadlineMs: options.deadlineMs,
    retryPolicy: options.retryPolicy,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  const validation = parseIssueAnalysisJson(main.response.content);
  if (validation.outcome === "valid") {
    return {
      outcome: "valid",
      analysis: validation.analysis,
      usage: main.response.usage,
      candidate: main.candidate,
      attempts: main.attempts,
      durationMs: now() - startedAt,
    };
  }

  const remainingMs = Math.max(0, options.deadlineMs - (now() - startedAt));
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildIssueAnalysisRepairRequest(
      context,
      main.response.content,
      validation.issues,
    ),
    deadlineMs: remainingMs,
    retryPolicy: options.retryPolicy,
    // Prefer the candidate that already answered, so repairs stay consistent.
    stickyCandidate: main.candidate,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  const repaired = parseIssueAnalysisJson(repair.response.content);
  const attempts = [...main.attempts, ...repair.attempts];
  const usage = totalUsage(main.response.usage, repair.response.usage);

  if (repaired.outcome === "valid") {
    return {
      outcome: "valid",
      analysis: repaired.analysis,
      usage,
      candidate: repair.candidate,
      attempts,
      durationMs: now() - startedAt,
    };
  }

  return { outcome: "invalid", usage, attempts, durationMs: now() - startedAt };
}
