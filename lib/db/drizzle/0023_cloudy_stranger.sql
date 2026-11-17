CREATE TABLE "kb_articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tech_card_id" integer,
	"author_clerk_id" text,
	"updated_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"user_clerk_id" text NOT NULL,
	"version" integer NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"assigned_by_clerk_id" text,
	"due_date" date,
	"status" text DEFAULT 'assigned' NOT NULL,
	"best_score" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_answers" jsonb,
	"passed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"department" text,
	"article_ids" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"quiz" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pass_percent" integer DEFAULT 80 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_reads" ADD CONSTRAINT "kb_reads_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_course_id_training_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."training_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_articles_category_idx" ON "kb_articles" USING btree ("category","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_reads_article_user_uq" ON "kb_reads" USING btree ("article_id","user_clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_assignments_course_staff_uq" ON "training_assignments" USING btree ("course_id","staff_id");--> statement-breakpoint
CREATE INDEX "training_assignments_staff_idx" ON "training_assignments" USING btree ("staff_id");