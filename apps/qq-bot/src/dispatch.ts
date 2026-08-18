import type {
  BotCommand,
  NormalizedChannelMessage,
} from "../../../packages/channel-adapters/src/index.js";

export type DispatchAction = (
  message: NormalizedChannelMessage,
  command: BotCommand,
) => string;

const defaultAction: DispatchAction = (_message, command) => {
  const url = firstGitHubUrl(command.raw);
  const kindName = commandKindLabel(command.kind);
  if (url) {
    return [
      `已收到 ${kindName} 请求：${url}`,
      "QQ 渠道的任务执行尚未接入（需要 GitHub 身份绑定与任务 API，属于 M10 前置）。",
    ].join("\n");
  }
  return [
    `请在命令后附上 GitHub 链接，例如：\`${exampleCommand(command.kind)}\``,
  ].join("\n");
};

function exampleCommand(kind: BotCommand["kind"]): string {
  const link =
    kind === "review"
      ? "https://github.com/owner/repo/pull/123"
      : "https://github.com/owner/repo/issues/123";
  return `/${kind} ${link}`;
}

export const defaultCommandReply = defaultAction;

/**
 * Maps a normalized channel message + parsed command to the reply text, or
 * null when the message was not a command (so the bot stays silent). The
 * action can be overridden to attach real GitHub task execution later.
 */
export function dispatchBotTurn(
  message: NormalizedChannelMessage,
  command: BotCommand | null,
  action: DispatchAction = defaultAction,
): string | null {
  if (!command) return null;
  if (command.kind === "help") return helpText();
  return action(message, command);
}

/** Replies to `/help` or `/prism help` with the available command list. */
export function helpText(): string {
  return [
    "AperturePrism 可用命令：",
    "  /analyze <Issue 链接>  分析一个 GitHub Issue",
    "  /review <PR 链接>      审查一个 GitHub Pull Request",
    "  /retry <链接>          重试最近一次失败任务",
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
    default:
      return kind;
  }
}

/** Extracts the first github.com URL from command arguments, if any. */
export function firstGitHubUrl(text: string): string | null {
  const match = text.match(/https?:\/\/github\.com\/[^\s<>]+/i);
  return match?.[0] ?? null;
}
