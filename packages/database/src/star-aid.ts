import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type StarAidAccount = {
  id: string;
  login: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** An account plus its per-account target / already-starred counts. */
export type StarAidAccountWithStats = StarAidAccount & {
  targetCount: number;
  starredCount: number;
};

export type StarAidTarget = {
  id: string;
  accountId: string;
  fullName: string;
  description: string;
  starred: boolean;
  starredAt: Date | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const accountColumns = {
  id: schema.starAidAccounts.id,
  login: schema.starAidAccounts.login,
  enabled: schema.starAidAccounts.enabled,
  createdAt: schema.starAidAccounts.createdAt,
  updatedAt: schema.starAidAccounts.updatedAt,
} as const;

const targetColumns = {
  id: schema.starAidTargets.id,
  accountId: schema.starAidTargets.accountId,
  fullName: schema.starAidTargets.fullName,
  description: schema.starAidTargets.description,
  starred: schema.starAidTargets.starred,
  starredAt: schema.starAidTargets.starredAt,
  lastError: schema.starAidTargets.lastError,
  lastCheckedAt: schema.starAidTargets.lastCheckedAt,
  createdAt: schema.starAidTargets.createdAt,
  updatedAt: schema.starAidTargets.updatedAt,
} as const;

/**
 * Registers a star-aid GitHub account (token already sealed). No-op when the
 * login already exists; returns the created row or null on conflict.
 */
export async function createStarAidAccount(
  db: Database,
  input: { login: string; encryptedToken: string },
): Promise<StarAidAccount | null> {
  const rows = await db
    .insert(schema.starAidAccounts)
    .values({
      login: input.login.trim(),
      encryptedToken: input.encryptedToken,
    })
    .onConflictDoNothing({ target: schema.starAidAccounts.login })
    .returning(accountColumns);
  const row = rows[0];
  return row ?? null;
}

/** Enables/disables an account; returns the updated row or null. */
export async function updateStarAidAccountEnabled(
  db: Database,
  id: string,
  enabled: boolean,
): Promise<StarAidAccount | null> {
  const rows = await db
    .update(schema.starAidAccounts)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(schema.starAidAccounts.id, id))
    .returning(accountColumns);
  const row = rows[0];
  return row ?? null;
}

/** Lists star-aid accounts with per-account target and starred counts. */
export async function listStarAidAccounts(
  db: Database,
): Promise<StarAidAccountWithStats[]> {
  const rows = await db
    .select({
      ...accountColumns,
      targetCount: sql<number>`count(${schema.starAidTargets.id})::int`,
      starredCount: sql<number>`count(*) FILTER (WHERE ${schema.starAidTargets.starred} = true)::int`,
    })
    .from(schema.starAidAccounts)
    .leftJoin(
      schema.starAidTargets,
      eq(schema.starAidTargets.accountId, schema.starAidAccounts.id),
    )
    .groupBy(schema.starAidAccounts.id)
    .orderBy(asc(schema.starAidAccounts.login));
  return rows.map((row) => ({
    id: row.id,
    login: row.login,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    targetCount: Number(row.targetCount),
    starredCount: Number(row.starredCount),
  }));
}

/** Deletes an account; its targets cascade. Returns whether a row was removed. */
export async function deleteStarAidAccount(
  db: Database,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.starAidAccounts)
    .where(eq(schema.starAidAccounts.id, id))
    .returning({ id: schema.starAidAccounts.id });
  return deleted.length > 0;
}

/**
 * Adds a target repo to an account. No-op when the (account, full_name) pair
 * already exists; returns the created row or null on conflict.
 */
export async function addStarAidTarget(
  db: Database,
  input: {
    accountId: string;
    fullName: string;
    description: string;
  },
): Promise<StarAidTarget | null> {
  const rows = await db
    .insert(schema.starAidTargets)
    .values({
      accountId: input.accountId,
      fullName: input.fullName.trim(),
      description: input.description,
    })
    .onConflictDoNothing({
      target: [
        schema.starAidTargets.accountId,
        schema.starAidTargets.fullName,
      ],
    })
    .returning(targetColumns);
  const row = rows[0];
  return row ?? null;
}

/** Lists star-aid targets, optionally scoped to one account. */
export async function listStarAidTargets(
  db: Database,
  options: { accountId?: string | undefined } = {},
): Promise<StarAidTarget[]> {
  const rows = await db
    .select(targetColumns)
    .from(schema.starAidTargets)
    .where(
      options.accountId === undefined
        ? undefined
        : eq(schema.starAidTargets.accountId, options.accountId),
    )
    .orderBy(asc(schema.starAidTargets.fullName));
  return rows;
}

/** Deletes a single target; returns whether a row was actually removed. */
export async function deleteStarAidTarget(
  db: Database,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.starAidTargets)
    .where(eq(schema.starAidTargets.id, id))
    .returning({ id: schema.starAidTargets.id });
  return deleted.length > 0;
}

/**
 * Targets still awaiting a star, belonging to enabled accounts. Oldest first
 * so the sweep visits them in insertion order.
 */
export async function listPendingStarTargets(
  db: Database,
): Promise<StarAidTarget[]> {
  const rows = await db
    .select(targetColumns)
    .from(schema.starAidTargets)
    .innerJoin(
      schema.starAidAccounts,
      eq(schema.starAidAccounts.id, schema.starAidTargets.accountId),
    )
    .where(
      and(
        eq(schema.starAidAccounts.enabled, true),
        eq(schema.starAidTargets.starred, false),
      ),
    )
    .orderBy(asc(schema.starAidTargets.createdAt), asc(schema.starAidTargets.id));
  return rows;
}

/** Marks a target as starred (records the timestamp). */
export async function markTargetStarred(
  db: Database,
  id: string,
): Promise<void> {
  await db
    .update(schema.starAidTargets)
    .set({
      starred: true,
      starredAt: new Date(),
      lastError: null,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.starAidTargets.id, id));
}

/** Records a failed star attempt; keeps `starred` false for a later retry. */
export async function markTargetError(
  db: Database,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(schema.starAidTargets)
    .set({
      lastError: error.slice(0, 1000),
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.starAidTargets.id, id));
}

/** Overall star-aid tallies: account / target / already-starred counts. */
export async function getStarAidSummary(db: Database): Promise<{
  accounts: number;
  targets: number;
  starred: number;
}> {
  const rows = await db
    .select({
      accounts: sql<number>`count(DISTINCT ${schema.starAidAccounts.id})::int`,
      targets: sql<number>`count(${schema.starAidTargets.id})::int`,
      starred: sql<number>`count(*) FILTER (WHERE ${schema.starAidTargets.starred} = true)::int`,
    })
    .from(schema.starAidAccounts)
    .leftJoin(
      schema.starAidTargets,
      eq(schema.starAidTargets.accountId, schema.starAidAccounts.id),
    );
  const row = rows[0];
  return {
    accounts: Number(row?.accounts ?? 0),
    targets: Number(row?.targets ?? 0),
    starred: Number(row?.starred ?? 0),
  };
}
