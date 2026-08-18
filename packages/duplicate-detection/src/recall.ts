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
 * Upserts on (repositoryId, issueNumber). An optional 4096-d embedding is
 * stored for vector recall; pass null/omit to leave (or clear) it.
 */
export async function indexIssueDocument(
  sql: SqlTag,
  input: {
    repositoryId: string | null;
    issueNumber: number;
    title: string;
    body: string;
    signals: IssueSignals;
    embedding?: number[] | undefined;
  },
): Promise<void> {
  const vec =
    input.embedding === undefined || input.embedding.length === 0
      ? null
      : `[${input.embedding.join(",")}]`;

  if (vec === null) {
    // Preserve any existing embedding when reindexing without a new vector.
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
    return;
  }

  await sql`
    insert into issue_documents
      (repository_id, issue_number, title, body, versions, error_codes, paths, languages, has_stack_trace, has_reproduction, embedding)
    values
      (${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${input.body},
       ${input.signals.versions}, ${input.signals.errorCodes}, ${input.signals.paths}, ${input.signals.languages},
       ${input.signals.hasStackTrace}, ${input.signals.hasReproduction},
       ${vec}::vector)
    on conflict (repository_id, issue_number)
    do update set
      title = excluded.title, body = excluded.body,
      versions = excluded.versions, error_codes = excluded.error_codes,
      paths = excluded.paths, languages = excluded.languages,
      has_stack_trace = excluded.has_stack_trace, has_reproduction = excluded.has_reproduction,
      embedding = excluded.embedding,
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

export type VectorRecallRow = {
  id: string;
  repositoryId: string | null;
  issueNumber: number;
  /** Cosine distance (0 = identical); lower is more similar. */
  distance: number;
};

/**
 * Recalls candidates by embedding similarity using exact cosine distance
 * (`<=>`). pgvector indexes (hnsw/ivfflat) are capped at 2000 dimensions, so
 * the 4096-d nv-embed vector cannot be indexed; an exact sequential scan is
 * used instead, which is fine at typical issue-corpus sizes. Like full-text
 * recall, this only proposes candidates — it never decides a duplicate.
 */
export async function recallCandidatesByVector(input: {
  sql: SqlTag;
  embedding: number[];
  topK: number;
}): Promise<VectorRecallRow[]> {
  const vec = `[${input.embedding.join(",")}]`;
  const rows = await input.sql`
    select d.id, d.issue_number as "issueNumber", d.repository_id::text as "repositoryId",
      (d.embedding <=> ${vec}::vector) as distance
    from issue_documents d
    where d.embedding is not null
    order by distance asc
    limit ${input.topK}`;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
    issueNumber: Number(row.issueNumber ?? 0),
    distance: Number(row.distance ?? 1),
  }));
}
