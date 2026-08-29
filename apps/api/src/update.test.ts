import { afterEach, describe, expect, it, vi } from "vitest";
import { currentVersion, isValidUpdateTarget } from "./update";

describe("isValidUpdateTarget", () => {
  it("accepts semantic versions with or without v prefix", () => {
    expect(isValidUpdateTarget("1.0.83")).toBe(true);
    expect(isValidUpdateTarget("v1.0.83")).toBe(true);
    expect(isValidUpdateTarget("2.1.0")).toBe(true);
  });

  it("accepts latest / stable channels", () => {
    expect(isValidUpdateTarget("latest")).toBe(true);
    expect(isValidUpdateTarget("stable")).toBe(true);
  });

  it("rejects malformed targets", () => {
    expect(isValidUpdateTarget("")).toBe(false);
    expect(isValidUpdateTarget("1.2")).toBe(false);
    expect(isValidUpdateTarget("1.2.3.4")).toBe(false);
    expect(isValidUpdateTarget("v1.0")).toBe(false);
    expect(isValidUpdateTarget("release-1.0.83")).toBe(false);
    expect(isValidUpdateTarget("1.0.83 ")).toBe(false);
    expect(isValidUpdateTarget("1.0.83\n")).toBe(false);
    expect(isValidUpdateTarget("main")).toBe(false);
  });
});

describe("currentVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers UPDATE_VERSION over IMAGE_TAG", () => {
    vi.stubEnv("UPDATE_VERSION", "v1.0.83");
    vi.stubEnv("IMAGE_TAG", "v1.0.82");
    expect(currentVersion()).toBe("v1.0.83");
  });

  it("falls back to IMAGE_TAG when UPDATE_VERSION is unset", () => {
    vi.stubEnv("UPDATE_VERSION", undefined);
    vi.stubEnv("IMAGE_TAG", "1.0.82");
    expect(currentVersion()).toBe("1.0.82");
  });

  it("never returns the literal 'latest' (reads package version instead)", () => {
    vi.stubEnv("UPDATE_VERSION", "latest");
    vi.stubEnv("IMAGE_TAG", "latest");
    const version = currentVersion();
    expect(version).not.toBe("latest");
    expect(version).toMatch(/^v?\d+\.\d+\.\d+$|^unknown$/);
  });
});
