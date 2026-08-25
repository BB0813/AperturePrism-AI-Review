import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { deleteSetting, putSetting } from "./settings-store.js";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * 密钥轮换（回滚窗口）。
 *
 * 覆盖某个密钥时把旧值暂存为轮换元数据，24 小时内清空/回滚可恢复旧值 —— 换
 * 错新密钥不必回退整个部署。元数据存在同一张 system_settings 表（伪键
 * `_rotation:<key>`），零 schema 变更；过期后自动清理。
 */

/** 默认回滚窗口：24 小时。 */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1_000;
export const ROTATION_KEY_PREFIX = "_rotation:";

export type RotationMeta = {
  /** 旧值（与库内原表示一致：secret 为密文或原文）。 */
  value: string;
  rotatedAt: string;
  expiresAt: string;
};

export type RotationInfo = {
  hasPrevious: boolean;
  rotatedAt: string | null;
  previousExpiresAt: string | null;
};

export function rotationKeyFor(key: string): string {
  return `${ROTATION_KEY_PREFIX}${key}`;
}

export function isRotationKey(key: string): boolean {
  return key.startsWith(ROTATION_KEY_PREFIX);
}

/** 纯函数：构造轮换元数据（便于单测）。 */
export function buildRotationMeta(
  previousValue: string,
  now: Date = new Date(),
  graceMs: number = ROTATION_GRACE_MS,
): RotationMeta {
  return {
    value: previousValue,
    rotatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + graceMs).toISOString(),
  };
}

/** 纯函数：解析轮换元数据；缺失或非法 JSON 视为不存在。 */
export function parseRotationMeta(
  raw: string | null | undefined,
): RotationMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RotationMeta>;
    if (
      typeof parsed.value !== "string" ||
      typeof parsed.rotatedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return parsed as RotationMeta;
  } catch {
    return null;
  }
}

/** 纯函数：是否已过回滚窗口。 */
export function isRotationExpired(
  meta: RotationMeta,
  now: Date = new Date(),
): boolean {
  return new Date(meta.expiresAt).getTime() <= now.getTime();
}

/** 读取轮换信息；元数据过期时顺带清理，视为无。 */
export async function rotationInfo(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<RotationInfo> {
  const rows = await db
    .select({ value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, rotationKeyFor(key)))
    .limit(1);
  const meta = parseRotationMeta(rows[0]?.value);
  if (!meta)
    return { hasPrevious: false, rotatedAt: null, previousExpiresAt: null };
  if (isRotationExpired(meta, now)) {
    await deleteSetting(db, rotationKeyFor(key));
    return { hasPrevious: false, rotatedAt: null, previousExpiresAt: null };
  }
  return {
    hasPrevious: true,
    rotatedAt: meta.rotatedAt,
    previousExpiresAt: meta.expiresAt,
  };
}

/**
 * 消费侧轮换回退：读取宽限期内暂存的旧值（过期视为无，并顺带清理）。
 * 供「新密钥先验签/交换，失败再退旧值」的双密钥接收使用。
 */
export async function readPreviousValueWithinGrace(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<string | null> {
  const rows = await db
    .select({ value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, rotationKeyFor(key)))
    .limit(1);
  const meta = parseRotationMeta(rows[0]?.value);
  if (!meta) return null;
  if (isRotationExpired(meta, now)) {
    await deleteSetting(db, rotationKeyFor(key));
    return null;
  }
  return meta.value;
}

/** 覆盖密钥时把旧值暂存为轮换元数据；返回是否发生了轮换。 */
export async function putSettingWithRotation(
  db: Database,
  key: string,
  value: string,
  now: Date = new Date(),
  graceMs: number = ROTATION_GRACE_MS,
): Promise<{ rotated: boolean }> {
  const rows = await db
    .select({ value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, key))
    .limit(1);
  const current = rows[0]?.value;
  let rotated = false;
  // 仅当用「不同的新值」覆盖「已存在的旧值」才需要回滚窗口；首写不轮换。
  if (current !== undefined && current !== value) {
    const meta = buildRotationMeta(current, now, graceMs);
    await db
      .insert(schema.systemSettings)
      .values({ key: rotationKeyFor(key), value: JSON.stringify(meta) })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: { value: JSON.stringify(meta), updatedAt: new Date() },
      });
    rotated = true;
  }
  await putSetting(db, key, value);
  return { rotated };
}

/** 清空密钥：宽限期内回滚到旧值；否则普通删除并清理残留元数据。 */
export async function clearSettingWithRotation(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<{ rolledBack: boolean }> {
  const rows = await db
    .select({ value: schema.systemSettings.value })
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.key, rotationKeyFor(key)))
    .limit(1);
  const meta = parseRotationMeta(rows[0]?.value);
  if (meta && !isRotationExpired(meta, now)) {
    await putSetting(db, key, meta.value);
    await deleteSetting(db, rotationKeyFor(key));
    return { rolledBack: true };
  }
  await deleteSetting(db, key);
  await deleteSetting(db, rotationKeyFor(key));
  return { rolledBack: false };
}
