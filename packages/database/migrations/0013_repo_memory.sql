-- Repository memory: distilled rules/knowledge plus raw reflections distilled
-- from completed issue analyses and PR reviews. Reflections are later merged
-- (consolidated=true) by the memory-consolidation agent into durable rules.
CREATE TABLE IF NOT EXISTS "repo_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid REFERENCES "repositories"("id"),
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "source_type" text,
  "source_ref" text,
  "consolidated" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "repo_memory_repo_kind_idx" ON "repo_memory" USING btree ("repository_id", "kind");
CREATE INDEX IF NOT EXISTS "repo_memory_consolidated_idx" ON "repo_memory" USING btree ("consolidated");
