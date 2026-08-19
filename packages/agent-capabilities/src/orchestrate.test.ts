import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelCandidate,
  type ModelProviderAdapter,
} from "../../../packages/domain/src/index.js";
import {
  runExpertReview,
  type ExpertReviewDeps,
  type ExpertReviewInput,
} from "./orchestrate.js";
import { selectSkills } from "./skills.js";

const candidate: ModelCandidate = {
  provider: "provider-a",
  model: "model-a",
  accountName: "account-a",
};

function expertJson(seed: string): string {
  return JSON.stringify({
    summary: `专家结论 ${seed}`,
    findings: [
      {
        file: "src/a.ts",
        line: 3,
        severity: "warning",
        message: `发现 ${seed}`,
        why: `原因 ${seed}`,
        evidence: "+ const x = user.name;",
      },
    ],
  });
}

const validPrJson = JSON.stringify({
  contractVersion: "pr-review/v1",
  summary: "合并后的最终总结",
  changedFileCount: 1,
  additions: 10,
  deletions: 2,
  overallTone: "changes_requested",
  findings: [
    {
      rule: "missing-null-check",
      severity: "high",
      file: "src/a.ts",
      message: "缺少空值检查",
      evidence: "const x = user.name",
      impact: "可能引发空指针",
      confidence: 0.8,
      suggestion: "补充判空逻辑",
      afterLine: 3,
    },
  ],
});

/**
 * Content-aware fake adapter: picks the response based on which phase the
 * request belongs to (expert vs lead, main vs repair), so tests stay
 * deterministic even though the four experts run in parallel.
 */
function adaptiveAdapter(options: {
  provider?: string;
  expertMain?: (system: string) => string;
  expertRepair?: string;
  leadMain?: string;
  leadRepair?: string;
  failExpertIf?: (system: string) => boolean;
}): ModelProviderAdapter & { calls: () => number } {
  let count = 0;
  const adapter: ModelProviderAdapter = {
    provider: options.provider ?? "provider-a",
    invoke: async (_candidate, request) => {
      const system = request.messages[0]?.content ?? "";
      const user = request.messages.at(-1)?.content ?? "";
      const isLead = system.includes("主编");
      const isRepair = user.includes("修正");
      if (!isLead && options.failExpertIf?.(system)) {
        throw new ModelInvocationError("server_error", "expert adapter failed");
      }
      let content: string;
      if (isLead) {
        content = isRepair
          ? (options.leadRepair ?? options.leadMain ?? "")
          : (options.leadMain ?? "");
      } else {
        content = isRepair
          ? (options.expertRepair ?? "")
          : options.expertMain?.(system) ?? "";
      }
      count += 1;
      return { content, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { ...adapter, calls: () => count };
}

function deps(adapter: ModelProviderAdapter): ExpertReviewDeps {
  return {
    adapters: new Map([[adapter.provider, adapter]]),
    candidates: [candidate],
    deadlineMs: 10_000,
    retryPolicy: { maxAttemptsPerCandidate: 1, baseDelayMs: 10, maxDelayMs: 100 },
    now: () => 0,
    sleep: async () => undefined,
  };
}

const input: ExpertReviewInput = {
  appliesTo: "pr",
  rendered:
    "变更文件数: 1\n新增行: 10，删除行: 2\n### src/a.ts\n```\n+const x = user.name;\n+const sql = `SELECT * FROM users WHERE id=${id}`;\n```",
  skills: selectSkills("pr", "password sql readme token"),
};

describe("runExpertReview", () => {
  it("runs all experts and merges their conclusions into a valid review", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(4);
    expect(outcome.review.overallTone).toBe("changes_requested");
    expect(outcome.review.findings[0]?.rule).toBe("missing-null-check");
    expect(outcome.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    expect(outcome.attempts).toHaveLength(5);
    expect(adapter.calls()).toBe(5);
  });

  it("repairs an expert's invalid output before merging", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => "not valid json",
      expertRepair: expertJson("repaired"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    // 4 experts x (main + repair) + 1 lead
    expect(outcome.experts).toBe(4);
    expect(outcome.usage).toEqual({ inputTokens: 90, outputTokens: 45 });
    expect(outcome.attempts).toHaveLength(9);
    expect(adapter.calls()).toBe(9);
  });

  it("degrades when one expert fails and only merges the successful ones", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      failExpertIf: (system) => system.includes("文档与可读性专家"),
      leadMain: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(3);
    expect(outcome.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
    expect(outcome.attempts).toHaveLength(5);
  });

  it("repairs an invalid lead output before accepting the review", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: "not valid json",
      leadRepair: validPrJson,
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("valid");
    if (outcome.outcome !== "valid") return;
    expect(outcome.experts).toBe(4);
    expect(adapter.calls()).toBe(6);
  });

  it("reports invalid when the lead is still unparseable after repair", async () => {
    const adapter = adaptiveAdapter({
      expertMain: () => expertJson("ok"),
      leadMain: "not valid json",
      leadRepair: JSON.stringify({ contractVersion: "wrong" }),
    });
    const outcome = await runExpertReview(deps(adapter), input);

    expect(outcome.outcome).toBe("invalid");
  });
});
