import { describe, expect, it } from "vitest";
import type { DuplicateJudgment } from "../../../packages/contracts/src/index.js";
import { adjudicateDuplicate } from "./decision.js";
import type { SignalOverlap } from "./types.js";

function judgment(
  overrides: Partial<DuplicateJudgment> = {},
): DuplicateJudgment {
  return {
    contractVersion: "duplicate-judgment/v1",
    decision: "duplicate",
    relatedIssues: [7, 9],
    sharedSignals: [],
    differingSignals: [],
    confidence: 0.9,
    ...overrides,
  };
}

const strongOverlap: SignalOverlap = {
  sharedVersions: 1,
  sharedErrorCodes: 1,
  sharedPaths: 1,
  sharedLanguages: 1,
  strongShared: 2,
};

describe("duplicate adjudication policy", () => {
  it("links a high-confidence duplicate with strong signal overlap", () => {
    const verdict = adjudicateDuplicate({
      judgment: judgment(),
      overlap: strongOverlap,
    });
    expect(verdict).toMatchObject({
      decision: "duplicate",
      autoAction: "link",
      relatedIssueNumbers: [7, 9],
    });
    expect(verdict.reason).toContain("strong signal(s)");
  });

  it("demands manual confirmation when a duplicate lacks strong signals", () => {
    const weak: SignalOverlap = {
      sharedVersions: 0,
      sharedErrorCodes: 0,
      sharedPaths: 0,
      sharedLanguages: 0,
      strongShared: 0,
    };
    const verdict = adjudicateDuplicate({
      judgment: judgment(),
      overlap: weak,
    });
    expect(verdict.decision).toBe("insufficient_evidence");
    expect(verdict.autoAction).toBe("link");
  });

  it("treats low-confidence as insufficient evidence even if duplicate", () => {
    const low = adjudicateDuplicate({
      judgment: judgment({ confidence: 0.5 }),
      overlap: strongOverlap,
    });
    expect(low.decision).toBe("insufficient_evidence");
  });

  it("returns related and not_duplicate(( undisputed cases", () => {
    const related = adjudicateDuplicate({
      judgment: judgment({ decision: "related", confidence: 0.85 }),
      overlap: strongOverlap,
    });
    expect(related).toMatchObject({ decision: "related", autoAction: "link" });

    const notDup = adjudicateDuplicate({
      judgment: judgment({ decision: "not_duplicate", confidence: 0.9 }),
      overlap: strongOverlap,
    });
    expect(notDup).toMatchObject({
      decision: "not_duplicate",
      autoAction: "none",
    });
  });

  it("never auto-closes in v1 (automatic action is at most a link)", () => {
    const verdict = adjudicateDuplicate({
      judgment: judgment(),
      overlap: strongOverlap,
    });
    expect(["link", "none"]).toContain(verdict.autoAction);
  });
});
