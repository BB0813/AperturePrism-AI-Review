import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import type { RenderedPrContext } from "./context.js";
import { selectReviewMode } from "./context.js";
import { buildPrReviewRepairRequest, buildPrReviewMessages, buildPrReviewRequest } from "./prompt.js";
import type { PrReviewContract } from "./types.js";
import { parsePrReviewJson } from "./validate.js";
import { builtinTools, runToolLoop, type ToolExecutionContext } from "./tools.js";

export type PrReviewerOptions = {
  adapters: ReadonlyMap<string, ModelProviderAdapter>;
  candidates: readonly ModelCandidate[];
  /** Shared logical deadline across the main call and the bounded repair. */
  deadlineMs: number;
  retryPolicy: RetryPolicy;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 可选：启用 AI 主动探索工具（提供仓库只读访问上下文）。 */
  tools?: {
    context: ToolExecutionContext;
    maxRounds?: number;
  };
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

/**
 * Runs the main review, validates the contract, and performs exactly one
 * bounded repair when it fails. A still-invalid result is reported as
 * `invalid` so the engine can retry the task; nothing is ever published from
 * an unvalidated response.
 *
 * When `options.tools` is set, the review first runs an agentic exploration
 * loop (model may call read_file / list_directory / get_git_info against the
 * repository) before producing the final contract.
 */
export async function reviewPullRequest(
  options: PrReviewerOptions,
  context: RenderedPrContext,
): Promise<PrReviewOutcome> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const attempts: ModelAttemptOutcome[] = [];
  const usageList: ModelUsage[] = [];
  let sticky: ModelCandidate | undefined;

  const invoke = async (
    request: ModelInvocationRequest,
  ): Promise<ModelInvocationResponse> => {
    const remainingMs = Math.max(0, options.deadlineMs - (now() - startedAt));
    const result = await routeModelInvocation(options.adapters, {
      candidates: options.candidates,
      request,
      deadlineMs: remainingMs,
      retryPolicy: options.retryPolicy,
      stickyCandidate: sticky,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    sticky = result.candidate;
    attempts.push(...result.attempts);
    usageList.push(result.response.usage);
    return result.response;
  };

  const totalUsageValue = (): ModelUsage =>
    usageList.reduce(
      (total, entry) => ({
        inputTokens: total.inputTokens + entry.inputTokens,
        outputTokens: total.outputTokens + entry.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );

  const mode = selectReviewMode(context);

  let mainContent: string;
  if (options.tools) {
    const loop = await runToolLoop(
      invoke,
      buildPrReviewMessages(context, mode),
      options.tools.context,
      {
        tools: builtinTools(),
        exploreInstruction:
          mode === "deep"
            ? "这是大规模/复杂 PR。你可以调用 read_file / list_directory / get_git_info 工具主动查看关键路径、跨文件依赖与相关源码，以全面理解变更影响后给出审查结果。"
            : "你可以调用 read_file / list_directory / get_git_info 工具查看 diff 涉及或相关的源码文件以加深理解，然后给出审查结果。仅在确实需要更多上下文时才调用工具。",
        ...(options.tools.maxRounds === undefined
          ? {}
          : { maxRounds: options.tools.maxRounds }),
      },
    );
    mainContent = loop.messages[loop.messages.length - 1]!.content;
  } else {
    const main = await invoke(buildPrReviewRequest(context, mode));
    mainContent = main.content;
  }

  const validation = parsePrReviewJson(mainContent);
  if (validation.outcome === "valid") {
    return {
      outcome: "valid",
      review: validation.review,
      usage: totalUsageValue(),
      candidate: sticky ?? options.candidates[0]!,
      attempts,
      durationMs: now() - startedAt,
    };
  }

  const remainingMs = Math.max(0, options.deadlineMs - (now() - startedAt));
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildPrReviewRepairRequest(
      context,
      mainContent,
      validation.issues,
      mode,
    ),
    deadlineMs: remainingMs,
    retryPolicy: options.retryPolicy,
    stickyCandidate: sticky,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  attempts.push(...repair.attempts);
  usageList.push(repair.response.usage);

  const repaired = parsePrReviewJson(repair.response.content);
  const usage = totalUsageValue();

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