import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type UserRow = {
  login: string;
  displayName: string;
  isAdmin: boolean;
  /** 只读操作员：可查看，禁止写操作。 */
  isReadOnly: boolean;
};

const USER_COLUMNS = {
  login: schema.users.login,
  displayName: schema.users.displayName,
  isAdmin: schema.users.isAdmin,
  isReadOnly: schema.users.isReadOnly,
} as const;

function toRow(row: {
  login: string;
  displayName: string;
  isAdmin: boolean;
  isReadOnly: boolean;
}): UserRow {
  return {
    login: row.login,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    isReadOnly: row.isReadOnly,
  };
}

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
    .select(USER_COLUMNS)
    .from(schema.users)
    .where(eq(schema.users.login, login))
    .limit(1);
  const row = rows[0];
  return row ? toRow(row) : null;
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
    .returning(USER_COLUMNS);
  const row = updated[0];
  return row ? toRow(row) : null;
}

/**
 * 更新用户的角色位：管理员 / 只读操作员。两者正交（只读且管理员 = 管理员，
 * 但仍建议 UI 上互斥）。未提供的字段保持不变。
 */
export async function setUserRoles(
  db: Database,
  login: string,
  roles: { isAdmin?: boolean; isReadOnly?: boolean },
): Promise<UserRow | null> {
  const updated = await db
    .update(schema.users)
    .set({ ...roles, updatedAt: new Date() })
    .where(eq(schema.users.login, login))
    .returning(USER_COLUMNS);
  const row = updated[0];
  return row ? toRow(row) : null;
}

/** 兼容旧调用：单独升降管理员位。 */
export async function setAdmin(
  db: Database,
  login: string,
  isAdmin: boolean,
): Promise<UserRow | null> {
  return setUserRoles(db, login, { isAdmin });
}

/** Lists known users. */
export async function listUsers(db: Database): Promise<UserRow[]> {
  const rows = await db
    .select(USER_COLUMNS)
    .from(schema.users)
    .orderBy(asc(schema.users.login));
  return rows.map(toRow);
}
