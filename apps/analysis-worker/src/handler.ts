import type { GradedIssueAnalysis } from "../../../packages/contracts/src/index.js";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
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
  publishFinal: (
    task: LeasedTask,
    analysis: GradedIssueAnalysis,
    signal: AbortSignal,
  ) => Promise<void>;
  recordUsage: (
    task: LeasedTask,
    outcome: IssueAnalysisOutcome,
  ) => Promise<void>;
};

/**
 * The vertical issue-analysis flow: context -> placeholder -> analyze ->
 * record usage -> publish final analysis. Invalid contract output fails with
 * a retryable category; permanent GitHub problems (missing object, auth) are
 * marked so the engine does not retry them forever.
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

      await services.publishFinal(task, outcome.analysis, signal);
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
