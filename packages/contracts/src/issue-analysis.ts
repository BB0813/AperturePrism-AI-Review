import { z } from "zod";

/**
 * Evidence kinds that can justify a high severity or priority. The analyzer
 * must point at something concrete in the issue, never at its own reasoning.
 */
export const evidenceKinds = [
  "reproduction_steps",
  "logs",
  "stack_trace",
  "data_loss",
  "security_path",
  "impact_scope",
] as const;

export const evidenceSchema = z.object({
  kind: z.enum(evidenceKinds),
  /** Verbatim excerpt from the issue, so reviewers can verify the claim. */
  excerpt: z.string().min(1).max(2_000),
});

export const issueCategories = [
  "bug",
  "feature",
  "question",
  "security",
  "performance",
  "documentation",
  "other",
] as const;

/** Severity describes impact. It is deliberately independent of priority. */
export const severityLevels = ["S0", "S1", "S2", "S3", "unknown"] as const;

/** Priority describes scheduling urgency, which is a separate judgment. */
export const priorityLevels = ["P0", "P1", "P2", "P3", "needs_triage"] as const;

export const qualityLevels = [
  "complete",
  "actionable",
  "incomplete",
  "invalid",
] as const;

export const highSeverityLevels: readonly string[] = ["S0", "S1"];
export const highPriorityLevels: readonly string[] = ["P0", "P1"];

const confidenceSchema = z.number().min(0).max(1);

export const issueAnalysisResultSchema = z
  .object({
    contractVersion: z.literal("issue-analysis/v1"),
    category: z.enum(issueCategories),
    summary: z.string().min(1).max(2_000),
    severity: z.enum(severityLevels),
    priority: z.enum(priorityLevels),
    quality: z.enum(qualityLevels),
    /** 当原标题含糊/冗长时给出更清晰的标题；标题已清晰时省略。 */
    suggestedTitle: z.string().min(1).max(120).optional(),
    evidence: z.array(evidenceSchema).max(10).default([]),
    /** Facts the issue does not provide. Never invented by the analyzer. */
    missingInformation: z.array(z.string().min(1).max(500)).max(10).default([]),
    suggestedLabels: z.array(z.string().min(1).max(50)).max(10).default([]),
    suggestedActions: z.array(z.string().min(1).max(500)).max(10).default([]),
    confidence: z.object({
      severity: confidenceSchema,
      rootCause: confidenceSchema,
      suggestion: confidenceSchema,
    }),
  })
  .strict();

export type IssueAnalysisResult = z.infer<typeof issueAnalysisResultSchema>;
export type IssueEvidence = z.infer<typeof evidenceSchema>;

export const duplicateDecisions = [
  "duplicate",
  "related",
  "not_duplicate",
  "insufficient_evidence",
] as const;

export const duplicateJudgmentSchema = z
  .object({
    contractVersion: z.literal("duplicate-judgment/v1"),
    decision: z.enum(duplicateDecisions),
    /** Issue numbers that support the decision, ranked most relevant first. */
    relatedIssues: z.array(z.number().int().positive()).max(10).default([]),
    sharedSignals: z.array(z.string().min(1).max(500)).max(10).default([]),
    differingSignals: z.array(z.string().min(1).max(500)).max(10).default([]),
    confidence: confidenceSchema,
  })
  .strict();

export type DuplicateJudgment = z.infer<typeof duplicateJudgmentSchema>;
