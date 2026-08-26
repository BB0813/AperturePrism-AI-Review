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
    troubleshooting: [],
    proposedChanges: [],
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

describe("解决方案字段的服务端校验", () => {
  it("根因置信度不足时移除 probableCause", () => {
    const { result, adjustments } = applyGradingRules(
      analysis({
        probableCause: "SSE 连接被反向代理缓冲",
        confidence: { severity: 0.6, rootCause: 0.3, suggestion: 0.5 },
      }),
    );
    expect(result.probableCause).toBeUndefined();
    expect(adjustments.some((a) => a.field === "probableCause")).toBe(true);
  });

  it("置信度足够时保留 probableCause", () => {
    const { result } = applyGradingRules(
      analysis({
        probableCause: "SSE 连接被反向代理缓冲",
        confidence: { severity: 0.6, rootCause: 0.8, suggestion: 0.5 },
      }),
    );
    expect(result.probableCause).toBe("SSE 连接被反向代理缓冲");
  });

  it("未读取源码时剥离行号定位但保留文字建议", () => {
    // 没读过代码却给出行号必然是编造，比不给建议更有害。
    const { result, adjustments } = applyGradingRules(
      analysis({
        proposedChanges: [
          { path: "apps/web/src/lib/api.ts", locator: "L42", change: "关闭缓冲" },
        ],
      }),
      { exploredCode: false },
    );
    expect(result.proposedChanges[0]?.locator).toBeUndefined();
    expect(result.proposedChanges[0]?.path).toBe("apps/web/src/lib/api.ts");
    expect(result.proposedChanges[0]?.change).toBe("关闭缓冲");
    expect(adjustments.some((a) => a.field === "proposedChanges")).toBe(true);
  });

  it("读取过源码时保留行号定位", () => {
    const { result, adjustments } = applyGradingRules(
      analysis({
        proposedChanges: [
          { path: "apps/web/src/lib/api.ts", locator: "L42", change: "关闭缓冲" },
        ],
      }),
      { exploredCode: true },
    );
    expect(result.proposedChanges[0]?.locator).toBe("L42");
    expect(adjustments.some((a) => a.field === "proposedChanges")).toBe(false);
  });

  it("troubleshooting 不受置信度影响", () => {
    // 排查步骤即使不确定也有价值：它引导用户取证，而不是断言结论。
    const { result } = applyGradingRules(
      analysis({
        troubleshooting: ["打开开发者工具查看 /events 请求状态"],
        confidence: { severity: 0.1, rootCause: 0.1, suggestion: 0.1 },
      }),
    );
    expect(result.troubleshooting).toEqual([
      "打开开发者工具查看 /events 请求状态",
    ]);
  });

  it("不含新字段的旧结果仍然通过校验", () => {
    const legacy = {
      contractVersion: "issue-analysis/v1",
      category: "bug",
      summary: "旧版本产出的结果",
      severity: "S2",
      priority: "P2",
      quality: "actionable",
      evidence: [],
      missingInformation: [],
      suggestedLabels: [],
      suggestedActions: [],
      confidence: { severity: 0.5, rootCause: 0.5, suggestion: 0.5 },
    };
    const validation = validateIssueAnalysis(legacy);
    expect(validation.outcome).toBe("valid");
    if (validation.outcome !== "valid") return;
    expect(validation.analysis.result.proposedChanges).toEqual([]);
    expect(validation.analysis.result.troubleshooting).toEqual([]);
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

  it("extracts JSON from a markdown-fenced response", () => {
    const wrapped = "```json\n" + JSON.stringify(analysis()) + "\n```";
    const validation = parseIssueAnalysisJson(wrapped);
    expect(validation.outcome).toBe("valid");
  });

  it("extracts JSON surrounded by prose", () => {
    const messy = `好的，分析如下：\n${JSON.stringify(analysis())}\n以上就是我的分析。`;
    const validation = parseIssueAnalysisJson(messy);
    expect(validation.outcome).toBe("valid");
  });
});
