import {
  highPriorityLevels,
  highSeverityLevels,
  issueAnalysisResultSchema,
  type IssueAnalysisResult,
} from "./issue-analysis.js";

export type GradingAdjustment = {
  field: "severity" | "priority";
  from: string;
  to: string;
  reason: string;
};

export type GradedIssueAnalysis = {
  result: IssueAnalysisResult;
  adjustments: readonly GradingAdjustment[];
};

/**
 * Evidence kinds that can carry a high severity on their own. Impact scope is
 * excluded because a model can assert broad impact without any issue detail.
 */
const substantiveEvidenceKinds: readonly string[] = [
  "reproduction_steps",
  "logs",
  "stack_trace",
  "data_loss",
  "security_path",
];

function hasSubstantiveEvidence(result: IssueAnalysisResult): boolean {
  return result.evidence.some((item) =>
    substantiveEvidenceKinds.includes(item.kind),
  );
}

/**
 * Enforces the grading rules on the server instead of trusting the model to
 * restrain itself. A high grade without verifiable evidence is downgraded to
 * an explicit unknown, which is honest rather than confidently wrong.
 */
export function applyGradingRules(
  result: IssueAnalysisResult,
): GradedIssueAnalysis {
  const adjustments: GradingAdjustment[] = [];
  let severity = result.severity;
  let priority = result.priority;

  const evidenced = hasSubstantiveEvidence(result);

  if (highSeverityLevels.includes(severity) && !evidenced) {
    adjustments.push({
      field: "severity",
      from: severity,
      to: "unknown",
      reason:
        "high severity requires reproduction, logs, stack, data loss, or a security path",
    });
    severity = "unknown";
  }

  if (highPriorityLevels.includes(priority) && !evidenced) {
    adjustments.push({
      field: "priority",
      from: priority,
      to: "needs_triage",
      reason: "high priority requires verifiable evidence in the issue",
    });
    priority = "needs_triage";
  }

  // An invalid or incomplete report cannot support a confident schedule.
  if (
    (result.quality === "invalid" || result.quality === "incomplete") &&
    highPriorityLevels.includes(priority)
  ) {
    adjustments.push({
      field: "priority",
      from: priority,
      to: "needs_triage",
      reason: `quality ${result.quality} cannot justify a high priority`,
    });
    priority = "needs_triage";
  }

  if (result.quality === "invalid" && severity !== "unknown") {
    adjustments.push({
      field: "severity",
      from: severity,
      to: "unknown",
      reason: "an invalid report cannot establish severity",
    });
    severity = "unknown";
  }

  return {
    result: { ...result, severity, priority },
    adjustments,
  };
}

export type ContractValidation =
  | { outcome: "valid"; analysis: GradedIssueAnalysis }
  | { outcome: "invalid"; issues: readonly string[] };

/**
 * Parses and grades a model response. Returning structured issues lets the
 * router attempt exactly one bounded repair instead of retrying blindly.
 */
export function validateIssueAnalysis(raw: unknown): ContractValidation {
  const parsed = issueAnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }
  return { outcome: "valid", analysis: applyGradingRules(parsed.data) };
}

/** Parses a JSON model response without letting syntax errors escape. */
export function parseIssueAnalysisJson(text: string): ContractValidation {
  try {
    return validateIssueAnalysis(JSON.parse(text));
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
}
