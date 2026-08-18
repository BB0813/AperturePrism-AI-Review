import { describe, expect, it } from "vitest";
import { milkySendPayload, normalizeMilkyMessage } from "./milky.js";

describe("Milky adapter", () => {
  it("normalizes a group message_receive event", () => {
    const message = normalizeMilkyMessage({
      event_type: "message_receive",
      self_id: 7,
      time: 1787013000,
      data: {
        message_scene: "group",
        peer_id: 999,
        sender_id: 42,
        message_seq: 3,
        message: [
          {
            type: "text",
            data: { text: "/analyze https://github.com/o/r/issues/7" },
          },
        ],
      },
    });
    expect(message).toEqual({
      protocol: "milky",
      scene: "group",
      peerId: "999",
      senderId: "42",
      messageId: "milk:group:999:3",
      body: "/analyze https://github.com/o/r/issues/7",
      selfId: "7",
      time: 1787013000,
    });
  });

  it("maps friend/temp scenes and sequences the message id", () => {
    const friend = normalizeMilkyMessage({
      event_type: "message_receive",
      self_id: 7,
      time: 1,
      data: {
        message_scene: "friend",
        peer_id: 42,
        sender_id: 42,
        message_seq: 5,
        message: [{ type: "text", data: { text: "hi" } }],
      },
    });
    expect(friend?.scene).toBe("private");
    expect(friend?.messageId).toBe("milk:private:42:5");

    const temp = normalizeMilkyMessage({
      event_type: "message_receive",
      self_id: 7,
      time: 1,
      data: {
        message_scene: "temp",
        peer_id: 42,
        sender_id: 42,
        message_seq: 6,
        message: [{ type: "text", data: { text: "hi" } }],
      },
    });
    expect(temp?.scene).toBe("temp");
  });

  it("ignores non-message events and empty bodies", () => {
    expect(
      normalizeMilkyMessage({ event_type: "group_message_recall" }),
    ).toBeNull();
    expect(
      normalizeMilkyMessage({
        event_type: "message_receive",
        self_id: 1,
        time: 1,
        data: {
          message_scene: "group",
          peer_id: 1,
          sender_id: 1,
          message_seq: 1,
          message: [],
        },
      }),
    ).toBeNull();
  });

  it("builds a group send payload with segments", () => {
    expect(
      milkySendPayload({ scene: "group", peerId: "999", text: "done" }),
    ).toEqual({
      action: "send_group_msg",
      params: {
        group_id: 999,
        message: [{ type: "text", data: { text: "done" } }],
      },
    });
  });
});
