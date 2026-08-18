import { describe, expect, it } from "vitest";
import {
  applyGradingRules,
  parseIssueAnalysisJson,
  validateIssueAnalysis,
} from "./grading.js";
import type { IssueAnalysisResult } from "./issue-analysis.js";

function analysis(
  overrides: Partial<IssueAnalysisResult> = {},
): IssueAnalysisResult {
  return {
    contractVersion: "issue-analysis/v1",
    category: "bug",
    summary: "Login fails with a 500 response.",
    severity: "S2",
    priority: "P2",
    quality: "actionable",
    evidence: [],
    missingInformation: [],
    suggestedLabels: [],
    suggestedActions: [],
    confidence: { severity: 0.6, rootCause: 0.5, suggestion: 0.5 },
    ...overrides,
  };
}

describe("severity and priority independence", () => {
  it("keeps severity and priority as separate fields", () => {
    const { result } = applyGradingRules(
      analysis({
        severity: "S1",
        priority: "P3",
        evidence: [{ kind: "stack_trace", excerpt: "NullPointerException" }],
      }),
    );
    expect(result.severity).toBe("S1");
    expect(result.priority).toBe("P3");
  });
});

describe("high grades require evidence", () => {
  it("downgrades S0 and S1 without substantive evidence", () => {
    for (const severity of ["S0", "S1"] as const) {
      const { result, adjustments } = applyGradingRules(analysis({ severity }));
      expect(result.severity).toBe("unknown");
      expect(adjustments[0]).toMatchObject({
        field: "severity",
        from: severity,
      });
    }
  });

  it("downgrades P0 and P1 without substantive evidence", () => {
    for (const priority of ["P0", "P1"] as const) {
      const { result } = applyGradingRules(analysis({ priority }));
      expect(result.priority).toBe("needs_triage");
    }
  });

  it("accepts high grades backed by reproduction, logs, stack, data loss, or security", () => {
    const kinds = [
      "reproduction_steps",
      "logs",
      "stack_trace",
      "data_loss",
      "security_path",
    ] as const;
    for (const kind of kinds) {
      const { result, adjustments } = applyGradingRules(
        analysis({
          severity: "S0",
          priority: "P0",
          evidence: [{ kind, excerpt: "concrete detail" }],
        }),
      );
      expect(result.severity).toBe("S0");
      expect(result.priority).toBe("P0");
      expect(adjustments).toHaveLength(0);
    }
  });

  it("does not let a bare impact claim justify a high grade", () => {
    const { result } = applyGradingRules(
      analysis({
        severity: "S0",
        priority: "P0",
        evidence: [{ kind: "impact_scope", excerpt: "affects everyone" }],
      }),
    );
    expect(result.severity).toBe("unknown");
    expect(result.priority).toBe("needs_triage");
  });
});

describe("low quality reports cannot carry confident grades", () => {
  it("downgrades priority for incomplete and invalid reports", () => {
    for (const quality of ["incomplete", "invalid"] as const) {
      const { result } = applyGradingRules(
        analysis({
          quality,
          priority: "P1",
          evidence: [{ kind: "logs", excerpt: "500" }],
        }),
      );
      expect(result.priority).toBe("needs_triage");
    }
  });

  it("clears severity for an invalid report", () => {
    const { result, adjustments } = applyGradingRules(
      analysis({
        quality: "invalid",
        severity: "S2",
        evidence: [{ kind: "logs", excerpt: "500" }],
      }),
    );
    expect(result.severity).toBe("unknown");
    expect(adjustments.some((a) => a.field === "severity")).toBe(true);
  });
});

describe("contract validation", () => {
  it("accepts a valid payload and applies grading", () => {
    const validation = validateIssueAnalysis(analysis({ severity: "S1" }));
    expect(validation.outcome).toBe("valid");
    if (validation.outcome !== "valid") return;
    expect(validation.analysis.result.severity).toBe("unknown");
  });

  it("reports field paths for malformed payloads", () => {
    const validation = validateIssueAnalysis({
      contractVersion: "issue-analysis/v1",
      category: "not-a-category",
    });
    expect(validation.outcome).toBe("invalid");
    if (validation.outcome !== "invalid") return;
    expect(
      validation.issues.some((issue) => issue.startsWith("category")),
    ).toBe(true);
  });

  it("rejects unknown fields so silent drift is caught", () => {
    const validation = validateIssueAnalysis({
      ...analysis(),
      autoClose: true,
    });
    expect(validation.outcome).toBe("invalid");
  });

  it("rejects non-JSON model output without throwing", () => {
    const validation = parseIssueAnalysisJson("I think the issue is severe.");
    expect(validation.outcome).toBe("invalid");
    if (validation.outcome !== "invalid") return;
    expect(validation.issues).toEqual(["root: response was not valid JSON"]);
  });

  it("parses valid JSON model output", () => {
    const validation = parseIssueAnalysisJson(JSON.stringify(analysis()));
    expect(validation.outcome).toBe("valid");
  });
});
