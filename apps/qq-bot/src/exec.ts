import { eq } from "drizzle-orm";
import type { BotCommand } from "../../../packages/channel-adapters/src/index.js";
import {
  analysisTasks,
  subjectResults,
  type DatabaseClient,
} from "../../../packages/database/src/index.js";
import { resetTaskToQueued } from "../../../packages/task-engine/src/index.js";
import {
  firstGitHubUrl,
  parseGitHubUrl,
  type DispatchAction,
} from "./dispatch.js";

/** Dependencies the real task executor needs to trigger and inspect tasks. */
export type TaskActionDeps = {
  /** API base URL (default http://api:3300), used for POST /tasks/manual. */
  apiBaseUrl: string;
  /** WebUI bearer token; empty in open (no-auth) deployments. */
  apiToken: string;
  /** Shared DB client used to read task status and reset tasks. */
  database: DatabaseClient;
};

const TASK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the injected command action for the QQ bot. analyze/review trigger a
 * real manual task through the API, status/retry read and mutate tasks in the
 * database directly (the bot container has DB access). Any failure degrades
 * to a friendly reply instead of throwing into the event loop.
 */
export function createTaskAction(deps: TaskActionDeps): DispatchAction {
  return async (_message, command): Promise<string | null> => {
    try {
      switch (command.kind) {
        case "analyze":
        case "review":
          return await triggerTask(deps, command);
        case "status":
          return await taskStatus(deps, command.raw);
        case "retry":
          return await retryTask(deps, command.raw);
        case "repos":
          return await listRepositories(deps);
        case "repo":
          return await repositoryDetail(deps, command.raw);
        case "logs":
          return await recentLogs(deps, command.raw);
        case "scan":
          return await triggerScan(deps);
        case "settings":
          return await scanConfig(deps, command.raw);
        case "help":
          return null; // handled before the action runs
      }
    } catch (error) {
      return `执行出错：${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

async function triggerTask(
  deps: TaskActionDeps,
  command: Extract<BotCommand, { kind: "analyze" | "review" }>,
): Promise<string> {
  const url = firstGitHubUrl(command.raw);
  if (!url) {
    return `请在命令后附上 GitHub 链接，例如：\`/${command.kind} https://github.com/owner/repo/issues/123\``;
  }
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return "链接不是有效的 GitHub Issue/PR 链接（需要 github.com/owner/repo/issues/N 或 /pull/N）。";
  }
  const type = command.kind === "review" ? "pr" : "issue";
  const repositoryFullName = `${parsed.owner}/${parsed.name}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiToken) headers.authorization = `Bearer ${deps.apiToken}`;
  let response: Response;
  try {
    response = await fetch(
      `${deps.apiBaseUrl.replace(/\/+$/, "")}/tasks/manual`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          type,
          repositoryFullName,
          subjectNumber: parsed.number,
        }),
      },
    );
  } catch {
    return `无法连接 API（${deps.apiBaseUrl}），请检查 QQ_BOT_API_BASE_URL 与网络。`;
  }

  let payload: { taskId?: unknown; outcome?: unknown; reason?: unknown } | null =
    null;
  try {
    payload = (await response.json()) as {
      taskId?: unknown;
      outcome?: unknown;
      reason?: unknown;
    };
  } catch {
    // non-JSON response falls through to the generic failure below
  }

  if (response.ok && payload && typeof payload.taskId === "string") {
    const kindName = type === "pr" ? "PR 审查" : "Issue 分析";
    const created = payload.outcome !== "duplicate";
    return [
      created
        ? `已创建${kindName}任务：`
        : `已存在相同的${kindName}任务（未重复创建）：`,
      `  任务 ID：${payload.taskId}`,
      `  对象：${repositoryFullName}#${parsed.number}`,
      `完成后可用 \`/status ${payload.taskId}\` 查询状态与结果。`,
    ].join("\n");
  }

  const reason = typeof payload?.reason === "string" ? payload.reason : "";
  switch (reason) {
    case "repository_not_installed":
      return "该仓库尚未安装 AperturePrism，请在 WebUI「已安装仓库」中先安装。";
    case "github_not_configured":
      return "GitHub App 未配置，无法解析 PR 分支，暂时不能创建审查任务。";
    case "pull_request_not_found":
      return "找不到该 PR（可能不存在或没有访问权限）。";
    default:
      return `任务创建失败${reason ? `：${reason}` : "（API 未返回可用结果）"}`;
  }
}

