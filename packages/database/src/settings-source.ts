/**
 * 设置取值的优先级规则（纯逻辑，不依赖 drizzle，便于单测）。
 */

/**
 * 生效值的来源。用户此前无法分辨「我改的到底生效没、现在这个值是谁给的」，
 * 这是本次交互改造要回答的核心问题。
 */
export type SettingSource = "database" | "env" | "default";

/**
 * 三层取值：数据库覆盖 → env 兜底 → 应用默认。
 *
 * 空串按「没有覆盖」处理：现存读取点用的都是 `||`（如
 * `runtimeSettings.get(x) || config.y`），空串会穿透到 env —— 这里保持同样语义，
 * 否则「保存了一个空值」会意外变成「关闭该功能」而不是「回到 env」。
 *
 * 仓库级覆盖是更外面的一层，由 repository-settings 负责，不在这里混进来。
 */
export function resolveSettingValue(input: {
  dbValue: string | undefined;
  envValue: string | undefined;
}): { value: string | undefined; source: SettingSource } {
  const db = input.dbValue?.trim();
  if (db !== undefined && db.length > 0)
    return { value: input.dbValue, source: "database" };
  const env = input.envValue?.trim();
  if (env !== undefined && env.length > 0)
    return { value: input.envValue, source: "env" };
  return { value: undefined, source: "default" };
}
