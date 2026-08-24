ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_read_only" boolean DEFAULT false NOT NULL;
