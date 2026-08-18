export type MessageSegment = {
  type: string;
  data?: Record<string, unknown>;
};

function segmentObject(value: unknown): MessageSegment | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.type !== "string") return null;
  const data =
    typeof entry.data === "object" && entry.data !== null
      ? (entry.data as Record<string, unknown>)
      : {};
  return { type: entry.type, data };
}

function textValue(entry: MessageSegment): string {
  const text = entry.data?.text;
  return typeof text === "string" ? text : "";
}

/**
 * Reduces an array-format message (used by OneBot 11 and Milky) to the plain
 * text the bot should react to. Non-text segments (image, face, file, forward,
 * reply, ...) are dropped; mentions are stripped so `@bot /analyze` and the
 * bare command behave the same.
 */
export function segmentsToText(
  segments: readonly unknown[] | undefined | null,
): string {
  if (!Array.isArray(segments)) return "";
  const parts: string[] = [];
  for (const value of segments) {
    const entry = segmentObject(value);
    if (!entry) continue;
    if (entry.type === "text") {
      parts.push(textValue(entry));
    } else if (entry.type === "at") {
      // Mention only: no text contribution, so the command is still the first token.
      continue;
    }
  }
  return parts.join("").trim();
}

/**
 * Serializes plain text back into the array-format the protocol expects for
 * sending. Safe for both OneBot 11 and Milky.
 */
export function textToSegments(text: string): MessageSegment[] {
  if (text.length === 0) return [];
  return [{ type: "text", data: { text } }];
}
