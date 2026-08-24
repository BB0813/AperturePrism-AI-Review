-- Per-repository overrides for analysis behaviour. Same semantics as
-- `system_settings`: a row here overrides the global value, its absence falls
-- back to the global setting (and then to the application default). No rows are
-- pre-seeded, so an untouched repository keeps following the global config.
--
-- Only keys that make sense per repository are accepted (enforced by the API
-- allowlist): title rewriting, auto-assign, deep analysis, reanalysis
-- threshold. Global-only settings such as log level or the WebUI token must
-- never be overridable here.
CREATE TABLE IF NOT EXISTS "repository_settings" (
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("repository_id", "key")
);

CREATE INDEX IF NOT EXISTS "repository_settings_repo_idx"
  ON "repository_settings" ("repository_id");
