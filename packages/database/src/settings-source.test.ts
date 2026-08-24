import { describe, expect, it } from "vitest";
import { resolveSettingValue } from "./settings-source.js";

describe("resolveSettingValue", () => {
  it("prefers a non-empty database value", () => {
    expect(
      resolveSettingValue({ dbValue: "debug", envValue: "info" }),
    ).toEqual({ value: "debug", source: "database" });
  });

  it("falls back to env when the database has no override", () => {
    expect(
      resolveSettingValue({ dbValue: undefined, envValue: "info" }),
    ).toEqual({ value: "info", source: "env" });
  });

  it("treats an empty or whitespace database value as no override", () => {
    // 与现存 `db || env` 语义一致：空串穿透到 env，而不是被当成「关闭」。
    expect(
      resolveSettingValue({ dbValue: "", envValue: "info" }),
    ).toEqual({ value: "info", source: "env" });
    expect(
      resolveSettingValue({ dbValue: "   ", envValue: "info" }),
    ).toEqual({ value: "info", source: "env" });
  });

  it("reports default when neither layer configured the key", () => {
    expect(
      resolveSettingValue({ dbValue: undefined, envValue: undefined }),
    ).toEqual({ value: undefined, source: "default" });
    expect(
      resolveSettingValue({ dbValue: "", envValue: "" }),
    ).toEqual({ value: undefined, source: "default" });
  });

  it("returns the untrimmed database value so meaningful whitespace survives", () => {
    // 判断是否为空用 trim，但返回原值：极少数场景里前后空格可能有意义。
    expect(
      resolveSettingValue({ dbValue: " token ", envValue: undefined }).value,
    ).toBe(" token ");
  });
});
