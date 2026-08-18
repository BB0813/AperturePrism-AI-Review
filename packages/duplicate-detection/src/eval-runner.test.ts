import { describe, expect, it } from "vitest";
import { labeledDataset } from "./eval-data.js";
import { runOfflineEval } from "./eval-runner.js";

describe("offline duplicate evaluation", () => {
  it("runs the labeled dataset and reports honest metrics", async () => {
    const { metrics, samples } = await runOfflineEval(labeledDataset, {
      topK: 5,
    });

    // Dataset: 1 true-duplicate example (HTTP_511), 1 related, 1 none.
    expect(metrics.total).toBe(labeledDataset.length);
    expect(metrics.positives).toBe(1);
    // The HTTP_511 duplicate is recalled and detected by signal overlap.
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBe(1);
    expect(metrics.falseDuplicateRate).toBe(0);

    const sample = samples.find((s) => s.id === "1");
    expect(sample?.recalledDuplicates).toEqual([2]);
    expect(sample?.detectedDuplicates).toEqual([2]);
  });
});
