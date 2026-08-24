import { describe, expect, it } from "vitest";
import { parseIssueAnalysisJson } from "../../../packages/contracts/src/index.js";
import { issueEvalCases } from "./eval-data.js";

/**
 * issue-analysis eval 基线：逐个跑黄金输出集，锁定契约解析与服务端降级规则。
 * 任何改动让「合法样本被拒」或「非法样本被放行」都会在这里暴露。
 */
describe("issue-analysis eval 基线集", () => {
  it(`覆盖 ${issueEvalCases.length} 个黄金样本`, () => {
    expect(issueEvalCases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of issueEvalCases) {
    it(`${c.id} — ${c.label}`, () => {
      const v = parseIssueAnalysisJson(
        c.input,
        c.exploredCode ? { exploredCode: true } : {},
      );
      expect(v.outcome, `${c.id} 预期 ${c.expected}`).toBe(c.expected);
      if (c.expected !== "valid" || v.outcome !== "valid") return;

      if (c.expectedSeverity)
        expect(v.analysis.result.severity, "severity 降级后取值").toBe(
          c.expectedSeverity,
        );
      if (c.expectedPriority)
        expect(v.analysis.result.priority, "priority 降级后取值").toBe(
          c.expectedPriority,
        );
      if (c.expectCauseRemoved)
        expect(v.analysis.result.probableCause).toBeUndefined();
      if (c.expectLocatorRemoved)
        expect(v.analysis.result.proposedChanges?.[0]?.locator).toBeUndefined();
      if (c.expectLocatorKept)
        expect(v.analysis.result.proposedChanges?.[0]?.locator).toBeDefined();
    });
  }
});
