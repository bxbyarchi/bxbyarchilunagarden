CREATE TABLE "attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"check_in_at" timestamp with time zone NOT NULL,
	"check_out_at" timestamp with time zone,
	"check_in_photo" text,
	"check_out_photo" text,
	"method" text DEFAULT 'kiosk' NOT NULL,
	"note" text,
	"edited_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"note" text,
	"created_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "user_clerk_id" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "hourly_rate" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "shift_rate" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "hire_date" date;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "photo_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_one_open_uq" ON "attendance" USING btree ("staff_id") WHERE "attendance"."check_out_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_schedules_staff_date_uq" ON "staff_schedules" USING btree ("staff_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_pin_hash_uq" ON "staff" USING btree ("pin_hash") WHERE "staff"."pin_hash" IS NOT NULL;