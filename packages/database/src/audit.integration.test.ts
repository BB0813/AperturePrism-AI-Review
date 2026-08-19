import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./index.js";
import { listAuditLogs, writeAuditLog } from "./audit.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("audit log PostgreSQL integration", () => {
  let client: DatabaseClient;
  const marker = Math.random().toString(36).slice(2, 8);

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    const pattern = `e2e-${marker}%`;
    await client.sql`delete from audit_logs where action like ${pattern}`;
    await client.close();
  });

  it("writes and lists an audit entry newest-first", async () => {
    await writeAuditLog(client.db, {
      actor: "e2e-user",
      action: `e2e-${marker}-set_admin`,
      target: "someone",
      detail: { isAdmin: true },
      ip: "127.0.0.1",
    });

    const rows = await listAuditLogs(client.db, { limit: 50 });
    const entry = rows.find((row) => row.action === `e2e-${marker}-set_admin`);
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe("e2e-user");
    expect(entry?.target).toBe("someone");
    expect(entry?.detail).toEqual({ isAdmin: true });
    expect(entry?.ip).toBe("127.0.0.1");
    expect(entry?.createdAt).toBeInstanceOf(Date);
  });

  it("orders newest first and honours limit/offset", async () => {
    await writeAuditLog(client.db, {
      actor: "e2e-user",
      action: `e2e-${marker}-older`,
      ip: "127.0.0.1",
    });
    const first = await listAuditLogs(client.db, { limit: 1 });
    expect(first.length).toBe(1);
    // The entry written just now must be the most recent of the two markers.
    const later = await listAuditLogs(client.db, { limit: 10, offset: 0 });
    const newerIdx = later.findIndex((r) => r.action === `e2e-${marker}-older`);
    const olderIdx = later.findIndex((r) => r.action === `e2e-${marker}-set_admin`);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});
