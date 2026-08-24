import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

export {
  isRepositorySettingKey,
  REPOSITORY_SETTING_KEYS,
  resolveSetting,
  type RepositorySettingKey,
} from "./repository-settings-keys.js";

/**
 * 某仓库的全部覆盖值。返回的 Map 只含真正覆盖了的键 —— 「没有这个键」与
 * 「这个键被设为空串」是两种不同的状态，调用方靠前者判断是否回落到全局。
 */
export async function getRepositorySettings(
  db: Database,
  repositoryId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      key: schema.repositorySettings.key,
      value: schema.repositorySettings.value,
    })
    .from(schema.repositorySettings)
    .where(eq(schema.repositorySettings.repositoryId, repositoryId));
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** 只读取需要的键，避免为一个开关拉回整仓库的覆盖表。 */
export async function getRepositorySettingsFor(
  db: Database,
  repositoryId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({
      key: schema.repositorySettings.key,
      value: schema.repositorySettings.value,
    })
    .from(schema.repositorySettings)
    .where(
      and(
        eq(schema.repositorySettings.repositoryId, repositoryId),
        inArray(schema.repositorySettings.key, [...keys]),
      ),
    );
  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * 写入或清除一个仓库级覆盖。传 null 表示「删除覆盖，跟随全局」—— 这是必须的：
 * 否则一旦设过值就再也回不到「跟随全局」，只能在仓库上硬编码一个副本。
 */
export async function setRepositorySetting(
  db: Database,
  input: { repositoryId: string; key: string; value: string | null },
): Promise<void> {
  if (input.value === null) {
    await db
      .delete(schema.repositorySettings)
      .where(
        and(
          eq(schema.repositorySettings.repositoryId, input.repositoryId),
          eq(schema.repositorySettings.key, input.key),
        ),
      );
    return;
  }
  await db
    .insert(schema.repositorySettings)
    .values({
      repositoryId: input.repositoryId,
      key: input.key,
      value: input.value,
    })
    .onConflictDoUpdate({
      target: [
        schema.repositorySettings.repositoryId,
        schema.repositorySettings.key,
      ],
      set: { value: input.value, updatedAt: new Date() },
    });
}
