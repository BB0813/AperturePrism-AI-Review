import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type UserRow = {
  login: string;
  displayName: string;
};

/** Creates the user on first OAuth login; otherwise a no-op. */
export async function ensureUser(
  db: Database,
  login: string,
): Promise<void> {
  if (login.trim().length === 0) return;
  await db
    .insert(schema.users)
    .values({ login: login.trim() })
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
    })
    .from(schema.users)
    .where(eq(schema.users.login, login))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { login: row.login, displayName: row.displayName };
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
    });
  const row = updated[0];
  if (!row) return null;
  return { login: row.login, displayName: row.displayName };
}

/** Lists known users (for a future user-management view). */
export async function listUsers(db: Database): Promise<UserRow[]> {
  const rows = await db
    .select({
      login: schema.users.login,
      displayName: schema.users.displayName,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.login));
  return rows;
}
