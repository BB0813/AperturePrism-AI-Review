export type DuplicateDecision =
  "duplicate" | "related" | "not_duplicate" | "insufficient_evidence";

/**
 * A final, server-side verdict produced by the policy layer. The vector and
 * full-text layers only propose candidates; the policy decides the verdict and
 * the safe automatic action, which is limited to linking in v1 (no auto-close).
 */
export type FinalDuplicateVerdict = {
  decision: DuplicateDecision;
  /** Whether the system may act without a human. v1 only ever links. */
  autoAction: "link" | "none";
  /** 0..1 model + signal confidence backing this verdict. */
  confidence: number;
  reason: string;
  /** Candidate issue numbers supporting the verdict, ranked most relevant. */
  relatedIssueNumbers: readonly number[];
};

export type LeadIssueNormalized = {
  title: string;
  body: string;
  labels: readonly string[];
};

export type IssueSignals = {
  versions: readonly string[];
  errorCodes: readonly string[];
  paths: readonly string[];
  languages: readonly string[];
  hasStackTrace: boolean;
  hasReproduction: boolean;
  templateFields: readonly [string, string][];
};

export type SignalOverlap = {
  sharedVersions: number;
  sharedErrorCodes: number;
  sharedPaths: number;
  sharedLanguages: number;
  /** Combined count used by the policy to distinguish duplicate vs related. */
  strongShared: number;
};

export type AdjudicationConfig = {
  /** Confidence at or above which a verdict may be acted on automatically. */
  autoLinkConfidence: number;
  /**
   * Strong signals (same error code / stack / module path) shared by the issue
   * and a candidate that must be present to call it a duplicate.
   */
  minSharedStrongSignals: number;
};
