import { describe, expect, it } from "vitest";
import type {
  ModelCandidate,
  ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import type { IssueContext } from "./context.js";
import { analyzeIssue, type IssueAnalyzerOptions } from "./analyze.js";

const candidate: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};

const fallback: ModelCandidate = {
  provider: "provider-b",
  model: "model-b",
  accountName: "account-b",
};

const validIssueJson = JSON.stringify({
  contractVersion: "issue-analysis/v1",
  category: "bug",
  summary: "The app crashes on startup when the config file is missing.",
  severity: "S0",
  priority: "P0",
  quality: "complete",
  evidence: [
    {
      kind: "reproduction_steps",
      excerpt: "1. rm config. 2. start. 3. crash.",
    },
  ],
  missingInformation: [],
  suggestedLabels: ["bug"],
  suggestedActions: ["Reproduce on a clean checkout."],
  confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
});

const context: IssueContext = {
  repository: { owner: "o", name: "r" },
  installationId: "42",
  issue: {
    number: 7,
    title: "Crash",
    body: "Crash on startup.",
    state: "open",
    htmlUrl: "https://github.test/o/r/issues/7",
    author: "alice",
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T01:00:00Z",
    labels: [],
  },
  comments: [],
  degraded: [],
  estimatedTokens: 10,
};

function scriptedAdapter(provider: string, contents: readonly string[]) {
  let calls = 0;
  const adapter: ModelProviderAdapter = {
    provider,
    invoke: async () => {
      const content = contents[Math.min(calls, contents.length - 1)] ?? "";
      calls += 1;
      return { content, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { adapter, calls: () => calls };
}

function options(
  adapters: ModelProviderAdapter[],
  candidates: readonly ModelCandidate[],
): IssueAnalyzerOptions {
  return {
    adapters: new Map(adapters.map((entry) => [entry.provider, entry])),
    candidates,
    deadlineMs: 10_000,
    retryPolicy: {
      maxAttemptsPerCandidate: 1,
      baseDelayMs: 10,
      maxDelayMs: 100,
    },
    now: () => 0,
    sleep: async () => undefined,
  };
}

describe("issue analysis orchestration", () => {
  it("returns a graded analysis for valid model output", async () => {
    const { adapter } = scriptedAdapter("provider-a", [validIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.category).toBe("bug");
    expect(outcome.analysis.result.severity).toBe("S0");
    expect(outcome.analysis.result.priority).toBe("P0");
    expect(outcome.analysis.adjustments).toEqual([]);
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(outcome.durationMs).toBe(0);
  });

  it("downgrades high grades without substantive evidence via the server rules", async () => {
    const unsubstantiated = JSON.stringify({
      contractVersion: "issue-analysis/v1",
      category: "bug",
      summary: "Something breaks.",
      severity: "S0",
      priority: "P0",
      quality: "complete",
      evidence: [{ kind: "impact_scope", excerpt: "All users are affected." }],
      missingInformation: [],
      suggestedLabels: [],
      suggestedActions: [],
      confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
    });
    const { adapter } = scriptedAdapter("provider-a", [unsubstantiated]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.severity).toBe("unknown");
    expect(outcome.analysis.result.priority).toBe("needs_triage");
    expect(outcome.analysis.adjustments.length).toBeGreaterThan(0);
  });

  it("performs one bounded repair and accepts the corrected output", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      validIssueJson,
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.category).toBe("bug");
    expect(outcome.attempts).toHaveLength(2);
    // Both the failed main call and the successful repair consumed tokens.
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("reports invalid when the repair also fails, without publishing a decision", async () => {
    const { adapter, calls } = scriptedAdapter("provider-a", [
      "not valid json",
      JSON.stringify({ contractVersion: "wrong" }),
    ]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );

    expect(calls()).toBe(2);
    expect(outcome.outcome).toBe("invalid");
  });

  it("falls over to another candidate when the primary provider is missing", async () => {
    const { adapter } = scriptedAdapter("provider-b", [validIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate, fallback]),
      context,
    );

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.candidate).toEqual(fallback);
  });
});

describe("结果区块后置过滤", () => {
  const richIssueJson = JSON.stringify({
    contractVersion: "issue-analysis/v1",
    category: "bug",
    summary: "crash",
    severity: "S0",
    priority: "P0",
    quality: "complete",
    suggestedTitle: "Crash on startup",
    probableCause: "missing config",
    troubleshooting: ["create a default config file"],
    proposedChanges: [{ path: "src/main.ts", change: "add default config" }],
    evidence: [{ kind: "reproduction_steps", excerpt: "rm config; start" }],
    missingInformation: ["OS version", "runtime version"],
    suggestedLabels: ["bug"],
    suggestedActions: ["reproduce on a clean checkout"],
    confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
  });

  it("缺省不传 sections 时保留全部字段", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    const outcome = await analyzeIssue(
      options([adapter], [candidate]),
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.missingInformation).toEqual([
      "OS version",
      "runtime version",
    ]);
    expect(outcome.analysis.result.suggestedActions).toEqual([
      "reproduce on a clean checkout",
    ]);
  });

  it("关闭的区块在校验后被强制清空，其余区块保留", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    // 模拟默认设置：关闭 missing_information 与 suggested_actions。
    const sections = new Set([
      "summary",
      "suggested_title",
      "probable_cause",
      "troubleshooting",
      "evidence",
      "suggested_labels",
      "proposed_changes",
    ]);
    const outcome = await analyzeIssue(
      { ...options([adapter], [candidate]), sections },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.missingInformation).toEqual([]);
    expect(outcome.analysis.result.suggestedActions).toEqual([]);
    // 保留的区块不受影响。
    expect(outcome.analysis.result.probableCause).toBe("missing config");
    expect(outcome.analysis.result.proposedChanges).toEqual([
      { path: "src/main.ts", change: "add default config" },
    ]);
    expect(outcome.analysis.result.evidence).toHaveLength(1);
    expect(outcome.analysis.result.summary).toBe("crash");
  });

  it("关闭建议标题 / 可能原因等可选字段时整个字段被移除", async () => {
    const { adapter } = scriptedAdapter("provider-a", [richIssueJson]);
    const sections = new Set([
      "summary",
      "troubleshooting",
      "evidence",
      "missing_information",
      "suggested_labels",
      "proposed_changes",
      "suggested_actions",
    ]);
    const outcome = await analyzeIssue(
      { ...options([adapter], [candidate]), sections },
      context,
    );
    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.analysis.result.suggestedTitle).toBeUndefined();
    expect(outcome.analysis.result.probableCause).toBeUndefined();
  });
});
