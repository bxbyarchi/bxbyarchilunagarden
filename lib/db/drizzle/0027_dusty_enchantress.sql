CREATE TABLE "telegram_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"text" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
