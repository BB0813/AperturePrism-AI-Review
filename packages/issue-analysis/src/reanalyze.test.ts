import { describe, expect, it } from "vitest";
import { normalizedIndexText } from "../../duplicate-detection/src/index.js";
import {
  DEFAULT_MIN_CHANGE_RATIO,
  decideReanalysis,
  normalizedChangeRatio,
  parseMinChangeRatio,
} from "./reanalyze.js";
import { isIssueEditEvent } from "./payload.js";

const older = new Date("2026-08-01T00:00:00Z");
const newer = new Date("2026-08-02T00:00:00Z");

function gate(
  before: string,
  after: string,
  minChangeRatio = DEFAULT_MIN_CHANGE_RATIO,
) {
  return decideReanalysis({
    gated: true,
    snapshot: { text: before, updatedAt: older },
    revisionAt: newer,
    currentText: after,
    minChangeRatio,
  });
}

describe("normalizedChangeRatio", () => {
  it("is 0 for identical text and 1 for a full rewrite", () => {
    expect(normalizedChangeRatio("abc", "abc")).toBe(0);
    expect(normalizedChangeRatio("aaaa", "bbbb")).toBe(1);
  });

  it("scales with the size of the edited span, not its position", () => {
    const body = "x".repeat(100);
    // 同样改 1 个字符，位于开头、中间、结尾的比例应当一致。
    expect(normalizedChangeRatio(body, `y${body.slice(1)}`)).toBeCloseTo(0.01);
    expect(
      normalizedChangeRatio(body, `${body.slice(0, 50)}y${body.slice(51)}`),
    ).toBeCloseTo(0.01);
    expect(normalizedChangeRatio(body, `${body.slice(0, 99)}y`)).toBeCloseTo(0.01);
  });

  it("does not double-count the shared span when one side is a prefix", () => {
    // "ab" -> "abcd"：前缀吃掉 "ab" 后，后缀不能再从同一段回吃。
    expect(normalizedChangeRatio("ab", "abcd")).toBeCloseTo(0.5);
    expect(normalizedChangeRatio("aaa", "aaaaa")).toBeCloseTo(0.4);
  });

  it("treats an emptied body as a full change", () => {
    expect(normalizedChangeRatio("some text", "")).toBe(1);
    expect(normalizedChangeRatio("", "")).toBe(0);
  });
});

