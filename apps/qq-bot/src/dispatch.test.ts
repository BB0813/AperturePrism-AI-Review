import { describe, expect, it } from "vitest";
import type { NormalizedChannelMessage } from "../../../packages/channel-adapters/src/index.js";
import { dispatchBotTurn, firstGitHubUrl } from "./dispatch.js";

function message(body: string): NormalizedChannelMessage {
  return {
    protocol: "onebot11",
    scene: "group",
    peerId: "999",
    senderId: "42",
    messageId: "m1",
    body,
    selfId: "7",
    time: 1,
  };
}

describe("QQ bot dispatch", () => {
  it("stays silent when the message is not a command", () => {
    expect(dispatchBotTurn(message("just chatting"), null)).toBeNull();
    expect(
      dispatchBotTurn(message("just chatting"), null, () => "should not fire"),
    ).toBeNull();
  });

  it("returns the interactive help list", () => {
    const reply = dispatchBotTurn(message("x"), { kind: "help", raw: "" });
    expect(reply).toContain("/analyze");
    expect(reply).toContain("/prism help");
  });

  it("acknowledges an analyze command with a GitHub link", () => {
    const reply = dispatchBotTurn(
      message("/analyze https://github.com/o/r/issues/7"),
      { kind: "analyze", raw: "https://github.com/o/r/issues/7" },
    );
    expect(reply).toContain("https://github.com/o/r/issues/7");
    expect(reply).toContain("尚未接入");
  });

  it("asks for a link when none is provided", () => {
    const reply = dispatchBotTurn(message("/review"), {
      kind: "review",
      raw: "",
    });
    expect(reply).toContain("/review https://github.com/owner/repo/pull");

    const retried = dispatchBotTurn(message("/retry"), {
      kind: "retry",
      raw: "",
    });
    expect(retried).toContain(
      "/retry https://github.com/owner/repo/issues/123",
    );
  });

  it("lets an injected action override the default response", () => {
    const reply = dispatchBotTurn(
      message("/analyze https://github.com/o/r/issues/7"),
      { kind: "analyze", raw: "https://github.com/o/r/issues/7" },
      (_msg, command) => `wired:${command.raw}`,
    );
    expect(reply).toBe("wired:https://github.com/o/r/issues/7");
  });

  it("extracts the first GitHub url from arguments", () => {
    expect(firstGitHubUrl("see https://github.com/o/r/issues/7 now")).toBe(
      "https://github.com/o/r/issues/7",
    );
    expect(firstGitHubUrl("no link")).toBeNull();
  });
});
