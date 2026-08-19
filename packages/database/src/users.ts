import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type UserRow = {
  login: string;
  displayName: string;
  isAdmin: boolean;
};

/**
 * Creates the user on first OAuth login; otherwise a no-op. The very first
 * user becomes an admin so the instance has a bootstrap administrator.
 */
export async function ensureUser(
  db: Database,
  login: string,
): Promise<void> {
  const name = login.trim();
  if (name.length === 0) return;
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.login, name))
    .limit(1);
  if (existing[0]) return;
  const count = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .limit(1);
  await db
    .insert(schema.users)
    .values({ login: name, isAdmin: count.length === 0 })
    .onConflictDoNothing({ target: schema.users.login });
}

export async function getUser(
  db: Database,
  login: string,
): Promise<UserRow | null> {
  const rows = await db
    .select({
      login: schema.users.login,
      displayName: schema.users.displayName,
      isAdmin: schema.users.isAdmin,
    })
    .from(schema.users)
    .where(eq(schema.users.login, login))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { login: row.login, displayName: row.displayName, isAdmin: row.isAdmin };
}

export async function updateDisplayName(
  db: Database,
  login: string,
  displayName: string,
): Promise<UserRow | null> {
  const updated = await db
    .update(schema.users)
    .set({ displayName: displayName.trim(), updatedAt: new Date() })
    .where(eq(schema.users.login, login))
    .returning({
      login: schema.users.login,
      displayName: schema.users.displayName,
      isAdmin: schema.users.isAdmin,
    });
  const row = updated[0];
  if (!row) return null;
  return { login: row.login, displayName: row.displayName, isAdmin: row.isAdmin };
}

/** Promotes or demotes a user; returns the updated row or null. */
export async function setAdmin(
  db: Database,
  login: string,
  isAdmin: boolean,
): Promise<UserRow | null> {
  const updated = await db
    .update(schema.users)
    .set({ isAdmin, updatedAt: new Date() })
    .where(eq(schema.users.login, login))
    .returning({
      login: schema.users.login,
      displayName: schema.users.displayName,
      isAdmin: schema.users.isAdmin,
    });
  const row = updated[0];
  if (!row) return null;
  return { login: row.login, displayName: row.displayName, isAdmin: row.isAdmin };
}

/** Lists known users. */
export async function listUsers(db: Database): Promise<UserRow[]> {
  const rows = await db
    .select({
      login: schema.users.login,
      displayName: schema.users.displayName,
      isAdmin: schema.users.isAdmin,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.login));
  return rows;
}
