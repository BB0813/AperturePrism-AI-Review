import type { DuplicateJudgment } from "../../../packages/contracts/src/index.js";
import type {
  AdjudicationConfig,
  FinalDuplicateVerdict,
  SignalOverlap,
} from "./types.js";

const DEFAULT_CONFIG: Required<AdjudicationConfig> = {
  autoLinkConfidence: 0.8,
  minSharedStrongSignals: 1,
};

/**
 * The server-side policy that turns a candidate set + model judgment + signal
 * overlap into a final verdict. The vector/full-text layers only recall; the
 * model only proposes; this layer decides and, in v1, limits the automatic
 * action to linking — it never auto-closes an issue.
 */
export function adjudicateDuplicate(input: {
  judgment: DuplicateJudgment;
  overlap: SignalOverlap;
  config?: Partial<AdjudicationConfig>;
}): FinalDuplicateVerdict {
  const config: Required<AdjudicationConfig> = {
    ...DEFAULT_CONFIG,
    ...(input.config ?? {}),
  };
  const { judgment, overlap } = input;
  const relatedIssueNumbers = [...judgment.relatedIssues];

  // Honest default: not enough to act.
  if (
    judgment.decision === "insufficient_evidence" ||
    judgment.confidence < config.autoLinkConfidence
  ) {
    return {
      decision: "insufficient_evidence",
      autoAction: "link",
      confidence: judgment.confidence,
      reason: `judgment confidence ${Math.round(judgment.confidence * 100)}% below ${Math.round(config.autoLinkConfidence * 100)}%; human confirmation needed`,
      relatedIssueNumbers,
    };
  }

  if (judgment.decision === "duplicate") {
    if (overlap.strongShared >= config.minSharedStrongSignals) {
      return {
        decision: "duplicate",
        autoAction: "link",
        confidence: judgment.confidence,
        reason: `model found a duplicate and ${overlap.strongShared} strong signal(s) match (error code / stack / module / language)`,
        relatedIssueNumbers,
      };
    }
    return {
      decision: "insufficient_evidence",
      autoAction: "link",
      confidence: judgment.confidence,
      reason:
        "model called duplicate but no strong signals match; human confirmation needed",
      relatedIssueNumbers,
    };
  }

  if (judgment.decision === "related") {
    return {
      decision: "related",
      autoAction: "link",
      confidence: judgment.confidence,
      reason: "model found a related issue; link without auto-closing",
      relatedIssueNumbers,
    };
  }

  return {
    decision: "not_duplicate",
    autoAction: "none",
    confidence: judgment.confidence,
    reason: "model found no duplicate relationship",
    relatedIssueNumbers,
  };
}
