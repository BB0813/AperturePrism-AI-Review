import type {
  GitHubClient,
  GitHubPullRequest,
} from "../../../packages/github-adapter/src/index.js";
import {
  DEFAULT_PR_REVIEW_BUDGET,
  renderDiffForModel,
  type PrReviewBudget,
  type RenderedPrContext,
} from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import type { ToolExecutionContext } from "./tools.js";

export type PrContextInput = {
  installationId: string;
  owner: string;
  name: string;
  pullNumber: number;
};

export type PrReviewContext = {
  repository: { owner: string; name: string };
  pullRequest: GitHubPullRequest;
  rendered: RenderedPrContext;
  /** Whether the diff itself could not be parsed (e.g. empty or oversized). */
  degraded: readonly string[];
  /** Consolidated repo memory (rules/knowledge), rendered as reference text. */
  repoMemory?: string;
  /** 可选：AI 主动探索工具的仓库只读上下文（由 worker 注入）。 */
  toolsContext?: ToolExecutionContext;
};

/**
 * Fetches the pull request metadata and diff, parses the unified diff into a
 * file/hunk model, and runs it through the token-budget degradation so the
 * model only ever sees a documented, reviewable subset. A failure to fetch the
 * diff surfaces as a GitHub error; an unparseable/empty diff yields an empty
 * reviewable context rather than a hard failure.
 */
export async function buildPrContext(
  github: GitHubClient,
  input: PrContextInput,
  budget: PrReviewBudget = DEFAULT_PR_REVIEW_BUDGET,
  signal?: AbortSignal,
): Promise<PrReviewContext> {
  const [pullRequest, diffText] = await Promise.all([
    github.getPullRequest(
      {
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        number: input.pullNumber,
      },
      signal,
    ),
    github.getPullRequestDiff(
      {
        installationId: input.installationId,
        owner: input.owner,
        name: input.name,
        number: input.pullNumber,
      },
      signal,
    ),
  ]);

  const parsed = parseUnifiedDiff(diffText);
  const rendered = renderDiffForModel(parsed, budget);
  return {
    repository: { owner: input.owner, name: input.name },
    pullRequest,
    rendered,
    degraded: rendered.degraded,
  };
}