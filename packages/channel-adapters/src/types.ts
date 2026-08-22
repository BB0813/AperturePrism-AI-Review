/** Third-party NTQQ and official QQ open-platform protocols this layer can normalize. */
export const channelProtocols = [
  "onebot11",
  "satori",
  "milky",
  "officialqq",
] as const;
export type ChannelProtocol = (typeof channelProtocols)[number];

export type ChannelScene = "group" | "private" | "temp";

/**
 * A protocol message normalized to a channel-independent form. Only plain
 * text is kept here; rich segments (images, faces, forwards) are dropped
 * because the bot only reacts to text commands. Mentions are stripped so
 * `@bot /analyze` and `/analyze` land on the same command.
 */
export type NormalizedChannelMessage = {
  protocol: ChannelProtocol;
  scene: ChannelScene;
  /** Group id or friend id, bound to nothing else (no display value). */
  peerId: string;
  /** The QQ number of the sender. */
  senderId: string;
  /** Stable message identity within a protocol, used for idempotency. */
  messageId: string;
  body: string;
  selfId: string;
  /** Event timestamp in epoch seconds. */
  time: number;
};

/**
 * A reply channel reference returned after publishing a notification, so the
 * caller can later update the same message instead of spamming a second one.
 */
export type ChannelMessageRef = {
  protocol: ChannelProtocol;
  scene: ChannelScene;
  peerId: string;
  /**
   * Protocol-side identity for the published message. Filled after a send;
   * empty when the bot does not receive its own identity back.
   */
  messageId: string;
};

/** A parsed first-line bot command (see command.ts). */
export type BotCommand =
  | { kind: "analyze"; raw: string }
  | { kind: "review"; raw: string }
  | { kind: "retry"; raw: string }
  | { kind: "status"; raw: string }
  | { kind: "help"; raw: string };

export const botCommandKinds = [
  "analyze",
  "review",
  "retry",
  "status",
  "help",
] as const;
export type BotCommandKind = (typeof botCommandKinds)[number];
