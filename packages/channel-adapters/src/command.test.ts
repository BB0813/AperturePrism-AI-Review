import { describe, expect, it } from "vitest";
import { parseBotCommand } from "./command.js";

describe("bot command parser", () => {
  it("parses each supported command from the first non-empty line", () => {
    expect(parseBotCommand("/analyze https://github.com/o/r/issues/7")).toEqual(
      {
        kind: "analyze",
        raw: "https://github.com/o/r/issues/7",
      },
    );
    expect(parseBotCommand("/review https://github.com/o/r/pull/8")).toEqual({
      kind: "review",
      raw: "https://github.com/o/r/pull/8",
    });
    expect(parseBotCommand("/retry https://github.com/o/r/issues/7")).toEqual({
      kind: "retry",
      raw: "https://github.com/o/r/issues/7",
    });
    expect(parseBotCommand("/prism help")).toEqual({ kind: "help", raw: "" });
    expect(parseBotCommand("/prism")).toEqual({ kind: "help", raw: "" });
  });

  it("ignores leading blank lines and requires the command on the first content line", () => {
    expect(parseBotCommand("\n\n/analyze x")).toEqual({
      kind: "analyze",
      raw: "x",
    });
    expect(parseBotCommand("hello\n/analyze x")).toBeNull();
  });

  it("ignores commands inside code fences", () => {
    const text = "```\n/analyze https://github.com/o/r/issues/7\n```";
    expect(parseBotCommand(text)).toBeNull();
  });

  it("ignores commands inside blockquotes", () => {
    expect(
      parseBotCommand("> /analyze https://github.com/o/r/issues/7\n"),
    ).toBeNull();
  });

  it("returns null for non-commands and unknown slash commands", () => {
    expect(parseBotCommand("just a message")).toBeNull();
    expect(parseBotCommand("/unknown")).toBeNull();
    expect(parseBotCommand("")).toBeNull();
  });
});
