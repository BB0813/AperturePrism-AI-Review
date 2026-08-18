import { segmentsToText, textToSegments } from "./segments.js";
import type {
  ChannelMessageRef,
  ChannelProtocol,
  NormalizedChannelMessage,
} from "./types.js";

const protocol: ChannelProtocol = "milky";
const messageIdPrefix = `milk`;

function numberValue(value: unknown): number | null {
  return typeof value === "number" || typeof value === "string"
    ? Number(value)
    : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes a Milky `message_receive` event. Milky identifies a message by
 * (message_scene, peer_id, message_seq); message segments share OneBot 11's
 * shape and are reduced to plain text the same way.
 */
export function normalizeMilkyMessage(
  raw: unknown,
): NormalizedChannelMessage | null {
  const envelope = objectValue(raw);
  const data = objectValue(envelope.data);
  if (envelope.event_type !== "message_receive") return null;

  const sceneValue: string | undefined =
    typeof data.message_scene === "string" ? data.message_scene : undefined;
  const scene =
    sceneValue === "group"
      ? "group"
      : sceneValue === "temp"
        ? "temp"
        : "private";

  const peerId = numberValue(data.peer_id);
  const senderId = numberValue(data.sender_id);
  const messageSeq = numberValue(data.message_seq);
  const selfId = numberValue(envelope.self_id);
  const time = numberValue(envelope.time) ?? 0;
  if (
    peerId === null ||
    senderId === null ||
    messageSeq === null ||
    selfId === null
  )
    return null;

  const body = segmentsToText(
    Array.isArray(data.message) ? (data.message as unknown[]) : undefined,
  );
  if (body.length === 0) return null;

  return {
    protocol,
    scene,
    peerId: String(peerId),
    senderId: String(senderId),
    messageId: `${messageIdPrefix}:${scene}:${peerId}:${messageSeq}`,
    body,
    selfId: String(selfId),
    time,
  };
}

export function milkyMessageRef(input: {
  scene: "group" | "private" | "temp";
  peerId: string;
  messageSeq?: unknown;
}): ChannelMessageRef {
  return {
    protocol,
    scene: input.scene,
    peerId: input.peerId,
    messageId: messageIdPrefix
      .concat(":reply:")
      .concat(input.messageSeq === undefined ? "" : String(input.messageSeq)),
  };
}

export function milkySendPayload(input: {
  scene: "group" | "private";
  peerId: string;
  text: string;
}): { action: string; params: Record<string, unknown> } {
  const message = textToSegments(input.text);
  if (input.scene === "group") {
    return {
      action: "send_group_msg",
      params: { group_id: Number(input.peerId), message },
    };
  }
  return {
    action: "send_private_msg",
    params: { user_id: Number(input.peerId), message },
  };
}
