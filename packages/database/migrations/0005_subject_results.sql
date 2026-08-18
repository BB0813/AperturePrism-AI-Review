CREATE TABLE IF NOT EXISTS "subject_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_number" integer NOT NULL,
	"repository_full_name" text NOT NULL,
	"revision" text NOT NULL,
	"task_id" uuid,
	"result" jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subject_results_task_unique" ON "subject_results" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_results_type_number_idx" ON "subject_results" USING btree ("subject_type","subject_number","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_task_id_analysis_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "analysis_tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;