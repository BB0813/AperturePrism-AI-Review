import { describe, expect, it } from "vitest";
import { issueCommentIdempotencyKey } from "./payload.js";

describe("issueCommentIdempotencyKey", () => {
  it("stays stable when the issue revision changes", () => {
    // The revision is the issue's updated_at, which changes on every edit and
    // on every comment we post. Keying on it published a new comment each time
    // instead of updating the existing one (#2 accumulated five comments).
    const first = issueCommentIdempotencyKey("owner/repo", 7);
    const second = issueCommentIdempotencyKey("owner/repo", 7);
    expect(first).toBe(second);
    expect(first).toBe("github-issue-comment:owner/repo:7");
  });

  it("separates issues and repositories", () => {
    expect(issueCommentIdempotencyKey("owner/repo", 7)).not.toBe(
      issueCommentIdempotencyKey("owner/repo", 8),
    );
    expect(issueCommentIdempotencyKey("owner/repo", 7)).not.toBe(
      issueCommentIdempotencyKey("other/repo", 7),
    );
  });
});
