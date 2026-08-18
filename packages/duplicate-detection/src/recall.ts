import type { IssueSignals } from "./types.js";

/**
 * A minimal SQL executor so this module avoids coupling to a specific driver.
 * Wraps a `postgres` `sql` tag: `sql<string[]>` where the tag is called with a
 * template literal and bound params.
 */
export type SqlTag = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>;

export type RecallCandidateRow = {
  id: string;
  repositoryId: string | null;
  issueNumber: number;
  ftsRank: number;
  signalRank: number;
};

export type RecallInput = {
  sql: SqlTag;
  /** Canonical (normalized) lead title used for full-text candidates. */
  leadTitle: string;
  leadBody: string;
  leadSignals: IssueSignals;
  topK: number;
};

/**
 * Persists a normalized issue document for later full-text / signal recall.
 * Upserts on (repositoryId, issueNumber).
 */
export async function indexIssueDocument(
  sql: SqlTag,
  input: {
    repositoryId: string | null;
    issueNumber: number;
    title: string;
    body: string;
    signals: IssueSignals;
  },
): Promise<void> {
  await sql`
    insert into issue_documents
      (repository_id, issue_number, title, body, versions, error_codes, paths, languages, has_stack_trace, has_reproduction)
    values
      (${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${input.body},
       ${input.signals.versions}, ${input.signals.errorCodes}, ${input.signals.paths}, ${input.signals.languages},
       ${input.signals.hasStackTrace}, ${input.signals.hasReproduction})
    on conflict (repository_id, issue_number)
    do update set
      title = excluded.title, body = excluded.body,
      versions = excluded.versions, error_codes = excluded.error_codes,
      paths = excluded.paths, languages = excluded.languages,
      has_stack_trace = excluded.has_stack_trace, has_reproduction = excluded.has_reproduction,
      updated_at = now()`;
}

/**
 * Recalls candidate issues by full text (tsvector @@ websearch_to_tsquery) and
 * by strong-signal overlap (error codes and module paths). Candidates are
 * ranked by full-text rank capped by the number of shared strong signals; the
 * caller still passes them through the evidence/decision layer — recall never
 * decides a duplicate.
 */
export async function recallCandidates(
  input: RecallInput,
): Promise<RecallCandidateRow[]> {
  const { sql, leadTitle, leadBody, leadSignals, topK } = input;
  const leadText = `${leadTitle} ${leadBody}`.trim();
  const rows = await sql`
    select d.id, d.repository_id::text as "repositoryId", d.issue_number as "issueNumber",
      ts_rank(to_tsvector('simple', d.body || ' ' || d.title), websearch_to_tsquery('simple', ${leadText})) as "ftsRank",
      array_length(array_cat(
        (select array_agg(x) from unnest(d.error_codes) x where x = any(${leadSignals.errorCodes})),
        (select array_agg(x) from unnest(d.paths) x where x = any(${leadSignals.paths}))
      ), 1) as "signalRank"
    from issue_documents d
    where to_tsvector('simple', d.body || ' ' || d.title) @@ websearch_to_tsquery('simple', ${leadText})
       or d.error_codes && ${leadSignals.errorCodes}
       or d.paths && ${leadSignals.paths}
    order by "ftsRank" desc
    limit ${topK}`;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
    issueNumber: Number(row.issueNumber ?? 0),
    ftsRank: Number(row.ftsRank ?? 0),
    signalRank: row.signalRank === null ? 0 : Number(row.signalRank),
  }));
}
