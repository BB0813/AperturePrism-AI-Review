import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../../packages/github-adapter/src/index.js";
import { buildPrContext } from "./context-build.js";

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
-import { x } from "./legacy";
+import { x } from "./modern";
+export const y = 1;
`;

function makeGithub(): GitHubClient {
  const github: GitHubClient = {
    getInstallationToken: async () => ({
      token: "t",
      expiresAt: new Date().toISOString(),
    }),
    getIssue: async () => {
      throw new Error("unused");
    },
    listIssueComments: async () => [],
    createIssueComment: async () => ({ id: 1, htmlUrl: "" }),
    updateIssueComment: async () => ({ id: 1, htmlUrl: "" }),
    createPullRequestReview: async () => ({ id: 1 }),
    getPullRequest: async () => ({
      number: 9,
      title: "modernize imports",
      body: "migrate to the newer helper",
      state: "open",
      headSha: "abc123",
      headRef: "feature/x",
      changedFiles: 1,
      additions: 2,
      deletions: 1,
    }),
    getPullRequestDiff: async () => diff,
  };
  return github;
}

describe("buildPrContext", () => {
  it("fetches PR metadata and parses the diff into a reviewable context", async () => {
    const github = makeGithub();
    const context = await buildPrContext(github, {
      installationId: "i",
      owner: "o",
      name: "r",
      pullNumber: 9,
    });
    expect(context.pullRequest.headSha).toBe("abc123");
    expect(context.rendered.diff.files).toHaveLength(1);
    expect(context.rendered.diff.additions).toBe(2);
    expect(context.rendered.diff.deletions).toBe(1);
  });
});