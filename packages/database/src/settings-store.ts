import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * `system_settings` 的统一读取层。
 *
 * 此前 6 个进程各写一套查询：api 45 处、analysis-worker 21、index-worker 15、
 * scan-worker 8、qq-bot 8，其中 scanGloballyEnabled() 在 api 与 scan-worker 逐字
 * 重复，embedding 与 QQ 的合并逻辑各写两遍且校验规则不同。收敛到这里之后，
 * 「读哪些键、失败怎么退」只有一处实现。
 *
 * 解析与默认值不在这里，而在 config 包的 settings-registry —— 那边零 drizzle
 * 依赖，便于单测与前端共用。
 */

/** 读取指定键的原始字符串值；不存在的键不出现在 Map 里。 */
export async function loadSettings(
  db: Database,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({
      key: schema.systemSettings.key,
      value: schema.systemSettings.value,
    })
    .from(schema.systemSettings)
    .where(inArray(schema.systemSettings.key, [...keys]));
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** 写入或更新一个设置键。 */
export async function putSetting(
  db: Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(schema.systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.systemSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** 删除一个设置键的覆盖，使其回落到 env / 应用默认。 */
export async function deleteSetting(
  db: Database,
  key: string,
): Promise<void> {
  await db
    .delete(schema.systemSettings)
    .where(inArray(schema.systemSettings.key, [key]));
}

