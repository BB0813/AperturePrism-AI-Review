import type {
  GitHubClient,
  GitHubIssue,
} from "../../../packages/github-adapter/src/index.js";

export type IssueContextInput = {
  installationId: string;
  owner: string;
  name: string;
  number: number;
};

export type IssueCommentDocument = {
  author: string | null;
  body: string;
  createdAt: string;
};

export type IssueDocument = GitHubIssue;

export type IssueContext = {
  repository: { owner: string; name: string };
  issue: IssueDocument;
  comments: readonly IssueCommentDocument[];
  /** Why the context was reduced below the full source, for the prompt. */
  degraded: readonly string[];
  /** Estimated input tokens consumed by the rendered issue context. */
  estimatedTokens: number;
};

export type IssueContextBudget = {
  /** Rough token ceiling for the issue context portion of the prompt. */
  maxTokens: number;
  /** Character ceiling for a single oversized body. */
  maxBodyChars: number;
  /** Newest comments to consider, oldest beyond this are dropped. */
  maxComments: number;
};

export const DEFAULT_CONTEXT_BUDGET: IssueContextBudget = {
  maxTokens: 8_000,
  maxBodyChars: 10_000,
  maxComments: 20,
};

/** A coarse heuristic (~4 chars per token) used only for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateBody(
  body: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (body.length <= maxChars) return { text: body, truncated: false };
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  return {
    text: `${body.slice(0, headChars)}\n\n…[正文过长，已截取开头与结尾]…\n\n${body.slice(-tailChars)}`,
    truncated: true,
  };
}

/**
 * Fetches the issue and its comments and keeps the model-relevant content
 * inside the token budget. Degradation drops lower-value content (comments
 * first) and only then trims the body, preserving both head and tail instead
 * of truncating into an arbitrary, meaningless slice.
 */
export async function buildIssueContext(
  github: GitHubClient,
  input: IssueContextInput,
  budget: IssueContextBudget = DEFAULT_CONTEXT_BUDGET,
  signal?: AbortSignal,
): Promise<IssueContext> {
  const [issue, allComments] = await Promise.all([
    github.getIssue(input, signal),
    github.listIssueComments(input, signal),
  ]);

  const degraded: string[] = [];
  let body = issue.body;
  let comments = allComments.slice(-budget.maxComments);

  const baseTokens = estimateTokens(issue.title) + estimateTokens(body);
  const commentTokens = comments.reduce(
    (sum, comment) => sum + estimateTokens(comment.body),
    0,
  );
  if (baseTokens + commentTokens > budget.maxTokens) {
    degraded.push("comments_dropped");
    comments = [];
  }

  if (estimateTokens(issue.title) + estimateTokens(body) > budget.maxTokens) {
    const trimmed = truncateBody(body, budget.maxBodyChars);
    body = trimmed.text;
    if (trimmed.truncated) degraded.push("issue_body_truncated");
  }

  // Hard safety cap so the rendered context never exceeds the budget.
  const bodyCharBudget = Math.max(
    0,
    budget.maxTokens * 4 - estimateTokens(issue.title) * 4,
  );
  if (body.length > bodyCharBudget) {
    body = `${body.slice(0, bodyCharBudget)}\n\n…[上下文超限，其余内容省略]…`;
    degraded.push("issue_body_capped");
  }

  const estimatedTokens =
    estimateTokens(issue.title) +
    estimateTokens(body) +
    comments.reduce((sum, comment) => sum + estimateTokens(comment.body), 0);

  return {
    repository: { owner: input.owner, name: input.name },
    issue: { ...issue, body },
    comments,
    degraded,
    estimatedTokens,
  };
}
