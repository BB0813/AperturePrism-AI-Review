import { describe, expect, it } from "vitest";
import { parseConsolidationJson } from "./consolidation";

describe("parseConsolidationJson", () => {
  it("parses a valid array of entries", () => {
    const out = parseConsolidationJson(
      JSON.stringify([
        { title: "异步逻辑必须显式处理错误", content: "禁止静默吞掉异常", kind: "rule" },
        { title: "项目背景", content: "基于 XX 框架", kind: "knowledge" },
      ]),
    );
    expect(out).toEqual([
      { title: "异步逻辑必须显式处理错误", content: "禁止静默吞掉异常", kind: "rule" },
      { title: "项目背景", content: "基于 XX 框架", kind: "knowledge" },
    ]);
  });

  it("trims fields and skips entries with missing fields or unknown kind", () => {
    const out = parseConsolidationJson(
      JSON.stringify([
        { title: "  a  ", content: "  b  ", kind: "rule" },
        { title: "", content: "x", kind: "rule" },
        { title: "no content", content: "", kind: "knowledge" },
        { title: "bad kind", content: "x", kind: "note" },
        "not an object",
      ]),
    );
    expect(out).toEqual([{ title: "a", content: "b", kind: "rule" }]);
  });

  it("caps at 3 entries", () => {
    const items = [1, 2, 3, 4].map((n) => ({
      title: `t${n}`,
      content: `c${n}`,
      kind: "rule" as const,
    }));
    expect(parseConsolidationJson(JSON.stringify(items))).toHaveLength(3);
  });

  it("returns [] for malformed JSON, non-array, or null", () => {
    expect(parseConsolidationJson("not json")).toEqual([]);
    expect(parseConsolidationJson('{"title":"x"}')).toEqual([]);
    expect(parseConsolidationJson("null")).toEqual([]);
    expect(parseConsolidationJson("")).toEqual([]);
  });
});
