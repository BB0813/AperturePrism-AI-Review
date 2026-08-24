/**
 * 备份导出的脱敏规则（纯逻辑，不依赖数据库，便于单测）。
 *
 * 之前用的是「密钥黑名单」，只列了 webui_api_token 与 github_webhook_secret，
 * 于是 oauth_client_secret / embedding_api_key / qq_official_app_secret /
 * qq_bot_protocols（内含 accessToken）/ github_app_private_key 全都被明文导出，
 * 而导出界面还写着「密钥值已脱敏」—— 用户会把它当安全文件传播。
 *
 * 改成白名单（默认拒绝）：新增的键默认只导出「是否已配置」，不会再因为忘记登记
 * 而泄露。动态键（如 pr_review_history:* 可能含模型对话内容）天然落在白名单外。
 */

/** 允许导出明文值的设置键：确定无敏感信息、且恢复时确实有用的运行时开关。 */
export const NON_SECRET_EXPORTABLE_KEYS = new Set([
  "github_webhook_enabled",
  "log_level",
  "spam_handling",
  "issue_auto_assign",
  "issue_assignee",
  "issue_rewrite_title",
  "issue_deep_analysis",
  "issue_reanalyze_min_change",
  "pr_check_run",
  "pr_auto_review",
  "embedding_base_url",
  "embedding_model",
  "oauth_client_id",
  "github_app_id",
  "agent_team_enabled",
  "scan_enabled",
]);

/**
 * 一条设置在备份里应有的形态。`value: null` 表示「已脱敏或未登记」，配合
 * `hasValue` 让界面能如实说明「这项已配置，但值不在备份里，需手工重填」。
 */
export function redactBackupSetting(row: {
  key: string;
  value: string;
}): { key: string; value: string | null; hasValue: boolean } {
  return {
    key: row.key,
    value: NON_SECRET_EXPORTABLE_KEYS.has(row.key) ? row.value : null,
    hasValue: row.value.trim().length > 0,
  };
}
