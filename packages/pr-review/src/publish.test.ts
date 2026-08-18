import { describe, expect, it } from "vitest";
import {
  publishAssessment,
  renderReviewBody,
  reviewEventTone,
  type GitHubReviewClient,
  type ReviewPublicationStore,
} from "./publish.js";
import type { PrReviewContract } from "./types.js";

const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "looks fine",
  changedFileCount: 1,
  additions: 2,
  deletions: 0,
  overallTone: "changes_requested",
  findings: [],
};

function store(): ReviewPublicationStore & { touches: () => number } {
  const versions = new Map<string, string>();
  let touches = 0;
  return {
    touches: () => touches,
    findExternalObjectId: async (key) => versions.get(key) ?? null,
    insert: async (input) => {
      versions.set(input.idempotencyKey, input.externalObjectId);
    },
    touch: async () => {
      touches += 1;
    },
  };
}

const github: GitHubReviewClient = {
  publishReview: async ({ revision }) => ({ id: revision.length }),
};

describe("publishAssessment", () => {
  it("creates once per head SHA and reuses the idempotency record", async () => {
    const s = store();
    const first = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "abc123",
      review,
    });
    expect(first.created).toBe(true);

    const second = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "abc123",
      review,
    });
    expect(second.created).toBe(false);
    expect(second.reviewId).toBe(first.reviewId);
  });

  it("publishes a new review for a new head SHA", async () => {
    const s = store();
    await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "hash1",
      review,
    });
    const second = await publishAssessment({
      store: s,
      github,
      taskId: "t",
      installationId: "42",
      owner: "o",
      name: "r",
      pullNumber: 9,
      revision: "hash2",
      review,
    });
    expect(second.created).toBe(true);
  });
});

describe("review rendering", () => {
  it("maps overall tone to a review event", () => {
    expect(reviewEventTone("approve")).toBe("APPROVE");
    expect(reviewEventTone("changes_requested")).toBe("REQUEST_CHANGES");
    expect(reviewEventTone("comment")).toBe("COMMENT");
  });

  it("renders a human-readable review body", () => {
    const body = renderReviewBody({ ...review, overallTone: "approve" });
    expect(body).toContain("looks fine");
  });
});