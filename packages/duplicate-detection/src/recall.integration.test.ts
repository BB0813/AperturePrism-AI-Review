import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  EMBEDDING_DIMENSION,
  extractIssueSignals,
  indexIssueDocument,
  recallCandidates,
  recallCandidatesByVector,
  type SqlTag,
} from "./index.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("duplicate recall PostgreSQL integration", () => {
  let client: DatabaseClient;
  const prefix = `m6-recall-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql`delete from issue_documents where title like ${`${prefix}%`}`;
    await client.close();
  });

  async function index(title: string, body: string, issueNumber: number) {
    await indexIssueDocument(client.sql as unknown as SqlTag, {
      repositoryId: null,
      issueNumber,
      title,
      body,
      signals: extractIssueSignals({ title, body, labels: [] }),
    });
  }

  it("recalls a matching candidate by shared error code and full text", async () => {
    await index(
      `${prefix}-a`,
      "Application crashes with HTTP_511 when calling the api module on startup",
      1,
    );
    await index(
      `${prefix}-b`,
      "a small typo in the project readme documentation",
      2,
    );

    const lead = extractIssueSignals({
      title: "crash module",
      body: "HTTP_511 at api startup",
      labels: [],
    });
    const rows = await recallCandidates({
      sql: client.sql as unknown as SqlTag,
      leadTitle: "crash module",
      leadBody: "HTTP_511 at api startup",
      leadSignals: lead,
      topK: 10,
    });

    const hit = rows.find((r) => r.issueNumber === 1);
    expect(hit).toBeDefined();
    expect(hit?.ftsRank).toBeGreaterThan(0);
    // the unrelated document must not surface as a strong signal match
    const unrelated = rows.find((r) => r.issueNumber === 2);
    expect(unrelated?.signalRank ?? 0).toBe(0);
  });

  it("returns no candidates when nothing matches", async () => {
    const lead = extractIssueSignals({
      title: "zzzz no such thing",
      body: "unrelated gibberish xyzzy",
      labels: [],
    });
    const rows = await recallCandidates({
      sql: client.sql as unknown as SqlTag,
      leadTitle: "zzzz no such thing",
      leadBody: "unrelated gibberish xyzzy",
      leadSignals: lead,
      topK: 10,
    });
    expect(rows).toHaveLength(0);
  });

  function embedding(seed: number): number[] {
    return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) =>
      i === 0 ? seed : 0,
    );
  }

  it("recalls the nearest vector by exact cosine distance", async () => {
    await indexIssueDocument(client.sql as unknown as SqlTag, {
      repositoryId: null,
      issueNumber: 3,
      title: `${prefix}-vnear`,
      body: "",
      signals: extractIssueSignals({ title: "near", body: "same", labels: [] }),
      embedding: embedding(1),
    });
    await indexIssueDocument(client.sql as unknown as SqlTag, {
      repositoryId: null,
      issueNumber: 4,
      title: `${prefix}-vfar`,
      body: "",
      signals: extractIssueSignals({ title: "far", body: "other", labels: [] }),
      embedding: embedding(-1),
    });

    const rows = await recallCandidatesByVector({
      sql: client.sql as unknown as SqlTag,
      embedding: embedding(1),
      topK: 2,
    });
    expect(rows[0]?.issueNumber).toBe(3);
    expect(rows[0]?.distance).toBeLessThan(rows[1]?.distance ?? 2);
  });
});
