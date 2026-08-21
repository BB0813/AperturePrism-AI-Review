import { describe, expect, it } from "vitest";
import {
  classifyPrSize,
  selectReviewMode,
  type RenderedPrContext,
} from "./context.js";
import { buildPrReviewMessages } from "./prompt.js";

function renderedWith(fileCount: number, additions: number, deletions: number): RenderedPrContext {
  return {
    diff: {
      files: Array.from({ length: fileCount }, (_, i) => ({
        path: `f${i}.ts`,
        additions,
        deletions,
      })),
      additions,
      deletions,
    },
    keptFiles: [],
    listedFiles: [],
    degraded: [],
  } as unknown as RenderedPrContext;
}

describe("classifyPrSize", () => {
  it("classifies by churn and file count", () => {
    expect(classifyPrSize(1, 10, 5)).toBe("small");
    expect(classifyPrSize(5, 150, 60)).toBe("medium");
    expect(classifyPrSize(25, 400, 200)).toBe("large");
    expect(classifyPrSize(50, 100, 100)).toBe("oversized");
    expect(classifyPrSize(2, 3_000, 3_000)).toBe("oversized");
  });
});

describe("selectReviewMode", () => {
  it("maps small PRs to quick", () => {
    expect(selectReviewMode(renderedWith(2, 30, 10))).toBe("quick");
  });

  it("maps medium PRs to standard", () => {
    expect(selectReviewMode(renderedWith(5, 150, 60))).toBe("standard");
  });

  it("maps large and oversized PRs to deep", () => {
    expect(selectReviewMode(renderedWith(25, 400, 200))).toBe("deep");
    expect(selectReviewMode(renderedWith(50, 100, 100))).toBe("deep");
  });
});

describe("adaptive prompts", () => {
  it("injects mode-specific instructions into the system prompt", () => {
    const quick = buildPrReviewMessages(renderedWith(1, 5, 2));
    const quickSystem = quick[0]!.content;
    expect(quickSystem).toContain("快速");
    expect(quickSystem).toContain("findings 最多 10 条");

    const deep = buildPrReviewMessages(renderedWith(30, 2_000, 500));
    const deepSystem = deep[0]!.content;
    expect(deepSystem).toContain("深度");
    expect(deepSystem).toContain("findings 最多 50 条");
  });

  it("defaults to standard mode for medium PRs", () => {
    const standard = buildPrReviewMessages(renderedWith(5, 150, 60));
    expect(standard[0]!.content).toContain("标准");
  });
});