async function taskStatus(deps: TaskActionDeps, raw: string): Promise<string> {
  const taskId = raw.trim();
  if (!taskId) return "用法：/status <任务ID>";
  if (!TASK_ID_RE.test(taskId)) return "任务 ID 格式无效。";

  const rows = await deps.database.db
    .select({
      id: analysisTasks.id,
      taskType: analysisTasks.taskType,
      status: analysisTasks.status,
      lastErrorCategory: analysisTasks.lastErrorCategory,
      attemptCount: analysisTasks.attemptCount,
      updatedAt: analysisTasks.updatedAt,
    })
    .from(analysisTasks)
    .where(eq(analysisTasks.id, taskId))
    .limit(1);
  if (rows.length === 0) return `未找到任务：${taskId}`;

  const task = rows[0]!;
  const lines = [
    `任务 ${task.id.slice(0, 8)}：${statusLabel(task.status)}`,
    `类型：${taskTypeLabel(task.taskType)}`,
    `尝试：${task.attemptCount} 次`,
    `更新时间：${formatTime(task.updatedAt)}`,
  ];

  // retry_wait 也要透出失败原因：否则用户在重试等待期只看到状态、看不到原因，
  // 表现为「bot 只回一个失败」（见 issue #6）。
  if (
    (task.status === "failed" || task.status === "retry_wait") &&
    task.lastErrorCategory
  ) {
    lines.push(`错误：${errorLabel(task.lastErrorCategory)}`);
  } else if (task.status === "completed") {
    const result = await deps.database.db
      .select({ published: subjectResults.published })
      .from(subjectResults)
      .where(eq(subjectResults.taskId, taskId))
      .limit(1);
    lines.push(
      result.length > 0 && result[0]!.published
        ? "结果已发布到 GitHub（评论 / Review）。"
        : "结果已生成，正在发布。",
    );
  }
  return lines.join("\n");
}

async function retryTask(deps: TaskActionDeps, raw: string): Promise<string> {
  const taskId = raw.trim();
  if (!taskId) return "用法：/retry <任务ID>";
  if (!TASK_ID_RE.test(taskId)) return "任务 ID 格式无效。";
  const ok = await resetTaskToQueued(deps.database.db, { taskId });
  return ok
    ? `已将任务 ${taskId.slice(0, 8)} 重新加入队列。`
    : "任务不存在或状态不允许重跑（仅 failed / canceled 可重跑）。";
}

/**
 * 把机器错误分类翻译成用户能据此行动的说明。裸分类（如 invalid_output）
 * 对用户没有意义，也是 issue #6 里「只回一个失败」的一部分。
 */
export function errorLabel(category: string): string {
  const map: Record<string, string> = {
    authentication_failed: "模型服务认证失败，请检查 Provider 密钥",
    rate_limited: "模型服务限流，稍后重试即可",
    server_error: "模型服务端错误，稍后重试即可",
    timeout: "模型调用超时，稍后重试即可",
    connection_failed: "无法连接模型服务，请检查网络或服务地址",
    model_not_found: "配置的模型不存在，请检查模型名称",
    context_overflow: "内容超出模型上下文上限",
    invalid_output: "模型返回的结果不符合约定格式",
    canceled: "任务已被取消",
    analysis_not_implemented: "该任务类型尚未实现分析逻辑",
    handler_error: "执行过程中出现未预期的错误",
    lease_expired: "执行超时，任务租约已过期",
  };
  const label = map[category];
  return label ? `${label}（${category}）` : category;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: "排队中",
    leased: "已领取",
    running: "执行中",
    publishing: "发布中",
    completed: "已完成",
    failed: "失败",
    retry_wait: "等待重试",
    canceled: "已取消",
  };
  return map[status] ?? status;
}

