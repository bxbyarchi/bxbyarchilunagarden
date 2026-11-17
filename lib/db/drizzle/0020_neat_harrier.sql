CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"author_clerk_id" text,
	"kind" text DEFAULT 'comment' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"creator_clerk_id" text NOT NULL,
	"assignee_staff_id" integer,
	"department" text,
	"zone" text,
	"due_at" timestamp with time zone,
	"needs_review" boolean DEFAULT true NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repeat" text,
	"parent_task_id" integer,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"returned_count" integer DEFAULT 0 NOT NULL,
	"overdue_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_staff_id_staff_id_fk" FOREIGN KEY ("assignee_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_staff_id","status");--> statement-breakpoint
CREATE INDEX "tasks_creator_idx" ON "tasks" USING btree ("creator_clerk_id");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("status","due_at");