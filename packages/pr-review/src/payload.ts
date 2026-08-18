export type PrReviewTaskPayload = {
  installationId: string;
  repositoryExternalId: string | null;
  repositoryFullName: string;
  subjectNumber: number;
  subjectRevision: string;
  sourceEvent: string;
  sourceRevision: string;
};

export function parsePrReviewTaskPayload(payload: unknown): PrReviewTaskPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.installationId !== "string" ||
    typeof value.repositoryFullName !== "string" ||
    typeof value.subjectNumber !== "number" ||
    typeof value.subjectRevision !== "string"
  )
    return null;
  return {
    installationId: value.installationId,
    repositoryExternalId:
      typeof value.repositoryExternalId === "string"
        ? value.repositoryExternalId
        : null,
    repositoryFullName: value.repositoryFullName,
    subjectNumber: value.subjectNumber,
    subjectRevision: value.subjectRevision,
    sourceEvent:
      typeof value.sourceEvent === "string" ? value.sourceEvent : "pr_review",
    sourceRevision:
      typeof value.sourceRevision === "string" ? value.sourceRevision : "",
  };
}

export type RepositoryIdentity = { owner: string; name: string };

/** Parses `owner/name` from a full repository name; null when malformed. */
export function repositoryOwnerName(
  fullName: string,
): RepositoryIdentity | null {
  const index = fullName.indexOf("/");
  if (index <= 0 || index === fullName.length - 1) return null;
  return { owner: fullName.slice(0, index), name: fullName.slice(index + 1) };
}

/** Stable idempotency key tied to the head SHA, so a retry never re-publishes. */
export function prReviewIdempotencyKey(
  repositoryFullName: string,
  pullNumber: number,
  headSha: string,
): string {
  return `pr-review:${repositoryFullName}#${pullNumber}:${headSha}`;
}