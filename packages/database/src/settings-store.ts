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

/** 读取全部设置行（api 的运行时缓存与备份导出需要全量）。 */
export async function loadAllSettings(
  db: Database,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      key: schema.systemSettings.key,
      value: schema.systemSettings.value,
    })
    .from(schema.systemSettings);
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

export type SettingsCache = {
  /** 最近一次成功读取的全量设置。 */
  get: (key: string) => string | undefined;
  /** 立即重新读取一次；失败时保留上一次的快照。 */
  refresh: () => Promise<void>;
  /** 停止周期刷新。 */
  stop: () => void;
};

/**
 * 周期刷新的设置缓存，替代各进程自建的轮询。
 *
 * 读失败时**保留**上一次快照而不是清空：一次数据库抖动不该让整个进程突然以为
 * 所有设置都没配（api 原有实现也是这个语义，这里保持）。
 */
export function createSettingsCache(
  db: Database,
  options: {
    intervalMs: number;
    onError?: (error: unknown) => void;
    onRefresh?: (settings: Map<string, string>) => void;
  },
): SettingsCache {
  let snapshot = new Map<string, string>();
  const refresh = async (): Promise<void> => {
    try {
      const next = await loadAllSettings(db);
      snapshot = next;
      options.onRefresh?.(next);
    } catch (error) {
      options.onError?.(error);
    }
  };
  const timer = setInterval(() => void refresh(), options.intervalMs);
  // 别让刷新定时器把进程钉住不退出。
  timer.unref?.();
  return {
    get: (key) => snapshot.get(key),
    refresh,
    stop: () => clearInterval(timer),
  };
}
