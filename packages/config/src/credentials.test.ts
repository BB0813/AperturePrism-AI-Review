import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialEncryptionError,
  createCredentialCipher,
  secretsMatch,
} from "./credentials.js";

const masterKey = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

describe("credential cipher", () => {
  it("round-trips a credential", () => {
    const cipher = createCredentialCipher(masterKey);
    const sealed = cipher.seal("provider-api-key");
    expect(cipher.open(sealed)).toBe("provider-api-key");
  });

  it("never stores the plaintext in the sealed payload", () => {
    const cipher = createCredentialCipher(masterKey);
    const sealed = cipher.seal("super-secret-token");
    expect(sealed).not.toContain("super-secret-token");
    expect(sealed).not.toContain(masterKey);
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("produces a different ciphertext for the same input", () => {
    const cipher = createCredentialCipher(masterKey);
    expect(cipher.seal("same-value")).not.toBe(cipher.seal("same-value"));
  });

  it("rejects a credential sealed with a different key", () => {
    const sealed = createCredentialCipher(masterKey).seal("api-key");
    expect(() => createCredentialCipher(otherKey).open(sealed)).toThrow(
      CredentialEncryptionError,
    );
  });

  it("rejects tampered ciphertext, tags, and versions", () => {
    const cipher = createCredentialCipher(masterKey);
    const [version, iv, tag, ciphertext] = cipher.seal("api-key").split(".");
    const flip = (value: string) => {
      const raw = Buffer.from(value, "base64");
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      return raw.toString("base64");
    };

    expect(() =>
      cipher.open([version, iv, tag, flip(ciphertext ?? "")].join(".")),
    ).toThrow(CredentialEncryptionError);
    expect(() =>
      cipher.open([version, iv, flip(tag ?? ""), ciphertext].join(".")),
    ).toThrow(CredentialEncryptionError);
    expect(() => cipher.open(["v2", iv, tag, ciphertext].join("."))).toThrow(
      CredentialEncryptionError,
    );
    expect(() => cipher.open("not-sealed")).toThrow(CredentialEncryptionError);
  });

  it("rejects an invalid master key and an empty credential", () => {
    expect(() =>
      createCredentialCipher(randomBytes(16).toString("base64")),
    ).toThrow(CredentialEncryptionError);
    expect(() => createCredentialCipher(masterKey).seal("")).toThrow(
      CredentialEncryptionError,
    );
  });
});

describe("secretsMatch", () => {
  it("compares equal and unequal secrets", () => {
    expect(secretsMatch("token", "token")).toBe(true);
    expect(secretsMatch("token", "token2")).toBe(false);
    expect(secretsMatch("token", "wrong")).toBe(false);
  });
});
