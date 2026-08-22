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
  return kind === "analyze" || kind === "review"
    ? "GitHub 链接"
    : "任务 ID";
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
