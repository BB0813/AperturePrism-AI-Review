import { describe, expect, it } from "vitest";
import { evaluate, type EvalDeps, type EvalSample } from "./eval.js";
import type { FinalDuplicateVerdict } from "./types.js";

function verdict(
  decision: FinalDuplicateVerdict["decision"],
  related: number[],
): FinalDuplicateVerdict {
  return {
    decision,
    autoAction: decision === "duplicate" ? "link" : "none",
    confidence: 0.9,
    reason: "t",
    relatedIssueNumbers: related,
  };
}

const samples: EvalSample[] = [
  { id: "a", trueDuplicateNumbers: [7] },
  { id: "b", trueDuplicateNumbers: [8], relatedNumbers: [9, 10] },
  { id: "c", trueDuplicateNumbers: [] }, // not a real duplicate
];

const deps: EvalDeps = {
  recall: async (s) => (s.id === "c" ? [11, 12] : [7, 8, 9, 10]),
  adjudicate: async (s) => {
    if (s.id === "a") return verdict("duplicate", [7]);
    if (s.id === "b") return verdict("duplicate", [9]); // only a related link, missed true dup
    return verdict("not_duplicate", []);
  },
};

describe("duplicate evaluation", () => {
  it("computes precision, recall, false-duplicate and deferral metrics", async () => {
    const { samples: evaluated, metrics } = await evaluate(samples, deps);

    expect(evaluated).toHaveLength(3);
    expect(metrics.total).toBe(3);
    expect(metrics.positives).toBe(2);

    // a: recalled+detected. b: recalled but not detected (related hit).
    // c: not positive.
    expect(metrics.recallAtK).toBe(1); // both positives recalled
    expect(metrics.recall).toBe(0.5); // 1/2 detected
    // duplicate decisions: a(true), b(false) -> precision 0.5
    expect(metrics.precision).toBe(0.5);
    expect(metrics.falseDuplicateRate).toBe(0.5);
    // none deferred
    expect(metrics.humanDeferRate).toBe(0);
    expect(metrics.autoDetectRate).toBe(0.5);
  });

  it("counts human deferral when the verdict is insufficient_evidence", async () => {
    const deferring: EvalDeps = {
      ...deps,
      adjudicate: async () => verdict("insufficient_evidence", []),
    };
    const { metrics } = await evaluate(samples, deferring);
    expect(metrics.humanDeferRate).toBe(1);
    expect(metrics.precision).toBe(0);
  });
});