describe("decideReanalysis", () => {
  it("never gates paths other than issues.edited", () => {
    const decision = decideReanalysis({
      gated: false,
      snapshot: { text: "same", updatedAt: older },
      revisionAt: newer,
      currentText: "same",
      minChangeRatio: DEFAULT_MIN_CHANGE_RATIO,
    });
    expect(decision).toEqual({
      reanalyze: true,
      reason: "not_gated",
      changeRatio: null,
    });
  });

  it("analyzes when no snapshot has been indexed yet", () => {
    const decision = decideReanalysis({
      gated: true,
      snapshot: null,
      revisionAt: newer,
      currentText: "anything",
      minChangeRatio: DEFAULT_MIN_CHANGE_RATIO,
    });
    expect(decision.reanalyze).toBe(true);
    expect(decision.reason).toBe("no_usable_snapshot");
  });

  it("analyzes when the snapshot is not older than the edit", () => {
    // 索引任务可能已经写入本次编辑后的正文；那样比较毫无意义，必须分析。
    const decision = decideReanalysis({
      gated: true,
      snapshot: { text: "current text", updatedAt: newer },
      revisionAt: newer,
      currentText: "current text",
      minChangeRatio: DEFAULT_MIN_CHANGE_RATIO,
    });
    expect(decision.reanalyze).toBe(true);
    expect(decision.reason).toBe("no_usable_snapshot");
  });

  it("analyzes when the revision timestamp cannot be parsed", () => {
    const decision = decideReanalysis({
      gated: true,
      snapshot: { text: "a", updatedAt: older },
      revisionAt: null,
      currentText: "b",
      minChangeRatio: DEFAULT_MIN_CHANGE_RATIO,
    });
    expect(decision.reanalyze).toBe(true);
    expect(decision.reason).toBe("no_usable_snapshot");
  });

  it("skips an edit that changes nothing after normalization", () => {
    const before = normalizedIndexText({
      title: "连接失败",
      body: "点开仪表盘就断线，见截图 ![shot](https://a.example/1.png)",
    });
    const after = normalizedIndexText({
      title: "连接失败",
      // 只换了截图链接：归一化后正文完全相同，不该重跑模型。
      body: "点开仪表盘就断线，见截图 ![shot](https://b.example/2.png)",
    });
    const decision = gate(before, after);
    expect(decision).toEqual({
      reanalyze: false,
      reason: "unchanged",
      changeRatio: 0,
    });
  });

  it("skips a typo-sized edit below the threshold", () => {
    const before = "a".repeat(400);
    const after = `b${before.slice(1)}`;
    const decision = gate(before, after);
    expect(decision.reanalyze).toBe(false);
    expect(decision.reason).toBe("minor_change");
  });

  it("reanalyzes a substantial rewrite", () => {
    const before = "原始描述：点开页面报 500";
    const after =
      "重写后的描述：升级到 1.0.29 之后，点开仪表盘立刻报 500，日志里是 ECONNREFUSED，重启数据库也没用";
    const decision = gate(before, after);
    expect(decision.reanalyze).toBe(true);
    expect(decision.reason).toBe("substantial_change");
  });

  it("honors a per-install threshold", () => {
    const before = "a".repeat(100);
    const after = `${"b".repeat(5)}${before.slice(5)}`; // 5% 改动
    expect(gate(before, after, 0.1).reanalyze).toBe(false);
    // 阈值调到 1% 后，同一次编辑应当重新分析。
    expect(gate(before, after, 0.01).reanalyze).toBe(true);
  });
});

describe("parseMinChangeRatio", () => {
  it("falls back to the default for absent or malformed values", () => {
    expect(parseMinChangeRatio(undefined)).toBe(DEFAULT_MIN_CHANGE_RATIO);
    expect(parseMinChangeRatio(null)).toBe(DEFAULT_MIN_CHANGE_RATIO);
    expect(parseMinChangeRatio("  ")).toBe(DEFAULT_MIN_CHANGE_RATIO);
    expect(parseMinChangeRatio("abc")).toBe(DEFAULT_MIN_CHANGE_RATIO);
    // 越界值同样回落：负数或 >1 会让开关失去意义。
    expect(parseMinChangeRatio("-0.2")).toBe(DEFAULT_MIN_CHANGE_RATIO);
    expect(parseMinChangeRatio("1.5")).toBe(DEFAULT_MIN_CHANGE_RATIO);
  });

  it("accepts valid ratios including the extremes", () => {
    expect(parseMinChangeRatio("0.25")).toBe(0.25);
    expect(parseMinChangeRatio("0")).toBe(0);
    expect(parseMinChangeRatio("1")).toBe(1);
  });
});

describe("isIssueEditEvent", () => {
  it("only matches a webhook issues.edited payload", () => {
    expect(isIssueEditEvent({ sourceEvent: "issues", sourceAction: "edited" })).toBe(
      true,
    );
    expect(
      isIssueEditEvent({ sourceEvent: "issues", sourceAction: "opened" }),
    ).toBe(false);
    expect(
      isIssueEditEvent({ sourceEvent: "issues", sourceAction: "reopened" }),
    ).toBe(false);
    expect(isIssueEditEvent({ sourceEvent: "manual" })).toBe(false);
    expect(isIssueEditEvent({ sourceEvent: "scan" })).toBe(false);
    expect(
      isIssueEditEvent({ sourceEvent: "issue_comment_command" }),
    ).toBe(false);
    // 本次改动之前创建的任务没有 sourceAction：必须按「分析」处理。
    expect(isIssueEditEvent({ sourceEvent: "issues" })).toBe(false);
    expect(isIssueEditEvent(null)).toBe(false);
  });
});
