import { describe, expect, it } from "vitest";
import type { LeasedTask } from "../../../packages/domain/src/index.js";
import { GitHubApiError } from "../../../packages/github-adapter/src/index.js";
import type {
  PrReviewContext,
  PrReviewOutcome,
} from "../../../packages/pr-review/src/index.js";
import type { PrReviewContract } from "../../../packages/pr-review/src/types.js";
import {
  createPrReviewHandler,
  type PrReviewServices,
} from "./pr-review-handler.js";

const review: PrReviewContract = {
  contractVersion: "pr-review/v1",
  summary: "no issues",
  changedFileCount: 1,
  additions: 2,
  deletions: 1,
  overallTone: "approve",
  findings: [],
};

const validOutcome: PrReviewOutcome = {
  outcome: "valid",
  review,
  usage: { inputTokens: 10, outputTokens: 5 },
  candidate: {
    provider: "provider-a",
    model: "model-a",
    accountName: "account-a",
  },
  attempts: [],
  durationMs: 12,
};

function leasedTask(overrides: Partial<LeasedTask> = {}): LeasedTask {
  return {
    id: "task-1",
    taskType: "pr_review",
    status: "leased",
    dedupeKey: "pr-review:repo:9:rev:v1",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date("2026-08-18T00:01:00Z"),
    heartbeatAt: new Date("2026-08-18T00:00:00Z"),
    attemptNumber: 1,
    payload: {
      installationId: "42",
      repositoryFullName: "owner/repo",
      subjectNumber: 9,
      subjectRevision: "rev-1",
    },
    ...overrides,
  };
}

function context(): PrReviewContext {
  return {
    repository: { owner: "owner", name: "repo" },
    pullRequest: {
      number: 9,
      title: "Title",
      body: "",
      state: "open",
      headSha: "rev-1",
      headRef: "feature/x",
      changedFiles: 1,
      additions: 2,
      deletions: 1,
    },
    rendered: {
      diff: { files: [], additions: 0, deletions: 0 },
      keptFiles: [],
      listedFiles: [],
      degraded: [],
    },
    degraded: [],
  };
}

function makeServices(overrides: Partial<PrReviewServices> = {}): {
  services: PrReviewServices;
  calls: () => string[];
} {
  const calls: string[] = [];
  const base: PrReviewServices = {
    buildContext: async () => {
      calls.push("buildContext");
      return context();
    },
    review: async () => {
      calls.push("review");
      return validOutcome;
    },
    publishFinal: async () => {
      calls.push("publishFinal");
    },
    recordUsage: async () => {
      calls.push("recordUsage");
    },
  };
  return { services: { ...base, ...overrides }, calls: () => calls };
}

const neverAbort = new AbortController().signal;

describe("PR review handler", () => {
  it("runs the full vertical flow and completes", async () => {
    const { services, calls } = makeServices();
    const handler = createPrReviewHandler(services);
    const result = await handler(leasedTask(), neverAbort);
    expect(result).toEqual({ outcome: "completed" });
    expect(calls()).toEqual(["buildContext", "review", "recordUsage", "publishFinal"]);
  });

  it("fails with invalid_output and skips publish on invalid review", async () => {
    const { services, calls } = makeServices({
      review: async () => ({
        outcome: "invalid" as const,
        usage: { inputTokens: 20, outputTokens: 10 },
        attempts: [],
        durationMs: 30,
      }),
    });
    const handler = createPrReviewHandler(services);
    const result = await handler(leasedTask(), neverAbort);
    expect(result).toEqual({ outcome: "failed", errorCategory: "invalid_output" });
    expect(calls()).not.toContain("publishFinal");
    expect(calls()).toContain("recordUsage");
  });

  it("fails unsupported task types without touching services", async () => {
    const { services, calls } = makeServices();
    const handler = createPrReviewHandler(services);
    const result = await handler(
      leasedTask({ taskType: "issue_analysis" }),
      neverAbort,
    );
    expect(result).toEqual({
      outcome: "failed",
      errorCategory: "unsupported_task_type",
    });
    expect(calls()).toEqual([]);
  });

  it("marks a missing PR as a permanent failure", async () => {
    const { services } = makeServices({
      buildContext: async () => {
        throw new GitHubApiError("not_found", "pr gone", 404);
      },
    });
    const handler = createPrReviewHandler(services);
    const result = await handler(leasedTask(), neverAbort);
    expect(result).toEqual({ outcome: "failed", errorCategory: "github_not_found" });
  });

  it("lets retryable errors propagate so the engine retries", async () => {
    const { services } = makeServices({
      review: async () => {
        throw new Error("provider down");
      },
    });
    const handler = createPrReviewHandler(services);
    await expect(handler(leasedTask(), neverAbort)).rejects.toThrow("provider down");
  });
});