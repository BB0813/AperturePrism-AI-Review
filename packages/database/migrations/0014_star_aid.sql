-- Star-aid: registered GitHub accounts (PAT sealed with AES-GCM) that the
-- platform periodically uses to star target repositories, cross-promoting them.
CREATE TABLE IF NOT EXISTS "star_aid_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "star_aid_accounts_login_unique" ON "star_aid_accounts" USING btree ("login");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "star_aid_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "star_aid_accounts"("id") ON DELETE CASCADE,
	"full_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"starred_at" timestamp with time zone,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "star_aid_targets_account_full_name_unique" ON "star_aid_targets" USING btree ("account_id", "full_name");
