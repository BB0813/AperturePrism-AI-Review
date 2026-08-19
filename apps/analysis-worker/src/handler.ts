import type { GradedIssueAnalysis } from "../../../packages/contracts/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import type { RelatedIssueRow } from "../../../packages/duplicate-detection/src/index.js";
import { GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import type {
  IssueAnalysisOutcome,
  IssueContext,
} from "../../../packages/issue-analysis/src/index.js";
import type { TaskHandler } from "./loop.js";

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
      await services.publishPlaceholder(task, signal);

      const outcome = await services.analyze(context, signal);
      await services.recordUsage(task, outcome);

      if (outcome.outcome === "invalid")
        return { outcome: "failed", errorCategory: "invalid_output" };

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
      throw error;
    }
  };
}
