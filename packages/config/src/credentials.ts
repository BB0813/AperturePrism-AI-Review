import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const algorithm = "aes-256-gcm";
const ivLength = 12;
const tagLength = 16;
const version = "v1";

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionError";
  }
}

/**
 * Wraps the raw master key so callers cannot accidentally log or serialize it.
 * The key never appears in the sealed payload or in error messages.
 */
export type CredentialCipher = {
  seal: (plaintext: string) => string;
  open: (sealed: string) => string;
};

function decodeKey(masterKey: string): Buffer {
  const key = Buffer.from(masterKey, "base64");
  if (key.length !== 32)
    throw new CredentialEncryptionError(
      "credential master key must be 32 bytes",
    );
  return key;
}

export function createCredentialCipher(masterKey: string): CredentialCipher {
  const key = decodeKey(masterKey);

  return {
    seal: (plaintext) => {
      if (plaintext.length === 0)
        throw new CredentialEncryptionError("credential must not be empty");
      const iv = randomBytes(ivLength);
      const cipher = createCipheriv(algorithm, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        version,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(".");
    },

    open: (sealed) => {
      const parts = sealed.split(".");
      if (parts.length !== 4)
        throw new CredentialEncryptionError("sealed credential is malformed");
      const [sealedVersion, encodedIv, encodedTag, encodedCiphertext] = parts;
      if (sealedVersion !== version)
        throw new CredentialEncryptionError(
          "sealed credential uses an unsupported version",
        );

      const iv = Buffer.from(encodedIv ?? "", "base64");
      const tag = Buffer.from(encodedTag ?? "", "base64");
      if (iv.length !== ivLength || tag.length !== tagLength)
        throw new CredentialEncryptionError("sealed credential is malformed");

      const decipher = createDecipheriv(algorithm, key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(encodedCiphertext ?? "", "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Never surface the underlying cipher error: it can leak key state.
        throw new CredentialEncryptionError(
          "sealed credential failed authentication",
        );
      }
    },
  };
}

/** Constant-time comparison for secrets that must not leak length timing. */
export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
