-- Security audit log: every sensitive admin/operator action is recorded
-- (user role changes, backup import, setup init, settings update, index ops).
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor" text DEFAULT '' NOT NULL,
  "action" text NOT NULL,
  "target" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");
