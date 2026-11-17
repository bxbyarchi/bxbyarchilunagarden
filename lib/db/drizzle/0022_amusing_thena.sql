CREATE TABLE "advisor_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_clerk_id" text NOT NULL,
	"title" text DEFAULT 'Новый вопрос' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"actions" jsonb,
	"error" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advisor_messages" ADD CONSTRAINT "advisor_messages_chat_id_advisor_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."advisor_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advisor_chats_user_idx" ON "advisor_chats" USING btree ("user_clerk_id","updated_at");--> statement-breakpoint
CREATE INDEX "advisor_messages_chat_idx" ON "advisor_messages" USING btree ("chat_id","created_at");