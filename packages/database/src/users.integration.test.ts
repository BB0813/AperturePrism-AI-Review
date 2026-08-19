import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./index.js";
import {
  ensureUser,
  getUser,
  listUsers,
  updateDisplayName,
} from "./users.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("users PostgreSQL integration", () => {
  let client: DatabaseClient;
  const login = `e2e-user-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql`delete from users where login = ${login}`;
    await client.close();
  });

  it("creates a user on first login and is idempotent afterwards", async () => {
    await ensureUser(client.db, login);
    await ensureUser(client.db, login);

    const user = await getUser(client.db, login);
    expect(user?.login).toBe(login);
    expect(user?.displayName).toBe("");
  });

  it("updates the display name", async () => {
    const updated = await updateDisplayName(client.db, login, "测试用户");
    expect(updated?.displayName).toBe("测试用户");

    const user = await getUser(client.db, login);
    expect(user?.displayName).toBe("测试用户");
  });

  it("lists users including the created one", async () => {
    const rows = await listUsers(client.db);
    expect(rows.some((row) => row.login === login)).toBe(true);
  });

  it("returns null for an unknown user", async () => {
    expect(await getUser(client.db, "no-such-user-xyz")).toBeNull();
  });
});
