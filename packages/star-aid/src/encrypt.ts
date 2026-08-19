import type { CredentialCipher } from "../../../packages/config/src/index.js";

/** Seals a GitHub PAT with the shared AES-GCM credential cipher. */
export function encryptToken(cipher: CredentialCipher, token: string): string {
  return cipher.seal(token);
}

/** Opens a previously sealed GitHub PAT. */
export function decryptToken(
  cipher: CredentialCipher,
  encrypted: string,
): string {
  return cipher.open(encrypted);
}
