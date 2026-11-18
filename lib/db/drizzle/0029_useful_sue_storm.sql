ALTER TABLE "ai_messages" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "delivery_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_external_uq" ON "ai_messages" USING btree ("conversation_id","external_id") WHERE "ai_messages"."external_id" IS NOT NULL;