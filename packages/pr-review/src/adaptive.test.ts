import { describe, expect, it } from "vitest";
import {
  classifyPrSize,
  selectReviewMode,
  type RenderedPrContext,
} from "./context.js";
import { buildPrReviewMessages, injectReviewHistory } from "./prompt.js";

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

describe("injectReviewHistory", () => {
  const base = buildPrReviewMessages(renderedWith(2, 30, 10)); // [system, user(diff)]

  it("keeps base messages unchanged when history is empty", () => {
    const out = injectReviewHistory(base, []);
    expect(out).toEqual([...base]);
    expect(out).toHaveLength(2);
  });

  it("injects prior conversation after system and appends an incremental hint", () => {
    const history = [
      { role: "user" as const, content: "旧 diff" },
      { role: "assistant" as const, content: "之前的分析" },
    ];
    const out = injectReviewHistory(base, history);
    expect(out[0]).toEqual(base[0]); // system 在前
    expect(out[1]?.content).toBe("旧 diff");
    expect(out[2]?.content).toBe("之前的分析");
    expect(out[3]).toEqual(base[1]); // 新 diff
    // 末尾是增量提示
    const last = out[out.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("同一 PR 此前的审查对话");
  });

  it("filters tool results and strips toolCalls / empty assistant turns", () => {
    const history = [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool" as const, content: "file content", toolCallId: "c1" },
      { role: "assistant" as const, content: "分析结果" },
    ];
    const out = injectReviewHistory(base, history);
    const contents = out.map((m) => m.content);
    expect(contents).not.toContain("file content"); // tool 被过滤
    expect(contents).not.toContain(""); // 空 assistant 被过滤
    expect(contents).toContain("分析结果");
    const injected = out.find((m) => m.content === "分析结果");
    expect(injected && "toolCalls" in injected ? (injected as { toolCalls?: unknown }).toolCalls : undefined).toBeUndefined();
  });
});
