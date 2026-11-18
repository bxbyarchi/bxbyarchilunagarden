ALTER TABLE "advisor_chats" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "advisor_model" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "digest_hour" integer DEFAULT 9;