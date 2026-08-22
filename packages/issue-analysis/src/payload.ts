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
