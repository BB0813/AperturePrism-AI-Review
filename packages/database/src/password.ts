import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

/**
 * scrypt 的 Promise 封装。Node 的类型签名把"带 options"的形式与"callback"形式
 * 耦合得较紧，promisify 导出函数的 options 重载常报"Expected 3 args got 4"。
 * 这里用显式代码包一层，接受 `{ N, r, p }` 选项并返回 Promise<Buffer>。
 */
function scryptAsync(
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keylen,
      options,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

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
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
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
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (!Number.isFinite(r) || r <= 0) return false;
  if (!Number.isFinite(p) || p <= 0) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  try {
    const derived = await scryptAsync(password, salt, KEYLEN, { N: n, r, p });
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