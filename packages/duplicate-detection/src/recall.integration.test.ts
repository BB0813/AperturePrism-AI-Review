import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  extractIssueSignals,
  indexIssueDocument,
  recallCandidates,
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
});
