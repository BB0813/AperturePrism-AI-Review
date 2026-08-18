import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadConfig } from "./index.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://prism:secret@localhost:5432/prism",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("loads defaults and freezes the result", () => {
    const config = loadConfig(validEnvironment);
    expect(config).toMatchObject({
      environment: "development",
      port: 3000,
      logLevel: "info",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects missing and invalid connection URLs", () => {
    expect(() => loadConfig({})).toThrow(ZodError);
    expect(() =>
      loadConfig({ ...validEnvironment, DATABASE_URL: "https://localhost/db" }),
    ).toThrow("DATABASE_URL must use postgres:// or postgresql://");
  });

  it("rejects ports outside the TCP range", () => {
    expect(() => loadConfig({ ...validEnvironment, PORT: "70000" })).toThrow(
      ZodError,
    );
  });
});
