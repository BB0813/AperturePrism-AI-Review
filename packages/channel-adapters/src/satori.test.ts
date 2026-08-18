import { describe, expect, it } from "vitest";
import {
  normalizeSatoriMessage,
  satoriContentToText,
  satoriSendPayload,
} from "./satori.js";

describe("Satori adapter", () => {
  it("extracts text from a message content array of elements and strings", () => {
    expect(
      satoriContentToText([
        { type: "at", attrs: { user_id: "123" } },
        { type: "text", children: ["/analyze "] },
        { type: "text", children: ["https://github.com/o/r/issues/7"] },
      ]),
    ).toBe("/analyze https://github.com/o/r/issues/7");
    expect(satoriContentToText("plain text")).toBe("plain text");
  });

  it("normalizes a group message-created event", () => {
    const message = normalizeSatoriMessage({
      type: "message-created",
      id: "event-1",
      timestamp: 1787013000123,
      platform: "qq",
      self_id: "7",
      channel: { id: "g999", type: "GROUP" },
      user: { id: "42" },
      message: {
        id: "m1",
        content: [{ type: "text", children: ["/retry a"] }],
      },
    });
    expect(message).toEqual({
      protocol: "satori",
      scene: "group",
      peerId: "g999",
      senderId: "42",
      messageId: "st:m1",
      body: "/retry a",
      selfId: "7",
      time: 1787013000,
    });
  });

  it("maps a DIRECT channel to a private scene", () => {
    const message = normalizeSatoriMessage({
      type: "message-created",
      id: "e2",
      timestamp: 0,
      platform: "qq",
      self_id: "7",
      channel: { id: "d42", type: "DIRECT" },
      user: { id: "42" },
      message: { id: "m2", content: "hi" },
    });
    expect(message?.scene).toBe("private");
    expect(message?.peerId).toBe("d42");
    expect(message?.body).toBe("hi");
  });

  it("ignores non-message events", () => {
    expect(normalizeSatoriMessage({ type: "guild-added" })).toBeNull();
  });

  it("builds a message.create payload", () => {
    expect(satoriSendPayload({ channelId: "g999", text: "done" })).toEqual({
      path: "/v1/message.create",
      body: { channel_id: "g999", content: "done" },
    });
  });
});
