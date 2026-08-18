import { describe, expect, it } from "vitest";
import {
  applyGradingRules,
  type IssueAnalysisResult,
} from "../../../packages/contracts/src/index.js";
import {
  buildIssueAnalysisComment,
  buildPlaceholderComment,
} from "./comment.js";

const result: IssueAnalysisResult = {
  contractVersion: "issue-analysis/v1",
  category: "security",
  summary: "API tokens leak into the access log.",
  severity: "S1",
  priority: "P1",
  quality: "complete",
  evidence: [
    { kind: "logs", excerpt: "token=abc123 appears in the access log" },
  ],
  missingInformation: ["Deployment version"],
  suggestedLabels: ["security"],
  suggestedActions: ["Redact tokens before logging"],
  confidence: { severity: 0.9, rootCause: 0.8, suggestion: 0.7 },
};

describe("issue comment templates", () => {
  it("builds a neutral placeholder that is not a decision", () => {
    const placeholder = buildPlaceholderComment();
    expect(placeholder).toContain("AperturePrism");
    expect(placeholder).not.toContain("S0");
  });

  it("renders every part of the graded analysis", () => {
    const graded = applyGradingRules(result);
    const comment = buildIssueAnalysisComment(graded);

    expect(comment).toContain("security");
    expect(comment).toContain("S1");
    expect(comment).toContain("P1");
    expect(comment).toContain("API tokens leak into the access log.");
    expect(comment).toContain("token=abc123 appears in the access log");
    expect(comment).toContain("Deployment version");
    expect(comment).toContain("security");
    expect(comment).toContain("90%");
    expect(comment).toContain("由 AperturePrism 自动生成");
  });

  it("notes server-side rating adjustments when present", () => {
    const unsubstantiated = {
      ...result,
      severity: "S0",
      priority: "P0",
      evidence: [{ kind: "impact_scope", excerpt: "All users affected" }],
    } satisfies IssueAnalysisResult;
    const graded = applyGradingRules(unsubstantiated);
    const comment = buildIssueAnalysisComment(graded);

    expect(graded.adjustments.length).toBeGreaterThan(0);
    expect(comment).toContain("S0 → unknown");
    expect(comment).toContain("P0 → needs_triage");
    expect(comment).toContain("评级调整");
  });

  it("appends a related-issues section that only references, never auto-links", () => {
    const graded = applyGradingRules(result);
    const related = [
      {
        id: "d1",
        repositoryId: "r1",
        repositoryFullName: "owner/repo",
        issueNumber: 42,
        score: 12.5,
        reasons: ["text", "signal"] as const,
      },
    ];
    const comment = buildIssueAnalysisComment(graded, related);

    expect(comment).toContain("可能相关的历史 Issue");
    expect(comment).toContain("https://github.com/owner/repo/issues/42");
    expect(comment).toContain("仅供参考，不自动关联");
    expect(comment).not.toContain("close");
  });
});
