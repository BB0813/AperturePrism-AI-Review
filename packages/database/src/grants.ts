import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export type RepoGrantAccess = "view" | "manage";

export type RepoGrantRow = {
  userLogin: string;
  repositoryId: string;
  access: RepoGrantAccess;
};

const GRANT_COLUMNS = {
  userLogin: schema.repositoryGrants.userLogin,
  repositoryId: schema.repositoryGrants.repositoryId,
  access: schema.repositoryGrants.access,
} as const;

/** 设置（或更新）某用户对某仓库的授权。返回该授权行。 */
export async function setGrant(
  db: Database,
  userLogin: string,
  repositoryId: string,
  access: RepoGrantAccess,
): Promise<RepoGrantRow> {
  if (access !== "view" && access !== "manage") {
    throw new Error("grant access must be 'view' or 'manage'");
  }
  await db
    .insert(schema.repositoryGrants)
    .values({ userLogin, repositoryId, access })
    .onConflictDoUpdate({
      target: [
        schema.repositoryGrants.userLogin,
        schema.repositoryGrants.repositoryId,
      ],
      set: { access },
    });
  return { userLogin, repositoryId, access };
}

/** 移除某用户对某仓库的授权。返回是否命中。 */
export async function deleteGrant(
  db: Database,
  userLogin: string,
  repositoryId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schema.repositoryGrants)
    .where(
      and(
        eq(schema.repositoryGrants.userLogin, userLogin),
        eq(schema.repositoryGrants.repositoryId, repositoryId),
      ),
    )
    .returning({ userLogin: schema.repositoryGrants.userLogin });
  return deleted.length > 0;
}

/** 某用户被授权的仓库 id 集及其 access 等级。 */
export async function listGrantsForUser(
  db: Database,
  userLogin: string,
): Promise<RepoGrantRow[]> {
  const rows = await db
    .select(GRANT_COLUMNS)
    .from(schema.repositoryGrants)
    .where(eq(schema.repositoryGrants.userLogin, userLogin))
    .orderBy(asc(schema.repositoryGrants.repositoryId));
  return rows;
}

/** 校验用户对某仓库是否满足指定访问等级。返回布尔。 */
export async function canAccessGrant(
  db: Database,
  userLogin: string,
  repositoryId: string,
  need: RepoGrantAccess,
): Promise<boolean> {
  const rows = await db
    .select(GRANT_COLUMNS)
    .from(schema.repositoryGrants)
    .where(
      and(
        eq(schema.repositoryGrants.userLogin, userLogin),
        eq(schema.repositoryGrants.repositoryId, repositoryId),
      ),
    )
    .limit(1);
  const grant = rows[0];
  if (!grant) return false;
  if (need === "view") return true; // 任何授权都满足 view
  return grant.access === "manage";
}

/** admin：列出全部授权（可带用户名/仓库筛选）。 */
export async function listAllGrants(
  db: Database,
  opts: { userLogin?: string; repositoryId?: string } = {},
): Promise<RepoGrantRow[]> {
  const conditions = [];
  if (opts.userLogin)
    conditions.push(eq(schema.repositoryGrants.userLogin, opts.userLogin));
  if (opts.repositoryId)
    conditions.push(
      eq(schema.repositoryGrants.repositoryId, opts.repositoryId),
    );
  const rows =
    conditions.length > 0
      ? await db
          .select(GRANT_COLUMNS)
          .from(schema.repositoryGrants)
          .where(and(...conditions))
          .orderBy(asc(schema.repositoryGrants.userLogin))
      : await db
          .select(GRANT_COLUMNS)
          .from(schema.repositoryGrants)
          .orderBy(asc(schema.repositoryGrants.userLogin));
  return rows;
}