import { describe, expect, it } from "vitest";
import { labelsForAnalysis, type LabelRule } from "./label-rules.js";

const rules: LabelRule[] = [
  { key: "severity:S1", label: "critical", enabled: true },
  { key: "severity:S2", label: "normal", enabled: true },
  { key: "category:bug", label: "bug", enabled: true },
  { key: "category:bug", label: "bug", enabled: false },
  { key: "priority:P0", label: "urgent", enabled: true },
  { key: "quality:incomplete", label: "needs-info", enabled: true },
];

describe("labelsForAnalysis", () => {
  it("returns the labels whose keys match the analysis fields", () => {
    const labels = labelsForAnalysis(
      { category: "bug", severity: "S1", priority: "P0", quality: "complete" },
      rules,
    );
    expect(labels).toEqual(["critical", "bug", "urgent"]);
  });

  it("ignores disabled rules and empty labels", () => {
    const labels = labelsForAnalysis(
      { category: "bug", severity: "S2", priority: "P2", quality: "incomplete" },
      [
        ...rules,
        { key: "severity:S2", label: "   ", enabled: true },
      ],
    );
    expect(labels).toEqual(["normal", "bug", "needs-info"]);
  });

  it("returns nothing when no rule matches", () => {
    const labels = labelsForAnalysis(
      { category: "feature", severity: "S3", priority: "P3", quality: "actionable" },
      rules,
    );
    expect(labels).toEqual([]);
  });

  it("deduplicates labels matched from multiple fields", () => {
    const labels = labelsForAnalysis(
      { category: "bug", severity: "S1", priority: "P0", quality: "complete" },
      [
        ...rules,
        { key: "severity:S1", label: "critical", enabled: true },
      ],
    );
    expect(labels.filter((label) => label === "critical")).toHaveLength(1);
  });
});
