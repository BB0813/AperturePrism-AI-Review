CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD COLUMN "embedding" vector(4096);