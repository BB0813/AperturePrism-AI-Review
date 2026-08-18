CREATE TABLE "issue_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid,
	"issue_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"versions" text[] DEFAULT '{}' NOT NULL,
	"error_codes" text[] DEFAULT '{}' NOT NULL,
	"paths" text[] DEFAULT '{}' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"has_stack_trace" boolean DEFAULT false NOT NULL,
	"has_reproduction" boolean DEFAULT false NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_documents_repo_issue_unique" ON "issue_documents" USING btree ("repository_id","issue_number");--> statement-breakpoint
CREATE INDEX "issue_documents_fulltext_gin" ON "issue_documents" USING gin (to_tsvector('simple', body || ' ' || title));--> statement-breakpoint
CREATE INDEX "issue_documents_error_codes_gin" ON "issue_documents" USING gin ("error_codes");--> statement-breakpoint
CREATE INDEX "issue_documents_paths_gin" ON "issue_documents" USING gin ("paths");