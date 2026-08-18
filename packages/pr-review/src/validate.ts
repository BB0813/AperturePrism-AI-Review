import {
  applySeverityRules,
  dedupeFindings,
  shouldPublishFinding,
} from "./finding.js";
import {
  prReviewContractSchema,
  type PrReviewContract,
} from "./types.js";

export type PrReviewValidation =
  | { outcome: "valid"; review: PrReviewContract }
  | { outcome: "invalid"; issues: readonly string[] };

/**
 * Parses a model response into the strict PR review contract and applies the
 * server-side policy: findings are deduplicated, severity is re-checked against
 * evidence, and un-publishable style nits are dropped. The board only ever
 * sees the policy-filtered set, never a model's raw output.
 */
export function validatePrReview(raw: unknown): PrReviewValidation {
  const parsed = prReviewContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "invalid",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }
  const findings = dedupeFindings(
    parsed.data.findings.map(applySeverityRules),
  ).filter(shouldPublishFinding);
  return {
    outcome: "valid",
    review: { ...parsed.data, findings },
  };
}

export function parsePrReviewJson(text: string): PrReviewValidation {
  try {
    return validatePrReview(JSON.parse(text));
  } catch {
    return {
      outcome: "invalid",
      issues: ["root: response was not valid JSON"],
    };
  }
}