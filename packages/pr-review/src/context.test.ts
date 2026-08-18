import { describe, expect, it } from "vitest";
import { classifyPrSize, renderDiffForModel } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";

describe("classifyPrSize", () => {
  it("classifies small, medium, large and oversized", () => {
    expect(classifyPrSize(3, 120, 40)).toBe("small");
    expect(classifyPrSize(10, 200, 50)).toBe("medium");
    expect(classifyPrSize(25, 800, 100)).toBe("large");
    expect(classifyPrSize(2, 6_000, 0)).toBe("oversized");
  });
});

describe("renderDiffForModel", () => {
  function makeDiff(fileCount: number, linesPerFile: number) {
    let text = "";
    for (let f = 0; f < fileCount; f += 1) {
      text += `diff --git a/src/f${f}.ts b/src/f${f}.ts\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n@@ -1,${linesPerFile} +1,${linesPerFile} @@\n`;
      for (let i = 0; i < linesPerFile; i += 1) text += `+line ${f}-${i}\n`;
    }
    return parseUnifiedDiff(text);
  }

  it("inlines files up to the cap and lists the rest by name", () => {
    const diff = makeDiff(30, 5);
    const ctx = renderDiffForModel(diff, { maxInlineFiles: 25, maxLinesPerFile: 400, maxTokens: 12000 });
    expect(ctx.keptFiles).toHaveLength(25);
    expect(ctx.listedFiles.length + ctx.keptFiles.length).toBe(30);
    expect(ctx.degraded).toContain("some_files_listed_only");
  });

  it("flags large files for head+tail rendering", () => {
    const diff = makeDiff(3, 500);
    const ctx = renderDiffForModel(diff, { maxInlineFiles: 25, maxLinesPerFile: 400, maxTokens: 12000 });
    expect(ctx.degraded).toContain("large_file_head_tail_only");
  });
});