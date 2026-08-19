import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import {
  addStarAidTarget,
  createStarAidAccount,
  deleteStarAidAccount,
  deleteStarAidTarget,
  getStarAidSummary,
  listStarAidAccounts,
  listStarAidTargets,
  markTargetError,
  markTargetStarred,
  updateStarAidAccountEnabled,
} from "../../../packages/database/src/star-aid.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("star-aid PostgreSQL integration", () => {
  let client: DatabaseClient;
  const marker = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const encrypted = `sealed.${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
  });

  afterAll(async () => {
    if (!client) return;
    const pattern = `${marker}%`;
    await client.sql`delete from star_aid_accounts where login like ${pattern}`;
    await client.close();
  });

  it("creates an account and is idempotent by login", async () => {
    const login = `${marker}-a1`;
    const created = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(created?.login).toBe(login);
    expect(created?.enabled).toBe(true);
    expect(created?.id.length).toBeGreaterThan(0);

    const dup = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(dup).toBeNull();
  });

  it("lists accounts with zero target/starred counts", async () => {
    const login = `${marker}-a2`;
    await createStarAidAccount(client.db, { login, encryptedToken: encrypted });
    const rows = await listStarAidAccounts(client.db);
    const mine = rows.find((row) => row.login === login);
    expect(mine).toBeDefined();
    expect(mine?.targetCount).toBe(0);
    expect(mine?.starredCount).toBe(0);
  });

  it("enables and disables an account", async () => {
    const login = `${marker}-a3`;
    const created = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(created).not.toBeNull();
    const disabled = await updateStarAidAccountEnabled(
      client.db,
      created!.id,
      false,
    );
    expect(disabled?.enabled).toBe(false);
    const reenabled = await updateStarAidAccountEnabled(
      client.db,
      created!.id,
      true,
    );
    expect(reenabled?.enabled).toBe(true);
  });

  it("adds targets scoped to an account and lists them", async () => {
    const login = `${marker}-a4`;
    const account = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(account).not.toBeNull();
    const accountId = account!.id;

    const target = await addStarAidTarget(client.db, {
      accountId,
      fullName: "o/r",
      description: "desc",
    });
    expect(target?.fullName).toBe("o/r");
    expect(target?.description).toBe("desc");
    expect(target?.starred).toBe(false);

    const dup = await addStarAidTarget(client.db, {
      accountId,
      fullName: "o/r",
      description: "desc2",
    });
    expect(dup).toBeNull();

    const scoped = await listStarAidTargets(client.db, { accountId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.fullName).toBe("o/r");
    expect(scoped[0]?.description).toBe("desc");

    const all = await listStarAidTargets(client.db);
    expect(all.some((t) => t.accountId === accountId)).toBe(true);
  });

  it("marks a target starred and records errors", async () => {
    const login = `${marker}-a5`;
    const account = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(account).not.toBeNull();
    const accountId = account!.id;
    const target = await addStarAidTarget(client.db, {
      accountId,
      fullName: "o/r2",
      description: "",
    });
    expect(target).not.toBeNull();
    const targetId = target!.id;

    await markTargetError(client.db, targetId, "boom");
    let row = (await listStarAidTargets(client.db, { accountId })).find(
      (t) => t.id === targetId,
    );
    expect(row?.lastError).toBe("boom");
    expect(row?.starred).toBe(false);

    await markTargetStarred(client.db, targetId);
    row = (await listStarAidTargets(client.db, { accountId })).find(
      (t) => t.id === targetId,
    );
    expect(row?.starred).toBe(true);
    expect(row?.starredAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });

  it("reports the summary tallies", async () => {
    const login = `${marker}-sum`;
    const account = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(account).not.toBeNull();
    const target = await addStarAidTarget(client.db, {
      accountId: account!.id,
      fullName: "o/sum",
      description: "",
    });
    expect(target).not.toBeNull();
    await markTargetStarred(client.db, target!.id);

    const summary = await getStarAidSummary(client.db);
    expect(summary.accounts).toBeGreaterThanOrEqual(1);
    expect(summary.targets).toBeGreaterThanOrEqual(1);
    expect(summary.starred).toBeGreaterThanOrEqual(1);
  });

  it("deletes targets and cascades on account delete", async () => {
    const login = `${marker}-del`;
    const account = await createStarAidAccount(client.db, {
      login,
      encryptedToken: encrypted,
    });
    expect(account).not.toBeNull();
    const accountId = account!.id;

    const target = await addStarAidTarget(client.db, {
      accountId,
      fullName: "o/r3",
      description: "",
    });
    expect(target).not.toBeNull();
    expect(await deleteStarAidTarget(client.db, target!.id)).toBe(true);
    expect(await deleteStarAidTarget(client.db, target!.id)).toBe(false);

    await addStarAidTarget(client.db, {
      accountId,
      fullName: "o/r4",
      description: "",
    });
    expect(await deleteStarAidAccount(client.db, accountId)).toBe(true);
    expect(await deleteStarAidAccount(client.db, accountId)).toBe(false);
    const scoped = await listStarAidTargets(client.db, { accountId });
    expect(scoped).toHaveLength(0);
  });
});
