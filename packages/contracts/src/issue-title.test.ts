import { describe, expect, it } from "vitest";
import type { IssueAnalysisResult } from "./issue-analysis.js";
import { deriveImportance, formatSuggestedTitle } from "./issue-title.js";

type TitleInput = Pick<
  IssueAnalysisResult,
  "severity" | "priority" | "suggestedLabels" | "suggestedTitle"
>;

function input(overrides: Partial<TitleInput> = {}): TitleInput {
  return {
    severity: "S2",
    priority: "P2",
    suggestedLabels: ["bug"],
    suggestedTitle: "登录接口返回 500",
    ...overrides,
  };
}

describe("deriveImportance", () => {
  it("treats high severity or high priority as high", () => {
    expect(deriveImportance(input({ severity: "S0", priority: "P3" }))).toBe(
      "high",
    );
    expect(deriveImportance(input({ severity: "S3", priority: "P1" }))).toBe(
      "high",
    );
  });

  it("maps the middle band to medium", () => {
    expect(deriveImportance(input({ severity: "S2", priority: "P3" }))).toBe(
      "medium",
    );
  });

  it("does not let unknown grades inflate importance", () => {
    expect(
      deriveImportance(
        input({ severity: "unknown", priority: "needs_triage" }),
      ),
    ).toBe("low");
  });
});

describe("formatSuggestedTitle", () => {
  it("prefixes the label and importance", () => {
    expect(formatSuggestedTitle(input())).toBe("[bug][medium]登录接口返回 500");
  });

  it("omits the label segment when no label was suggested", () => {
    expect(formatSuggestedTitle(input({ suggestedLabels: [] }))).toBe(
      "[medium]登录接口返回 500",
    );
  });

  it("does not stack prefixes when the title is rewritten again", () => {
    // Re-analysis reads back the already-rewritten title; without stripping,
    // repeated runs would produce [bug][medium][bug][medium]...
    expect(
      formatSuggestedTitle(
        input({ suggestedTitle: "[bug][medium]登录接口返回 500" }),
      ),
    ).toBe("[bug][medium]登录接口返回 500");
  });

  it("keeps brackets that belong to the title text", () => {
    expect(
      formatSuggestedTitle(input({ suggestedTitle: "修复 array[0] 越界" })),
    ).toBe("[bug][medium]修复 array[0] 越界");
  });

  it("returns undefined when the model suggested no title", () => {
    expect(
      formatSuggestedTitle(input({ suggestedTitle: undefined })),
    ).toBeUndefined();
    // A title that is only a prefix leaves nothing to rewrite.
    expect(formatSuggestedTitle(input({ suggestedTitle: "[bug]" }))).toBeUndefined();
  });

  it("stays within GitHub's title limit", () => {
    const long = "很长的标题".repeat(60);
    const formatted = formatSuggestedTitle(input({ suggestedTitle: long }));
    expect(formatted!.length).toBeLessThanOrEqual(200);
  });
});
