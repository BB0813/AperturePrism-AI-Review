import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * 密码哈希：使用 Node 内置 scrypt（零原生依赖，避免引入 native addon 而破坏
 * SMB/CI 构建）。格式 `scrypt$N$r$p$salthash$derivedkey`（base64url），可自描述
 * 参数，未来换参不破坏老哈希。
 */
const KEYLEN = 32;
const N = 16384;
const R = 8;
const P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (!Number.isFinite(r) || r <= 0) return false;
  if (!Number.isFinite(p) || p <= 0) return false;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  try {
    const derived = await scrypt(password, salt, KEYLEN, { N: n, r, p });
    return (
      derived.length === expected.length &&
      timingSafeEqual(derived, expected)
    );
  } catch {
    return false;
  }
}

/** 加盐令牌指纹：会话 token 以 sha256 落库，不存明文。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}