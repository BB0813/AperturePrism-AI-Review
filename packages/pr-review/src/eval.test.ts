import { describe, expect, it } from "vitest";
import { parsePrReviewJson } from "./validate.js";
import { prEvalCases } from "./eval-data.js";

/**
 * pr-review eval 基线：逐个跑黄金输出集，锁定契约解析与服务端策略。
 * 任何改动让「合法样本被拒」或「非法样本被放行」都会在这里暴露。
 */
describe("pr-review eval 基线集", () => {
  it(`覆盖 ${prEvalCases.length} 个黄金样本`, () => {
    expect(prEvalCases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of prEvalCases) {
    it(`${c.id} — ${c.label}`, () => {
      const v = parsePrReviewJson(c.input);
      expect(v.outcome, `${c.id} 预期 ${c.expected}`).toBe(c.expected);
      if (c.expected !== "valid" || v.outcome !== "valid") return;
      if (c.expectedFindings !== undefined)
        expect(v.review.findings.length, "策略过滤后 findings 数量").toBe(
          c.expectedFindings,
        );
    });
  }
});
