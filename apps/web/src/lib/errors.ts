/**
 * 把后端返回的机器错误码翻译成用户能据此行动的说明。
 *
 * 后端的 `reason` 是稳定的机器码（qq-bot 等消费方也依赖它），因此翻译只在
 * 前端做。原始码保留在括号内：用户反馈问题时能提供准确的码，便于定位。
 */

type Explanation = {
  /** 发生了什么。 */
  message: string;
  /** 用户接下来该做什么；无明确动作时省略。 */
  action?: string;
};

const explanations: Record<string, Explanation> = {
  // 配置缺失：最常见的一类，必须指明去哪里配什么。
  github_not_configured: {
    message: "GitHub App 未配置，无法访问 GitHub。",
    action: "请前往「安装向导」填写 App ID 与私钥，或在「系统配置」中确认相关环境变量已生效。",
  },
  oauth_not_configured: {
    message: "GitHub OAuth 未配置，无法完成登录授权。",
    action: "请在「系统配置」填写 OAuth Client ID 与 Client Secret。",
  },
  master_key_missing: {
    message: "凭据主密钥缺失，无法加密或读取已保存的密钥。",
    action: "请设置 CREDENTIAL_MASTER_KEY 环境变量（32 字节 base64）后重启服务。",
  },
  webhook_secret_failed: {
    message: "Webhook 签名密钥保存失败。",
    action: "请确认主密钥已配置，然后重试保存。",
  },

  // 权限与身份
  unauthorized: {
    message: "身份未通过验证，或访问令牌已失效。",
    action: "请重新登录后再试。",
  },

  // 资源不存在
  not_found: { message: "请求的资源不存在。" },
  pull_request_not_found: {
    message: "找不到指定的 Pull Request。",
    action: "请确认编号正确，且该 PR 属于当前仓库。",
  },
  not_a_pull_request: {
    message: "该对象是 Issue 而不是 Pull Request，无法执行代码审查。",
    action: "如需分析 Issue，请改用 Issue 分析。",
  },
  repository_not_installed: {
    message: "该仓库尚未安装 GitHub App。",
    action: "请先在 GitHub 上为该仓库安装应用，再回到「已安装仓库」同步。",
  },
  missing_repository_context: {
    message: "缺少仓库上下文，无法确定操作对象。",
    action: "请从仓库列表中选择一个仓库后重试。",
  },

  // 外部服务
  rate_limited: {
    message: "已触发 GitHub 接口限流。",
    action: "请稍等几分钟后重试；频繁同步会加剧限流。",
  },
  rate_limited_until: {
    message: "GitHub 接口限流的暂停窗口尚未结束。",
    action: "请等待重置后再同步，期间同步会自动跳过。",
  },
  github_unavailable: {
    message: "GitHub 暂时不可用（网络或服务异常）。",
    action: "请稍后重试；若持续失败，请检查服务器到 GitHub 的网络。",
  },
  sync_in_progress: {
    message: "已有一次仓库同步正在进行中。",
    action: "同步完成后会自动刷新列表，无需重复点击。",
  },
  registry_unreachable: {
    message: "无法连接镜像仓库，无法检查可用版本。",
    action: "请检查服务器网络与镜像加速配置。",
  },
  models_fetch_failed: {
    message: "无法连接模型服务，获取模型列表失败。",
    action: "请确认地址可从服务器访问（注意内网/防火墙），以及地址拼写正确。",
  },
  models_fetch_timeout: {
    message: "获取模型列表超时（15 秒）。",
    action: "该地址响应过慢或不可达，请确认服务可用后重试。",
  },
  models_request_failed: {
    message: "模型服务返回错误。",
    action: "常见原因：API Key 无效或已过期、额度用尽、该站点不支持 /v1/models 接口。具体状态码与返回内容见下方详情。",
  },
  pr_fetch_failed: {
    message: "拉取 Pull Request 内容失败。",
    action: "请确认 App 有该仓库的读取权限，稍后重试。",
  },

  // 写操作失败
  provider_save_failed: {
    message: "保存 Provider 配置失败。",
    action: "请确认主密钥已配置后重试。",
  },
  oauth_save_failed: {
    message: "保存 OAuth 配置失败。",
    action: "请确认主密钥已配置后重试。",
  },
  upsert_failed: {
    message: "写入数据失败。",
    action: "请稍后重试；若持续失败，请查看服务日志中的数据库错误。",
  },
  delete_failed: { message: "删除失败。", action: "请刷新后确认当前状态，再重试。" },
  embedding_save_failed: {
    message: "保存向量数据失败。",
    action: "请确认 embedding 服务可用，且数据库 pgvector 扩展已启用。",
  },
  export_failed: { message: "导出失败。", action: "请稍后重试。" },
  import_failed: {
    message: "导入失败。",
    action: "请确认文件是本系统导出的备份 JSON，且未被修改。",
  },
  init_failed: {
    message: "初始化失败。",
    action: "请查看服务日志确认具体原因，修正后重试。",
  },
  already_initialized: {
    message: "系统已完成初始化，无需重复执行。",
  },
  trigger_failed: {
    message: "触发任务失败。",
    action: "请确认仓库与编号有效，且 GitHub App 已正确配置。",
  },
  rebuild_failed: { message: "重建索引失败。", action: "请查看索引服务日志。" },
  audit_failed: { message: "读取审计记录失败。", action: "请稍后重试。" },
  memory_failed: { message: "读取记忆数据失败。", action: "请稍后重试。" },
  consolidate_failed: {
    message: "合并记忆失败。",
    action: "请稍后重试；若持续失败，请检查模型服务是否可用。",
  },
  unsupported_setting_key: {
    message: "该配置项不支持在界面中修改。",
  },
  invalid_setting_value: {
    message: "配置值不合法，未保存。",
    action: "请按提示修正后重试（错误码后面的文字说明了具体要求）。",
  },
  update_in_progress: {
    message: "已有一个更新正在进行中。",
    action: "请等待当前更新完成后再操作。",
  },

  // 任务失败类别（analysis_tasks.last_error_category）
  github_auth_failed: {
    message: "GitHub 认证失败，任务无法访问仓库。",
    action: "请确认 App 私钥有效、安装未被移除。",
  },
  github_not_found: {
    message: "GitHub 返回资源不存在，可能 Issue/PR 已被删除。",
  },
  invalid_output: {
    message: "模型返回的结果不符合约定格式。",
    action: "重试通常可恢复；若某个模型持续失败，建议在「模型」页更换。",
  },
  model_not_found: {
    message: "配置的模型不存在。",
    action: "请在「模型」页确认模型名称与 Provider 是否匹配。",
  },
  lease_expired: {
    message: "任务执行超时，租约已过期。",
    action: "任务会自动回到队列重试，无需手动处理。",
  },
  canceled: { message: "任务已被取消。" },
  unsupported_task_type: {
    message: "该任务类型当前版本尚不支持。",
  },
};

