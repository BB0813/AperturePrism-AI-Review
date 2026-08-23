import { describe, expect, it } from "vitest";
import { explainError, explainUnknown, lookupError } from "../lib/errors";

describe("explainError", () => {
  it("tells the user where to configure a missing GitHub App", () => {
    // 用户实际看到的原文是 github_not_configured，无法据此行动。
    const text = explainError("github_not_configured");
    expect(text).toContain("GitHub App 未配置");
    expect(text).toContain("安装向导");
  });

  it("keeps the machine code so users can report it accurately", () => {
    expect(explainError("rate_limited")).toContain("（rate_limited）");
  });

  it("passes unknown codes through instead of hiding them", () => {
    // 宁可显示机器码，也不要用「未知错误」抹掉唯一线索。
    expect(explainError("some_future_code")).toBe("some_future_code");
  });

  it("handles an empty reason", () => {
    expect(explainError("")).toContain("未返回具体原因");
    expect(explainError("   ")).toContain("未返回具体原因");
  });

  it("explains task failure categories, not just API errors", () => {
    expect(explainError("invalid_output")).toContain("不符合约定格式");
    expect(explainError("lease_expired")).toContain("自动回到队列");
  });

  it("omits the action clause when there is nothing to do", () => {
    const text = explainError("canceled");
    expect(text).toContain("已被取消");
    expect(lookupError("canceled")?.action).toBeUndefined();
  });
});

describe("explainUnknown", () => {
  it("translates codes carried by thrown Errors", () => {
    expect(explainUnknown(new Error("github_not_configured"))).toContain(
      "GitHub App 未配置",
    );
  });

  it("accepts bare strings and unexpected values", () => {
    expect(explainUnknown("rate_limited")).toContain("限流");
    expect(explainUnknown(undefined)).toContain("未返回具体原因");
    expect(explainUnknown({ weird: true })).toContain("未返回具体原因");
  });
});
