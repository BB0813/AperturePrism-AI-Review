-- 方向七：仓库可见性授权（2026-09-08）
-- 用户 - 仓库 授权映射。access: 'view'（只读可看）| 'manage'（可管设置/触发分析）。
-- 级联：删用户/删仓库自动清理授权。
CREATE TABLE IF NOT EXISTS "repository_grants" (
  "user_login" text NOT NULL REFERENCES "users"("login") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "access" text NOT NULL DEFAULT 'view',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_login", "repository_id")
);

CREATE INDEX IF NOT EXISTS "repository_grants_repo_idx"
  ON "repository_grants" ("repository_id");