function taskTypeLabel(taskType: string): string {
  const map: Record<string, string> = {
    issue_analysis: "Issue 分析",
    pr_review: "PR 审查",
    repository_index: "仓库索引",
  };
  return map[taskType] ?? taskType;
}

function formatTime(value: Date | null): string {
  if (!value) return "—";
  const d = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 仓库 / 日志类命令。全部复用 apps/api 的只读 + admin 触发端点；Bot 用 Bearer
// token 调用（无 session），API 将无身份请求视为 admin → 全仓库可见/可触发。
// ---------------------------------------------------------------------------

/** Common headers for API calls; add Bearer when a token is configured. */
function apiHeaders(deps: TaskActionDeps): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiToken) headers.authorization = `Bearer ${deps.apiToken}`;
  return headers;
}

/** GET an API path, decoding common failure shapes into a user-facing reason. */
async function apiGet<T>(
  deps: TaskActionDeps,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  const url = `${deps.apiBaseUrl.replace(/\/+$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: apiHeaders(deps) });
  } catch {
    return { ok: false, reason: `无法连接 API（${deps.apiBaseUrl}），请检查网络。` };
  }
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { reason?: unknown };
      if (typeof body?.reason === "string" && body.reason) reason = body.reason;
    } catch {
      // non-JSON response falls through
    }
    return { ok: false, reason };
  }
  return { ok: true, data: (await response.json()) as T };
}

async function listRepositories(deps: TaskActionDeps): Promise<string> {
  const res = await apiGet<{ items?: unknown[] }>(
    deps,
    "/repositories",
  );
  if (!res.ok) return `获取仓库列表失败：${res.reason}`;
  const items = Array.isArray(res.data.items) ? res.data.items : [];
  if (items.length === 0) return "尚无记录的仓库。";
  const lines = items.slice(0, 30).map((item) => {
    const it = item as {
      fullName?: unknown;
      taskCount?: unknown;
      resultCount?: unknown;
    };
    const name = typeof it.fullName === "string" ? it.fullName : "—";
    const tasks = Number(it.taskCount) || 0;
    const results = Number(it.resultCount) || 0;
    return `  - ${name}：任务 ${tasks} ｜ 结果 ${results}`;
  });
  return [`已记录仓库（${items.length}）：`, ...lines].join("\n");
}

async function repositoryDetail(
  deps: TaskActionDeps,
  raw: string,
): Promise<string> {
  const name = raw.trim();
  if (!/^[\w.-]+\/[\w.-]+$/u.test(name)) {
    return "用法：/repo <owner/name>，例如 `/repo owner/repo`。";
  }
  const res = await apiGet<{ items?: unknown[] }>(deps, "/repositories");
  if (!res.ok) return `获取仓库详情失败：${res.reason}`;
  const items = Array.isArray(res.data.items) ? res.data.items : [];
  const repo = items.find((it) => {
    const fullName = (it as { fullName?: unknown }).fullName;
    return fullName === name;
  }) as
    | { fullName?: unknown; taskCount?: unknown; resultCount?: unknown }
    | undefined;
  if (!repo) return `仓库「${name}」未记录/未安装。`;

  const lines = [
    `仓库：${typeof repo.fullName === "string" ? repo.fullName : name}`,
    `  任务：${Number(repo.taskCount) || 0} ｜ 结果：${Number(repo.resultCount) || 0}`,
  ];

  const issues = await apiGet<{ items?: unknown[] }>(
    deps,
    `/repositories/issues?fullName=${encodeURIComponent(name)}&limit=5`,
  );
  if (issues.ok && Array.isArray(issues.data.items) && issues.data.items.length) {
    lines.push("  最近条目：");
    for (const item of issues.data.items.slice(0, 5)) {
      const it = item as { number?: unknown; title?: unknown; type?: unknown };
      lines.push(
        `    #${it.number ?? "?"} [${it.type ?? "issue"}] ${String(
          it.title ?? "",
        ).slice(0, 40)}`,
      );
    }
  }
  return lines.join("\n");
}

async function recentLogs(deps: TaskActionDeps, raw: string): Promise<string> {
  const rawN = raw.trim();
  let limit = 60;
  if (rawN.length > 0) {
    if (!/^\d+$/u.test(rawN)) return "用法：/logs [条数]，例如 `/logs 20`。";
    limit = Math.min(Math.max(Number(rawN), 1), 200);
  }
  const res = await apiGet<{ events?: unknown[] }>(
    deps,
    `/logs?history=1&limit=${limit}`,
  );
  if (!res.ok) return `获取日志失败：${res.reason}`;
  const events = Array.isArray(res.data.events) ? res.data.events : [];
  if (events.length === 0) return "暂无日志事件。";
  const lines = events.slice(0, Math.min(limit, 200)).map((event) => {
    const it = event as {
      taskId?: unknown;
      eventType?: unknown;
      createdAt?: unknown;
    };
    const taskId = typeof it.taskId === "string" ? it.taskId : "";
    const short = taskId.length > 8 ? taskId.slice(0, 8) : taskId;
    const type = typeof it.eventType === "string" ? it.eventType : "?";
    const when =
      it.createdAt instanceof Date
        ? formatTime(it.createdAt)
        : typeof it.createdAt === "string"
          ? it.createdAt.slice(0, 16).replace("T", " ")
          : "";
    return `  ${short} ${type} ${when}`;
  });
  return [
    `最近日志（${events.length}）：`,
    ...lines,
    limit < 200 ? "提示：可用 `/logs <条数>` 查看更多。" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function triggerScan(deps: TaskActionDeps): Promise<string> {
  const url = `${deps.apiBaseUrl.replace(/\/+$/, "")}/scans/run`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: apiHeaders(deps) });
  } catch {
    return `无法连接 API（${deps.apiBaseUrl}），请检查网络。`;
  }
  if (response.status === 403) {
    return "当前令牌无管理员权限，无法触发扫描。";
  }
  if (!response.ok) return `触发扫描失败：HTTP ${response.status}`;
  return "已触发全仓库索引扫描，worker 将在下一轮执行。";
}

async function scanConfig(
  deps: TaskActionDeps,
  raw: string,
): Promise<string> {
  const filter =
    raw.trim().length > 0 && /^[\w.-]+\/[\w.-]+$/u.test(raw.trim())
      ? raw.trim()
      : null;
  const res = await apiGet<{ enabled?: unknown; items?: unknown[] }>(
    deps,
    "/scans/config",
  );
  if (!res.ok) return `获取扫描设置失败：${res.reason}`;
  const globalOn = res.data.enabled === true;
  const items = Array.isArray(res.data.items) ? res.data.items : [];
  const rows = filter
    ? items.filter(
        (it) =>
          (it as { fullName?: unknown }).fullName === filter,
      )
    : items;
  if (rows.length === 0) {
    return filter
      ? `仓库「${filter}」没有扫描配置。`
      : "暂无仓库扫描配置。";
  }
  const lines = [
    `全局扫描：${globalOn ? "开启" : "关闭"}`,
    ...rows.slice(0, 20).map((item) => formatScanConfig(item)),
  ];
  return lines.join("\n");
}

function formatScanConfig(item: unknown): string {
  const it = item as {
    fullName?: unknown;
    installed?: unknown;
    enabled?: unknown;
    intervalMinutes?: unknown;
    maxIssues?: unknown;
    maxPrs?: unknown;
    autoAnalyzeIssues?: unknown;
    autoAnalyzePrs?: unknown;
    createTrackingIssues?: unknown;
  };
  const name = typeof it.fullName === "string" ? it.fullName : "?";
  const on = it.enabled === true;
  const lines = [
    `  ${name}（${it.installed === true ? "已安装" : "未安装"}）扫描 ${on ? "开" : "关"}`,
    `    间隔 ${String(it.intervalMinutes ?? "-")} 分钟｜Issue ${String(
      it.maxIssues ?? "-",
    )}｜PR ${String(it.maxPrs ?? "-")}`,
    `    自动分析 Issue ${it.autoAnalyzeIssues === true ? "是" : "否"}｜PR ${
      it.autoAnalyzePrs === true ? "是" : "否"
    }｜建跟踪单 ${it.createTrackingIssues === true ? "是" : "否"}`,
  ];
  return lines.join("\n");
}
