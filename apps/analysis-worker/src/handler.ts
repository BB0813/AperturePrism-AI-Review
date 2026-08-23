import type { GradedIssueAnalysis } from "../../../packages/contracts/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import type { RelatedIssueRow } from "../../../packages/duplicate-detection/src/index.js";
import { GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import type {
  IssueAnalysisOutcome,
  IssueContext,
} from "../../../packages/issue-analysis/src/index.js";
import type { TaskHandler } from "./loop.js";

export type SpamVerdict = {
  isSpam: boolean;
  reason: string;
  confidence: number;
};

/**
 * Everything the analysis flow needs, injected by main so this module stays a
 * pure orchestration layer that is easy to test without GitHub or a database.
 */
export type IssueAnalysisServices = {
  buildContext: (
    task: LeasedTask,
    signal: AbortSignal,
  ) => Promise<IssueContext>;
  publishPlaceholder: (task: LeasedTask, signal: AbortSignal) => Promise<void>;
  /**
   * 分析失败时把占位评论改写为可诊断的说明。缺少它的话，占位会永远停在
   * 「正在分析」，用户看到的是一条误导性评论（NAS 上实测出现过）。
   */
  publishFailure?: (
    task: LeasedTask,
    errorCategory: string,
    signal: AbortSignal,
  ) => Promise<void>;
  analyze: (
    context: IssueContext,
    signal: AbortSignal,
  ) => Promise<IssueAnalysisOutcome>;
  /** Read-only RAG recall; index failure degrades to an empty list. */
  recallRelated: (context: IssueContext) => Promise<RelatedIssueRow[]>;
  publishFinal: (
    task: LeasedTask,
    analysis: GradedIssueAnalysis,
    related: readonly RelatedIssueRow[],
    signal: AbortSignal,
  ) => Promise<void>;
  recordUsage: (
    task: LeasedTask,
    outcome: IssueAnalysisOutcome,
  ) => Promise<void>;
  /**
   * Optional: persists a distilled memory reflection after the final publish.
   * Best-effort — injected implementations swallow failures; the handler only
   * guards so a memory failure can never fail the completed task.
   */
  recordMemory?: (
    task: LeasedTask,
    analysis: GradedIssueAnalysis,
  ) => Promise<void>;
  /**
   * Optional: ad/spam detection run after building the context, before any
   * normal analysis. Returning a non-null verdict with isSpam=true short-
   * circuits the flow: handleSpam runs (best-effort) and the task completes
   * without publishing an analysis. A throw or a null result continues the
   * normal analysis.
   */
  detectSpam?: (
    task: LeasedTask,
    signal: AbortSignal,
  ) => Promise<SpamVerdict | null>;
  /**
   * Optional: acts on a confirmed spam verdict (close/delete per config).
   * Best-effort — the handler swallows failures so spam handling can never
   * fail the task.
   */
  handleSpam?: (
    task: LeasedTask,
    verdict: SpamVerdict,
    signal: AbortSignal,
  ) => Promise<void>;
};

/**
 * The vertical issue-analysis flow: context -> placeholder -> analyze ->
 * record usage -> recall related issues (RAG, degrade-safe) -> publish final
 * analysis. Invalid contract output fails with a retryable category;
 * permanent GitHub problems (missing object, auth) are marked so the engine
 * does not retry them forever.
 */
export function createIssueAnalysisHandler(
  services: IssueAnalysisServices,
): TaskHandler {
  return async (task, signal) => {
    try {
      if (task.taskType !== "issue_analysis")
        return { outcome: "failed", errorCategory: "unsupported_task_type" };

      const context = await services.buildContext(task, signal);

      // Ad/spam detection runs before any normal analysis. A confirmed spam
      // verdict short-circuits the flow; failures or a null result degrade to
      // the regular analysis path.
      if (services.detectSpam) {
        try {
          const verdict = await services.detectSpam(task, signal);
          if (verdict && verdict.isSpam) {
            try {
              await services.handleSpam?.(task, verdict, signal);
            } catch {
              // Spam handling is best-effort; never fails the completed task.
            }
            return { outcome: "completed" };
          }
        } catch {
          // Detection failure degrades to the normal analysis flow.
        }
      }

      await services.publishPlaceholder(task, signal);

      const outcome = await services.analyze(context, signal);
      await services.recordUsage(task, outcome);

      if (outcome.outcome === "invalid") {
        // 占位评论已经发出：不改写的话它会永远停在「正在分析」。
        await publishFailureSafely(services, task, "invalid_output", signal);
        return { outcome: "failed", errorCategory: "invalid_output" };
      }

      let related: RelatedIssueRow[] = [];
      try {
        related = await services.recallRelated(context);
      } catch {
        // The index is an enhancement, never a blocker for the core analysis.
        related = [];
      }

      await services.publishFinal(task, outcome.analysis, related, signal);
      try {
        await services.recordMemory?.(task, outcome.analysis);
      } catch {
        // Memory recording is best-effort; never blocks or fails the task.
      }
      return { outcome: "completed" };
    } catch (error) {
      if (error instanceof GitHubApiError) {
        if (error.category === "not_found")
          return { outcome: "failed", errorCategory: "github_not_found" };
        if (error.category === "authentication_failed")
          return { outcome: "failed", errorCategory: "github_auth_failed" };
      }
      // 模型不可用等异常同样要收尾占位评论，否则它会一直停在「正在分析」。
      await publishFailureSafely(services, task, "handler_error", signal);
      throw error;
    }
  };
}

/** 占位收尾是 best-effort：它自身失败不应改变任务的失败原因。 */
async function publishFailureSafely(
  services: IssueAnalysisServices,
  task: LeasedTask,
  errorCategory: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await services.publishFailure?.(task, errorCategory, signal);
  } catch {
    // 忽略：真正的失败原因已由 task_events 记录。
  }
}
