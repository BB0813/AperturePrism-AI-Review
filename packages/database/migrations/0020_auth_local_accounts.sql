-- 方向一：本地账号密码登录 + 统一会话（2026-09-08）
-- 1) users 补列：本地密码哈希 / TOTP 预留 / 最近登录时间。
--    全部 nullable 以兼容存量 OAuth-only 用户。
-- 2) user_sessions：password 与 github 两种来源的统一会话表，token 以
--    sha256 hash 落库，支持过期、吊销与并发查询。
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "password_hash" text,
  ADD COLUMN IF NOT EXISTS "totp_secret" text,
  ADD COLUMN IF NOT EXISTS "totp_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_login" text NOT NULL REFERENCES "users"("login") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "auth_method" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "user_agent" text,
  "ip" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_hash_unique"
  ON "user_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "user_sessions_user_revoked_idx"
  ON "user_sessions" ("user_login", "revoked_at");