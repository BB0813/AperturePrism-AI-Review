import type { FinalDuplicateVerdict } from "./types.js";

/**
 * A single labeled evaluation sample: which candidate issue numbers are true
 * duplicates of the lead (ground truth), and optionally which are merely
 * related.
 */
export type EvalSample = {
  id: string;
  trueDuplicateNumbers: readonly number[];
  relatedNumbers?: readonly number[];
};

export type EvaluatedSample = {
  id: string;
  /** True duplicates that were recalled. */
  recalledDuplicates: readonly number[];
  /** True duplicates that were both recalled and judged as duplicate. */
  detectedDuplicates: readonly number[];
  verdict: FinalDuplicateVerdict | null;
  /** Whether the verdict deferred to a human (insufficient_evidence). */
  deferredToHuman: boolean;
};

/**
 * The runner is injected so metrics can be measured against any recall /
 * judge implementation (real model+DB, or a stub in tests).
 */
export type EvalDeps = {
  /** Gathers candidate issue numbers for a lead. */
  recall: (sample: EvalSample) => Promise<readonly number[]>;
  /** Runs the judge + adjudication over the recalled candidates. */
  adjudicate: (
    sample: EvalSample,
    recalledNumbers: readonly number[],
  ) => Promise<FinalDuplicateVerdict | null>;
};

export type EvalMetrics = {
  total: number;
  /** Examples that have at least one true duplicate label. */
  positives: number;
  /** fraction of positives where at least one true duplicate was recalled. */
  recallAtK: number;
  /** fraction of duplicates judged "duplicate" that are true duplicates. */
  precision: number;
  /** fraction of positives that were detected as duplicates. */
  recall: number;
  /** fraction of "duplicate" verdicts that were false (no true dup hit). */
  falseDuplicateRate: number;
  /** fraction of samples where the system deferred to a human. */
  humanDeferRate: number;
  /** fraction of positives auto-detected without human deferral. */
  autoDetectRate: number;
};

export async function evaluate(
  samples: readonly EvalSample[],
  deps: EvalDeps,
): Promise<{ samples: EvaluatedSample[]; metrics: EvalMetrics }> {
  const evaluated: EvaluatedSample[] = [];
  let positives = 0;
  let recallHits = 0;
  let detected = 0;
  let duplicateDecisions = 0;
  let falseDuplicates = 0;
  let deferred = 0;

  for (const sample of samples) {
    const isPositive = sample.trueDuplicateNumbers.length > 0;
    if (isPositive) positives += 1;

    const recalled = await deps.recall(sample);
    const recalledDuplicates = sample.trueDuplicateNumbers.filter((n) =>
      recalled.includes(n),
    );
    if (isPositive && recalledDuplicates.length > 0) recallHits += 1;

    const verdict = await deps.adjudicate(sample, recalled);
    if (!verdict) {
      evaluated.push({
        id: sample.id,
        recalledDuplicates,
        detectedDuplicates: [],
        verdict: null,
        deferredToHuman: true,
      });
      deferred += 1;
      continue;
    }

    const relatedHit = verdict.relatedIssueNumbers.filter((n) =>
      recalled.includes(n),
    );
    const trueHit = relatedHit.filter((n) =>
      sample.trueDuplicateNumbers.includes(n),
    );
    const isDuplicateDecision = verdict.decision === "duplicate";
    if (isDuplicateDecision) {
      duplicateDecisions += 1;
      if (trueHit.length === 0) falseDuplicates += 1;
    }
    if (isPositive && trueHit.length > 0) detected += 1;

    const deferredToHuman = verdict.decision === "insufficient_evidence";
    if (deferredToHuman) deferred += 1;

    evaluated.push({
      id: sample.id,
      recalledDuplicates,
      detectedDuplicates: isPositive ? trueHit : [],
      verdict,
      deferredToHuman,
    });
  }

  const precision =
    duplicateDecisions === 0
      ? 0
      : (duplicateDecisions - falseDuplicates) / duplicateDecisions;
  const recall = positives === 0 ? 0 : detected / positives;
  const metrics: EvalMetrics = {
    total: samples.length,
    positives,
    recallAtK: positives === 0 ? 0 : recallHits / positives,
    precision,
    recall,
    falseDuplicateRate:
      duplicateDecisions === 0 ? 0 : falseDuplicates / duplicateDecisions,
    humanDeferRate: samples.length === 0 ? 0 : deferred / samples.length,
    autoDetectRate: positives === 0 ? 0 : detected / positives,
  };
  return { samples: evaluated, metrics };
}
