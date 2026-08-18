import type {
  ChannelMessageRef,
  ChannelProtocol,
  NormalizedChannelMessage,
} from "./types.js";

const protocol: ChannelProtocol = "satori";
const messageIdPrefix = `st`;

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Concatenates the plain text inside a Satori message `content`, which can be
 * either a string or an array of elements (`{type, attrs, children}`) where
 * text is a plain string child. Non-text elements are skipped so mentions and
 * media never pollute the command text.
 */
export function satoriContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    const element = objectValue(node);
    if (Array.isArray(element.children)) {
      for (const child of element.children) walk(child);
    }
  };
  for (const node of content) walk(node);
  return parts.join("").trim();
}

type SatoriSendMessage = { channelId?: string; text: string };

export function satoriSendPayload(input: SatoriSendMessage): {
  path: string;
  body: Record<string, unknown>;
} {
  return {
    path: "/v1/message.create",
    body: {
      channel_id: input.channelId ?? "",
      content: input.text,
    },
  };
}

/**
 * Normalizes a Satori `message-created` event. `peerId` is the channel id;
 * a DIRECT channel maps to a private scene. Text is extracted from elements.
 */
export function normalizeSatoriMessage(
  raw: unknown,
): NormalizedChannelMessage | null {
  const event = objectValue(raw);
  if (event.type !== "message-created") return null;

  const message = objectValue(event.message);
  const channel = objectValue(event.channel);
  const user = objectValue(event.user);

  const messageId = stringValue(message.id);
  const selfId = stringValue(event.self_id);
  const channelId = stringValue(
    event.channel_id || channel.id || message.channel_id,
  );
  const senderId = stringValue(message.user_id || user.id);
  const scene = channel.type === "DIRECT" ? "private" : "group";
  if (!messageId || !selfId || !channelId || !senderId) return null;

  const body = satoriContentToText(message.content);
  if (body.length === 0) return null;

  const timestamp =
    typeof event.timestamp === "number"
      ? Math.floor(event.timestamp / 1000)
      : typeof event.time === "number"
        ? event.time
        : 0;

  return {
    protocol,
    scene,
    peerId: channelId,
    senderId,
    messageId: `${messageIdPrefix}:${messageId}`,
    body,
    selfId,
    time: timestamp,
  };
}

export function satoriMessageRef(input: {
  scene: "group" | "private";
  peerId: string;
  messageId?: string;
}): ChannelMessageRef {
  return {
    protocol,
    scene: input.scene,
    peerId: input.peerId,
    messageId: input.messageId
      ? `${messageIdPrefix}:reply:${input.messageId}`
      : "",
  };
}
