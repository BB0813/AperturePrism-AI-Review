import { describe, expect, it } from "vitest";
import { errorLabel } from "./exec.js";

describe("errorLabel", () => {
  it("explains what the user can do about known failures", () => {
    // A bare category like "invalid_output" tells the user nothing, which is
    // part of the "bot just says failed" complaint in issue #6.
    expect(errorLabel("authentication_failed")).toContain("Provider 密钥");
    expect(errorLabel("rate_limited")).toContain("稍后重试");
    expect(errorLabel("model_not_found")).toContain("模型名称");
  });

  it("keeps the machine category for reporting", () => {
    expect(errorLabel("invalid_output")).toContain("invalid_output");
  });

  it("passes unknown categories through unchanged", () => {
    expect(errorLabel("some_new_category")).toBe("some_new_category");
  });
});