/** 查表得到结构化说明；未知码返回 null，由调用方原样展示。 */
export function lookupError(reason: string): Explanation | null {
  return explanations[reason] ?? null;
}

/**
 * 生成面向用户的一句话说明。未知码原样返回——宁可让用户看到机器码，
 * 也不要用「未知错误」把唯一的线索抹掉。
 */
export function explainError(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "操作失败，且未返回具体原因。";

  // 后端可能在错误码后附加诊断信息（上游状态码、端点、返回正文）。整串查表
  // 会失配，所以按首个 token 匹配错误码，并保留其后的诊断内容。
  const match = /^([a-z][a-z0-9_]*)\b([\s\S]*)$/.exec(trimmed);
  const code = match?.[1] ?? trimmed;
  const rest = (match?.[2] ?? "").trim();

  const found = lookupError(code);
  if (!found) return trimmed;

  const parts = [found.message];
  if (found.action) parts.push(found.action);
  // 保留原始码，便于用户反馈时提供准确信息。
  const explained = `${parts.join(" ")}（${code}）`;
  return rest ? `${explained} ${rest}` : explained;
}

/** 把任意异常转成可展示文案，同时对已知错误码做翻译。 */
export function explainUnknown(error: unknown): string {
  if (error instanceof Error) return explainError(error.message);
  if (typeof error === "string") return explainError(error);
  return "操作失败，且未返回具体原因。";
}
