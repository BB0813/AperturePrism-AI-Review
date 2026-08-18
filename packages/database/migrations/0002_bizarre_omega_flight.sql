ALTER TABLE "webhook_deliveries" ADD COLUMN "processing_status" varchar(20) DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "outcome_reason" varchar(100);