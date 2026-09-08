import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, hashToken } from "./password.js";

describe("password hashing (scrypt)", () => {
  it("round-trips a password and produces a self-describing hash", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(
      true,
    );
    // 不同 salt → 相同密码两次 hash 不同。
    const again = await hashPassword("correct horse battery staple");
    expect(again).not.toBe(encoded);
    expect(await verifyPassword("correct horse battery staple", again)).toBe(
      true,
    );
  });

  it("rejects wrong password", async () => {
    const encoded = await hashPassword("a-secret");
    expect(await verifyPassword("wrong", encoded)).toBe(false);
  });

  it("rejects malformed / foreign encoded strings", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "argon2$1$2$3$4$5$6")).toBe(false);
  });
});

describe("token fingerprint", () => {
  it("is a deterministic sha256 hex, not the raw token", () => {
    const hash = hashToken("raw-token-value");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("raw-token-value");
    expect(hashToken("raw-token-value")).toBe(hash);
  });
});