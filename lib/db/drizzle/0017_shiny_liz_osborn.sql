CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"guest_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer DEFAULT 120 NOT NULL,
	"party_size" integer NOT NULL,
	"table_ids" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"occasion" text,
	"comment" text,
	"deposit_amount" numeric(12, 2),
	"deposit_status" text DEFAULT 'none' NOT NULL,
	"deposit_method" text,
	"deposit_paid_at" timestamp with time zone,
	"channel" text,
	"created_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_status_ck" CHECK ("bookings"."status" in ('new','confirmed','seated','completed','cancelled','no_show')),
	CONSTRAINT "bookings_deposit_ck" CHECK ("bookings"."deposit_status" in ('none','requested','paid','refunded')),
	CONSTRAINT "bookings_party_ck" CHECK ("bookings"."party_size" between 1 and 500),
	CONSTRAINT "bookings_duration_ck" CHECK ("bookings"."duration_min" between 15 and 1440)
);
--> statement-breakpoint
CREATE TABLE "dining_tables" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"zone" text,
	"seats" integer DEFAULT 4 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "dining_tables_seats_ck" CHECK ("dining_tables"."seats" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"whatsapp" text,
	"instagram" text,
	"telegram" text,
	"email" text,
	"birthday" date,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"notes" text,
	"source" text,
	"is_vip" boolean DEFAULT false NOT NULL,
	"is_blacklisted" boolean DEFAULT false NOT NULL,
	"created_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_starts_idx" ON "bookings" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "bookings_guest_idx" ON "bookings" USING btree ("guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dining_tables_name_uq" ON "dining_tables" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "guests_phone_uq" ON "guests" USING btree ("phone") WHERE "guests"."phone" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "guests_name_idx" ON "guests" USING btree (lower("name"));