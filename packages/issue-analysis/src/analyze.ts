import {
  parseIssueAnalysisJson,
  type GradedIssueAnalysis,
} from "../../../packages/contracts/src/index.js";
import type {
  ModelAttemptOutcome,
  ModelCandidate,
  ModelInvocationRequest,
  ModelProviderAdapter,
  ModelUsage,
} from "../../../packages/domain/src/index.js";
import {
  routeModelInvocation,
  type RetryPolicy,
} from "../../../packages/model-router/src/index.js";
import {
  builtinTools,
  runToolLoop,
  type ToolExecutionContext,
} from "../../../packages/pr-review/src/index.js";
import type { IssueContext } from "./context.js";
import {
  buildIssueAnalysisMessages,
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
  /**
   * 开启后主分析先做一轮工具探索，让模型读取仓库源码再作答。不开启时模型只能
   * 看到 Issue 文本，无法给出定位到文件与位置的修复建议。默认关闭：探索会显著
   * 增加 token 消耗与单任务耗时。
   */
  tools?: {
    context: ToolExecutionContext;
    maxRounds?: number;
  };
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
  const remainingMsFrom = () =>
    Math.max(0, options.deadlineMs - (now() - startedAt));

  /** 单次模型调用，共享同一个逻辑 deadline。 */
  const invokeOnce = (request: ModelInvocationRequest) =>
    routeModelInvocation(options.adapters, {
      candidates: options.candidates,
      request,
      deadlineMs: remainingMsFrom(),
      retryPolicy: options.retryPolicy,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });

  // 工具探索复用 PR 审查已验证的循环实现，它自行构造请求并注入工具定义。
  // 仍保留 main 这次路由调用：candidate 供修复阶段 sticky，attempts/usage
  // 供 attempt 记账，两者都无法从循环内部获得。代价是开启探索时多一次调用，
  // 这也是该能力默认关闭的原因之一。
  const main = await invokeOnce(buildIssueAnalysisRequest(context));
  let mainContent = main.response.content;
  if (options.tools) {
    const loop = await runToolLoop(
      (request) => invokeOnce(request).then((result) => result.response),
      buildIssueAnalysisMessages(context),
      options.tools.context,
      {
        tools: builtinTools(),
        exploreInstruction:
          "你可以调用 read_file / list_directory / get_git_info 查看仓库源码，" +
          "以定位这个 Issue 描述的问题出在哪个文件。请先定位再作答：" +
          "proposedChanges 里的 path 必须是你确实读到过的真实文件；" +
          "找不到相关代码时省略该字段并说明原因，不要凭猜测编造路径或行号。",
        ...(options.tools.maxRounds === undefined
          ? {}
          : { maxRounds: options.tools.maxRounds }),
      },
    );
    mainContent =
      loop.messages[loop.messages.length - 1]?.content ?? main.response.content;
  }

  // exploredCode 决定服务端是否保留 proposedChanges 的行号定位。
  const gradingOptions = { exploredCode: options.tools !== undefined };
  const validation = parseIssueAnalysisJson(mainContent, gradingOptions);
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

  const remainingMs = remainingMsFrom();
  const repair = await routeModelInvocation(options.adapters, {
    candidates: options.candidates,
    request: buildIssueAnalysisRepairRequest(
      context,
      // 修复要基于实际待修的那份输出：开启探索时是循环结果，而非被丢弃的首答。
      mainContent,
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

  const repaired = parseIssueAnalysisJson(
    repair.response.content,
    gradingOptions,
  );
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
