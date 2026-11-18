ALTER TABLE "attendance" ADD COLUMN "checkout_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_schedules" ADD COLUMN "no_show_notified_at" timestamp with time zone;