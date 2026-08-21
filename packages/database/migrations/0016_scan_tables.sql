-- Repository scanning: per-repo scan config, run history, and auto-created
-- tracking issues for scanned subjects (e.g. new open pull requests).
CREATE TABLE IF NOT EXISTS "scan_configs" (
  "repository_id" uuid PRIMARY KEY REFERENCES "repositories"("id") NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "interval_minutes" integer DEFAULT 1440 NOT NULL,
  "max_issues" integer DEFAULT 50 NOT NULL,
  "max_prs" integer DEFAULT 20 NOT NULL,
  "auto_analyze_issues" boolean DEFAULT true NOT NULL,
  "auto_analyze_prs" boolean DEFAULT true NOT NULL,
  "create_tracking_issues" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "scan_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid REFERENCES "repositories"("id"),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" varchar(20) DEFAULT 'running' NOT NULL,
  "trigger" varchar(20) DEFAULT 'scheduled' NOT NULL,
  "scanned_issues" integer DEFAULT 0 NOT NULL,
  "scanned_prs" integer DEFAULT 0 NOT NULL,
  "created_issue_tasks" integer DEFAULT 0 NOT NULL,
  "created_pr_tasks" integer DEFAULT 0 NOT NULL,
  "created_tracking_issues" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "error" text
);
CREATE INDEX IF NOT EXISTS "scan_runs_repo_started_idx" ON "scan_runs" USING btree ("repository_id", "started_at");

CREATE TABLE IF NOT EXISTS "scan_tracking" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid REFERENCES "repositories"("id"),
  "subject_type" varchar(10) NOT NULL,
  "subject_number" integer NOT NULL,
  "tracking_issue_number" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "scan_tracking_repo_subject_unique" ON "scan_tracking" USING btree ("repository_id", "subject_type", "subject_number");
