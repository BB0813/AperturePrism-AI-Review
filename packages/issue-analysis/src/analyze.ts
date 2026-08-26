import {
  parseIssueAnalysisJson,
  type GradedIssueAnalysis,
  type IssueAnalysisResult,
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
  type IssueResultSection,
  type PromptMode,
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
   * Issue 系统提示词版本（如 "v6"）。缺省用当前版本；改「分析设置 → Issue 提示词
   * 版本」可在线回退到历史版本，无需重新部署。
   */
  promptVersion?: string;
  /**
   * 分析强度模式（adaptive / light / full）。缺省 adaptive（分类差异化）；
   * 改「分析设置 → Issue 提示词模式」可全局轻量或全量。
   */
  promptMode?: PromptMode;
  /**
   * 结果区块开关（summary / probable_cause / missing_information / …）。
   * 缺省全开。关闭的区块：prompt 不要求输出，且校验后强制清空对应字段，
   * 保证评论 / 结果页 / 标签都不再出现。
   */
  sections?: ReadonlySet<IssueResultSection>;
  /**
   * 开启后主分析先做一轮工具探索，让模型读取仓库源码再作答。不开启时模型只能
   * 看到 Issue 文本，无法给出定位到文件与位置的修复建议。默认关闭：探索会显著
   * 增加 token 消耗与单任务耗时。
   *
   * 前提：模型网关必须支持 tools / function calling。NAS 上的 newapi 网关实测
   * 对携带 tools 的请求返回 5xx（与它对 response_format 的已知问题同类，见
   * model-router/src/openai-compatible.ts 中的注释），此时任务会重试直至失败。
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
 * 结果区块后置过滤：关闭的区块在 prompt 里已不要求输出，但模型仍可能不守约，
 * 这里对校验后的结果强制清空对应字段，保证评论 / 结果页 / 标签都不再出现。
 * summary 始终保留（契约硬性要求）。缺省（sections 未传）不修改原结果。
 */
function applyResultSections(
  graded: GradedIssueAnalysis,
  sections?: ReadonlySet<IssueResultSection>,
): GradedIssueAnalysis {
  if (!sections) return graded;
  const result = graded.result;
  // 先剔除可选字段：条件展开只能「加」不能「删」，留着会在 ...result 时被原样带回。
  const { suggestedTitle: _title, probableCause: _cause, ...rest } = result;

  const next: IssueAnalysisResult = {
    ...rest,
    troubleshooting: sections.has("troubleshooting")
      ? result.troubleshooting
      : [],
    proposedChanges: sections.has("proposed_changes")
      ? result.proposedChanges
      : [],
    evidence: sections.has("evidence") ? result.evidence : [],
    missingInformation: sections.has("missing_information")
      ? result.missingInformation
      : [],
    suggestedLabels: sections.has("suggested_labels")
      ? result.suggestedLabels
      : [],
    suggestedActions: sections.has("suggested_actions")
      ? result.suggestedActions
      : [],
    ...(sections.has("suggested_title") && result.suggestedTitle !== undefined
      ? { suggestedTitle: result.suggestedTitle }
      : {}),
    ...(sections.has("probable_cause") && result.probableCause !== undefined
      ? { probableCause: result.probableCause }
      : {}),
  };

  return { ...graded, result: next };
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
  const main = await invokeOnce(
    buildIssueAnalysisRequest(
      context,
      options.promptVersion,
      options.promptMode,
      options.sections,
    ),
  );
  let mainContent = main.response.content;
  if (options.tools) {
    const loop = await runToolLoop(
      (request) => invokeOnce(request).then((result) => result.response),
      buildIssueAnalysisMessages(
        context,
        options.promptVersion,
        options.promptMode,
        options.sections,
      ),
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
      analysis: applyResultSections(validation.analysis, options.sections),
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
      options.promptVersion,
      options.promptMode,
      options.sections,
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
      analysis: applyResultSections(repaired.analysis, options.sections),
      usage,
      candidate: repair.candidate,
      attempts,
      durationMs: now() - startedAt,
    };
  }

  return { outcome: "invalid", usage, attempts, durationMs: now() - startedAt };
}
