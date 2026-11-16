CREATE TABLE "ai_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"guest_id" integer,
	"contact_name" text,
	"status" text DEFAULT 'ai' NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"attention_reason" text,
	"attention_kind" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_status_ck" CHECK ("ai_conversations"."status" in ('ai', 'human', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"actions" jsonb,
	"error" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 5),
	"author_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_role_ck" CHECK ("ai_messages"."role" in ('guest', 'ai', 'staff', 'note'))
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"model" text DEFAULT 'claude-opus-5-5' NOT NULL,
	"restaurant_info" text,
	"tone" text,
	"deposit_rules" text,
	"deposit_min_party" integer,
	"deposit_per_guest" numeric(12, 2),
	"payment_details" text,
	"knowledge" text,
	"max_party_for_ai" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_channel_external_uq" ON "ai_conversations" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_last_idx" ON "ai_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "ai_messages_conv_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_messages_error_idx" ON "ai_messages" USING btree ("created_at") WHERE "ai_messages"."error" IS NOT NULL;