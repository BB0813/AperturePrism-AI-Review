import type {
  BotCommand,
  NormalizedChannelMessage,
} from "../../../packages/channel-adapters/src/index.js";

/**
 * A command action maps a normalized channel message + parsed command to the
 * reply text (or null to stay silent). It may be async; the real executor is
 * injected by main.ts (see exec.ts) so the dispatcher stays pure.
 */
export type DispatchAction = (
  message: NormalizedChannelMessage,
  command: BotCommand,
) => string | Promise<string | null>;

/** A GitHub issue/PR URL parsed into its owner / repo / number parts. */
export type ParsedGitHubUrl = {
  owner: string;
  name: string;
  number: number;
};

const defaultAction: DispatchAction = (_message, command) => {
  const url = firstGitHubUrl(command.raw);
  const kindName = commandKindLabel(command.kind);
  if (url) {
    return [
      `已收到 ${kindName} 请求：${url}`,
      "QQ 渠道的任务执行尚未接入（需要注入任务执行器）。",
    ].join("\n");
  }
  return [
    `请在命令后附上${commandHint(command.kind)}，例如：\`${exampleCommand(command.kind)}\``,
  ].join("\n");
};

/** What a command expects in its arguments (link or task id). */
export function commandHint(kind: BotCommand["kind"]): string {
  switch (kind) {
    case "analyze":
    case "review":
      return "GitHub 链接";
    case "status":
    case "retry":
      return "任务 ID";
    case "repo":
    case "settings":
      return "仓库名（可选）";
    case "repos":
    case "scan":
      return "（无参数）";
    case "logs":
      return "条数（可选）";
    case "help":
      return "—";
  }
}

function exampleCommand(kind: BotCommand["kind"]): string {
  switch (kind) {
    case "analyze":
      return "/analyze https://github.com/owner/repo/issues/123";
    case "review":
      return "/review https://github.com/owner/repo/pull/123";
    case "status":
      return "/status <任务ID>";
    case "retry":
      return "/retry <任务ID>";
    case "help":
      return "/prism help";
    default:
      return `/${kind}${kind === "repo" || kind === "settings" ? " owner/name" : ""}`;
  }
}

export const defaultCommandReply = defaultAction;

/**
 * Maps a normalized channel message + parsed command to the reply text, or
 * null when the message was not a command (so the bot stays silent).
 */
export function dispatchBotTurn(
  message: NormalizedChannelMessage,
  command: BotCommand | null,
  action: DispatchAction = defaultAction,
): Promise<string | null> {
  if (!command) return Promise.resolve(null);
  if (command.kind === "help") return Promise.resolve(helpText());
  return Promise.resolve(action(message, command));
}

/** Replies to `/help` or `/prism help` with the available command list. */
export function helpText(): string {
  return [
    "AperturePrism 可用命令：",
    "  /analyze <Issue 链接>  分析一个 GitHub Issue",
    "  /review <PR 链接>      审查一个 GitHub Pull Request",
    "  /status <任务ID>       查看任务执行状态与结果",
    "  /retry <任务ID>        重跑失败/已取消的任务",
    "  /repos                 列出已记录的仓库",
    "  /repo <owner/name>     查看单个仓库详情",
    "  /logs [条数]           查看最近任务/事件日志",
    "  /scan                  触发全仓库索引扫描",
    "  /settings [owner/name] 查看仓库扫描/功能设置",
    "  /prism help            显示本帮助",
  ].join("\n");
}

function commandKindLabel(kind: BotCommand["kind"]): string {
  switch (kind) {
    case "analyze":
      return "Issue 分析";
    case "review":
      return "PR 审查";
    case "retry":
      return "重试";
    case "status":
      return "状态查询";
    case "help":
      return "帮助";
    case "repos":
      return "仓库列表";
    case "repo":
      return "仓库详情";
    case "logs":
      return "日志";
    case "scan":
      return "扫描触发";
    case "settings":
      return "扫描设置";
  }
}

/** Extracts the first github.com URL from command arguments, if any. */
export function firstGitHubUrl(text: string): string | null {
  const match = text.match(/https?:\/\/github\.com\/[^\s<>]+/i);
  return match?.[0] ?? null;
}

/** Parses a github.com issue/PR URL into owner / repo / number, or null. */
export function parseGitHubUrl(text: string): ParsedGitHubUrl | null {
  const match = text.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)/i,
  );
  if (!match) return null;
  return { owner: match[1]!, name: match[2]!, number: Number(match[3]) };
}
