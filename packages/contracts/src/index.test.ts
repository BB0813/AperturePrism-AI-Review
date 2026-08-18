import { describe, expect, it } from "vitest";
import { apiHealth } from "../src/index.js";

describe("contracts", () => {
  it("exposes the API health contract", () => {
    expect(apiHealth).toEqual({ name: "apertureprism-api", status: "ok" });
  });
});
