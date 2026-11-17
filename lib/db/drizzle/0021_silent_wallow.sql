CREATE TABLE "money_request_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"author_clerk_id" text,
	"kind" text DEFAULT 'comment' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "money_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"purpose" text,
	"requester_clerk_id" text NOT NULL,
	"staff_id" integer,
	"counterparty_id" integer,
	"department" text,
	"estimate" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_requested" numeric(12, 2) NOT NULL,
	"amount_approved" numeric(12, 2),
	"amount_issued" numeric(12, 2),
	"pay_method" text,
	"needed_by" date,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_spent" numeric(12, 2),
	"settlement" numeric(12, 2),
	"report_due_at" date,
	"approved_by_clerk_id" text,
	"issued_by_clerk_id" text,
	"closed_by_clerk_id" text,
	"approved_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_request_events" ADD CONSTRAINT "money_request_events_request_id_money_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."money_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_requests" ADD CONSTRAINT "money_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_requests" ADD CONSTRAINT "money_requests_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_request_events_req_idx" ON "money_request_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "money_requests_status_idx" ON "money_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "money_requests_requester_idx" ON "money_requests" USING btree ("requester_clerk_id");--> statement-breakpoint
CREATE INDEX "money_requests_staff_idx" ON "money_requests" USING btree ("staff_id","status");