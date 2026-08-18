import { adjudicateDuplicate } from "./decision.js";
import { evaluate, type EvalMetrics, type EvalSample } from "./eval.js";
import { leadOf, type DatasetEntry, type DatasetIssue } from "./eval-data.js";
import { computeSignalOverlap, extractIssueSignals } from "./signals.js";
import type { FinalDuplicateVerdict, SignalOverlap } from "./types.js";

export type OfflineEvalResult = {
  metrics: EvalMetrics;
  samples: Awaited<ReturnType<typeof evaluate>>["samples"];
};

/** Number of recalled candidates considered per lead. */
export type OfflineEvalOptions = { topK?: number };

function termTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9._]+/u)
      .filter((t) => t.length > 2),
  );
}

function ftsOverlap(a: DatasetIssue, b: DatasetIssue): number {
  const aTok = termTokens(`${a.title} ${a.body}`);
  const bTok = termTokens(`${b.title} ${b.body}`);
  let shared = 0;
  for (const t of aTok) if (bTok.has(t)) shared += 1;
  return shared;
}

function score(
  a: DatasetIssue,
  lead: DatasetIssue,
): { overlap: SignalOverlap; fts: number } {
  const sa = extractIssueSignals({ title: a.title, body: a.body, labels: [] });
  const sl = extractIssueSignals({
    title: lead.title,
    body: lead.body,
    labels: [],
  });
  return { overlap: computeSignalOverlap(sl, sa), fts: ftsOverlap(a, lead) };
}

function offlineVerdict(candidate: {
  issueNumber: number;
  overlap: SignalOverlap;
}): FinalDuplicateVerdict {
  // Deterministic stand-in judge for the offline harness. It never reads the
  // ground-truth labels; it only uses signal overlap, so the reported metrics
  // are honest about the engine (a model-backed judge can be swapped in later).
  if (
    candidate.overlap.strongShared >= 1 &&
    candidate.overlap.sharedErrorCodes >= 1
  ) {
    return adjudicateDuplicate({
      judgment: {
        contractVersion: "duplicate-judgment/v1",
        decision: "duplicate",
        relatedIssues: [candidate.issueNumber],
        sharedSignals: ["shared error code"],
        differingSignals: [],
        confidence: 0.85,
      },
      overlap: candidate.overlap,
    });
  }
  if (candidate.overlap.strongShared >= 1) {
    return adjudicateDuplicate({
      judgment: {
        contractVersion: "duplicate-judgment/v1",
        decision: "related",
        relatedIssues: [candidate.issueNumber],
        sharedSignals: ["shared strong signal"],
        differingSignals: [],
        confidence: 0.75,
      },
      overlap: candidate.overlap,
    });
  }
  return {
    decision: "not_duplicate",
    autoAction: "none",
    confidence: 0.7,
    reason: "no strong signal overlap with the top candidate",
    relatedIssueNumbers: [],
  };
}

/**
 * Runs the evaluation machinery over the labeled dataset using a deterministic,
 * offline recall + adjudication (signal overlap + fuzzy term overlap). The
 * reported metrics are honest for the engine; a model-backed judge can be
 * substituted by replacing this stand-in with the model pipeline.
 */
export async function runOfflineEval(
  dataset: readonly DatasetEntry[],
  options: OfflineEvalOptions = {},
): Promise<OfflineEvalResult> {
  const topK = options.topK ?? 5;
  const deps = {
    recall: async (sample: EvalSample): Promise<readonly number[]> => {
      const entry = dataset.find((d) => d.id === sample.id);
      if (!entry) return [];
      const lead = leadOf(entry);
      const scored = entry.corpus
        .filter((c) => c.issueNumber !== lead.issueNumber)
        .map((c) => ({ c, ...score(c, lead) }))
        .sort(
          (a, b) =>
            b.overlap.strongShared - a.overlap.strongShared || b.fts - a.fts,
        )
        .slice(0, topK);
      return scored.map((s) => s.c.issueNumber);
    },
    adjudicate: async (
      sample: EvalSample,
      recalledNumbers: readonly number[],
    ): Promise<FinalDuplicateVerdict | null> => {
      const entry = dataset.find((d) => d.id === sample.id);
      if (!entry) return null;
      const lead = leadOf(entry);
      const ranking = recalledNumbers
        .map((n) => entry.corpus.find((c) => c.issueNumber === n))
        .filter((c): c is DatasetIssue => Boolean(c))
        .map((c) => ({ c, ...score(c, lead) }))
        .sort(
          (a, b) =>
            b.overlap.strongShared - a.overlap.strongShared || b.fts - a.fts,
        );
      const best = ranking[0];
      if (!best) {
        return {
          decision: "not_duplicate",
          autoAction: "none",
          confidence: 0.5,
          reason: "no candidates recalled",
          relatedIssueNumbers: [],
        };
      }
      return offlineVerdict({
        issueNumber: best.c.issueNumber,
        overlap: best.overlap,
      });
    },
  };
  return evaluate(dataset, deps);
}
