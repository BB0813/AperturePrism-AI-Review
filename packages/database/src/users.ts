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
  /** 本地密码哈希；undefined = 非本地账号。 */
  passwordHash: string | null;
  /** 本地账号是否已设置密码（可复用于判断可用密码登录）。 */
  hasPassword: boolean;
};

const USER_COLUMNS = {
  login: schema.users.login,
  displayName: schema.users.displayName,
  isAdmin: schema.users.isAdmin,
  isReadOnly: schema.users.isReadOnly,
  passwordHash: schema.users.passwordHash,
} as const;

function toRow(row: {
  login: string;
  displayName: string;
  isAdmin: boolean;
  isReadOnly: boolean;
  passwordHash: string | null;
}): UserRow {
  return {
    login: row.login,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    isReadOnly: row.isReadOnly,
    passwordHash: row.passwordHash,
    hasPassword: row.passwordHash !== null && row.passwordHash.length > 0,
  };
}

/** 密码哈希不在任何列表/查询结果中意外泄漏给前端（读取时显式不返回原文哈希）。 */
function publicUser(row: UserRow): Omit<UserRow, "passwordHash"> & {
  passwordHash?: never;
} {
  return {
    login: row.login,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    isReadOnly: row.isReadOnly,
    hasPassword: row.hasPassword,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

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

/** 仅返回可安全暴露给前端的用户字段（不含 passwordHash）。 */
export function toPublicUsers(rows: UserRow[]): PublicUser[] {
  return rows.map(publicUser);
}

export function toPublicUser(row: UserRow | null): PublicUser | null {
  return row ? publicUser(row) : null;
}

/** 为本地账号设置密码哈希；OAuth-only 用户也可借此开通本地登录。 */
export async function setPassword(
  db: Database,
  login: string,
  passwordHash: string,
): Promise<boolean> {
  const updated = await db
    .update(schema.users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(schema.users.login, login))
    .returning({ id: schema.users.id });
  return updated.length > 0;
}

/** 记录最近登录时间（不阻塞，供审计/会话展示）。 */
export async function setLastLogin(
  db: Database,
  login: string,
): Promise<void> {
  await db
    .update(schema.users)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.users.login, login));
}

/**
 * 判断是否需要进行本地账号引导：没有任何 isAdmin 的本地（设置了密码）用户时
 * 返回 true（此时 `/auth/register` 开放，创建首个本地管理员）。
 */
export async function needsPasswordBootstrap(db: Database): Promise<boolean> {
  const rows = await db
    .select(USER_COLUMNS)
    .from(schema.users)
    .where(eq(schema.users.isAdmin, true));
  return !rows.some(
    (row) =>
      row.passwordHash !== null && row.passwordHash.length > 0,
  );
}
