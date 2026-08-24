export type IssueTaskPayload = {
  installationId: string;
  repositoryFullName: string;
  subjectNumber: number;
  subjectRevision: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Extracts the fields the analysis flow needs from a task payload. Returns
 * null when identity is missing so the caller can fail the task honestly
 * instead of guessing.
 */
export function parseIssueTaskPayload(
  payload: unknown,
): IssueTaskPayload | null {
  const root = objectValue(payload);
  const installationId = root.installationId;
  const repositoryFullName = root.repositoryFullName;
  const subjectNumber = root.subjectNumber;
  const subjectRevision = root.subjectRevision;
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    typeof repositoryFullName !== "string" ||
    repositoryFullName.length === 0 ||
    typeof subjectNumber !== "number" ||
    !Number.isInteger(subjectNumber) ||
    typeof subjectRevision !== "string" ||
    subjectRevision.length === 0
  ) {
    return null;
  }
  return { installationId, repositoryFullName, subjectNumber, subjectRevision };
}

/**
 * True when the task came from a webhook `issues.edited` — the only path where
 * a prior analysis may already exist and the change may be trivial.
 *
 * 手动触发、评论指令、仓库扫描、opened / reopened 都返回 false：那些要么没有
 * 旧结论，要么是用户明确要求重跑，按变化幅度跳过它们才是错的。老任务的 payload
 * 里没有 `sourceAction`，同样返回 false —— 宁可多分析一次。
 */
export function isIssueEditEvent(payload: unknown): boolean {
  const root = objectValue(payload);
  return root.sourceEvent === "issues" && root.sourceAction === "edited";
}

export function repositoryOwnerName(fullName: string): {
  owner: string;
  name: string;
} | null {
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1) return null;
  return {
    owner: fullName.slice(0, separator),
    name: fullName.slice(separator + 1),
  };
}

/**
 * Identifies the single analysis comment for an issue, so every task for that
 * issue updates one comment in place instead of appending a new one.
 *
 * Deliberately excludes the subject revision: the revision is the issue's
 * `updated_at`, so keying on it made each edit publish an extra comment (#2
 * accumulated five). Stable across retries for the same reason.
 */
export function issueCommentIdempotencyKey(
  repositoryFullName: string,
  issueNumber: number,
): string {
  return `github-issue-comment:${repositoryFullName}:${issueNumber}`;
}
