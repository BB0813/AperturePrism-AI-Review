import type { PrReviewContract } from "./types.js";

/**
 * The persisted bookkeeping a publication needs. The worker supplies a
 * Drizzle-backed implementation so this module never imports Drizzle tables.
 */
export type ReviewPublicationStore = {
  findExternalObjectId: (idempotencyKey: string) => Promise<string | null>;
  insert: (input: {
    taskId: string;
    idempotencyKey: string;
    externalObjectId: string;
    channel: string;
  }) => Promise<void>;
  touch: (idempotencyKey: string) => Promise<void>;
};

/**
 * The small GitHub surface PR-review publishing needs. Kept separate from the
 * generic GitHubClient because a PR review is a different resource than an
 * issue comment and the caller supplies the parsed data + review body it owns.
 */
export type GitHubReviewClient = {
  publishReview: (input: {
    installationId: string;
    owner: string;
    name: string;
    pullNumber: number;
    /** `revision` is the PR head SHA; publishing is tied to it for idempotency. */
    revision: string;
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  }) => Promise<{ id: number }>;
};

export type PublishReviewInput = {
  store: ReviewPublicationStore;
  github: GitHubReviewClient;
  taskId: string;
  installationId: string;
  owner: string;
  name: string;
  pullNumber: number;
  revision: string;
  review: PrReviewContract;
};

export type PublishReviewResult = {
  reviewId: number;
  created: boolean;
};

export function reviewEventTone(
  tone: PrReviewContract["overallTone"],
): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  if (tone === "approve") return "APPROVE";
  if (tone === "changes_requested") return "REQUEST_CHANGES";
  return "COMMENT";
}

export function renderReviewBody(review: PrReviewContract): string {
  const lines: string[] = [`## 审查总结`, review.summary, ""];
  if (review.findings.length > 0) {
    lines.push(`### Findings (${review.findings.length})`);
    for (const finding of review.findings) {
      lines.push(
        `- **${finding.severity.toUpperCase()}** \`${finding.rule}\` ${finding.file}${finding.afterLine > 0 ? `:${finding.afterLine}` : ""}`,
      );
      lines.push(`  - ${finding.message}`);
      lines.push(`  - 建议: ${finding.suggestion}`);
    }
  }
  return lines.join("\n");
}

/**
 * Publishes a PR review tied to a head SHA. Because a GitHub review is
 * immutable, a retried or re-run task on the same head SHA must not create a
 * second review — `external_object_id` is persisted so the first call wins and
 * later calls only touch the bookkeeping. A new head SHA gets a fresh
 * idempotency key, which is how "new head SHA task creation" is kept idempotent.
 */
export async function publishAssessment(
  input: PublishReviewInput,
): Promise<PublishReviewResult> {
  const idempotencyKey = `pr-review:${input.owner}/${input.name}#${input.pullNumber}:${input.revision}`;
  const externalObjectId = await input.store.findExternalObjectId(
    idempotencyKey,
  );
  if (externalObjectId !== null) {
    await input.store.touch(idempotencyKey);
    return { reviewId: Number(externalObjectId), created: false };
  }
  const published = await input.github.publishReview({
    installationId: input.installationId,
    owner: input.owner,
    name: input.name,
    pullNumber: input.pullNumber,
    revision: input.revision,
    body: renderReviewBody(input.review),
    event: reviewEventTone(input.review.overallTone),
  });
  await input.store.insert({
    taskId: input.taskId,
    idempotencyKey,
    externalObjectId: String(published.id),
    channel: "github_pull_request_review",
  });
  return { reviewId: published.id, created: true };
}