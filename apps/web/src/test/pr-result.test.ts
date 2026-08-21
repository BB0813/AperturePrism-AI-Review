import { describe, expect, it } from "vitest";
import { parsePrResult } from "../pages/ResultsPage";

const sample = {
  contractVersion: "pr-review/v1",
  summary: "整体实现清晰，但有一处潜在空指针。",
  changedFileCount: 2,
  additions: 40,
  deletions: 10,
  overallTone: "changes_requested",
  findings: [
    {
      rule: "missing-null-check",
      severity: "high",
      file: "src/handler.ts",
      message: "未校验可能为 null 的配置对象",
      evidence: "const cfg = config?.get();",
      impact: "运行期可能抛 TypeError",
      confidence: 0.85,
      suggestion: "在访问前增加空值保护",
      afterLine: 42,
    },
  ],
};

describe("parsePrResult", () => {
  it("parses a full PR review contract", () => {
    const pr = parsePrResult(sample as unknown as Record<string, unknown>);
    expect(pr).not.toBeNull();
    expect(pr!.summary).toBe("整体实现清晰，但有一处潜在空指针。");
    expect(pr!.overallTone).toBe("changes_requested");
    expect(pr!.stats).toEqual({ files: 2, additions: 40, deletions: 10 });
    expect(pr!.findings).toHaveLength(1);
    expect(pr!.findings[0]).toMatchObject({
      rule: "missing-null-check",
      severity: "high",
      file: "src/handler.ts",
      message: "未校验可能为 null 的配置对象",
      afterLine: 42,
    });
  });

  it("handles an approve result with no findings", () => {
    const pr = parsePrResult({
      summary: "看起来没问题",
      overallTone: "approve",
      findings: [],
    } as unknown as Record<string, unknown>);
    expect(pr!.overallTone).toBe("approve");
    expect(pr!.findings).toEqual([]);
    expect(pr!.stats).toBeNull();
  });

  it("tolerates missing fields with defaults", () => {
    const pr = parsePrResult({
      findings: [{ rule: "x", message: "y" }],
    } as unknown as Record<string, unknown>);
    expect(pr!.summary).toBe("");
    expect(pr!.overallTone).toBeNull();
    expect(pr!.findings[0]).toMatchObject({ severity: "info", file: "", afterLine: 0, suggestion: "" });
  });

  it("returns null for non-PR payloads", () => {
    expect(parsePrResult({ foo: "bar" } as unknown as Record<string, unknown>)).toBeNull();
    expect(parsePrResult({} as Record<string, unknown>)).toBeNull();
  });
});
