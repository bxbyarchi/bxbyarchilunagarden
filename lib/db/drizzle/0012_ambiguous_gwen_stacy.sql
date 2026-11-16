CREATE TABLE "production_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"qty" numeric(12, 4) NOT NULL,
	"unit_price" numeric(12, 4) NOT NULL,
	"cost" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "productions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tech_card_id" integer NOT NULL,
	"department_id" integer NOT NULL,
	"batches" numeric(12, 3) NOT NULL,
	"planned_output" numeric(12, 3) NOT NULL,
	"actual_output" numeric(12, 3) NOT NULL,
	"output_unit" text NOT NULL,
	"output_item_id" integer NOT NULL,
	"output_item_qty" numeric(12, 4) NOT NULL,
	"total_cost" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"notes" text,
	"recorded_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_clerk_id" text,
	CONSTRAINT "productions_status_ck" CHECK ("productions"."status" in ('done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "tech_cards" ADD COLUMN "output_item_id" integer;--> statement-breakpoint
ALTER TABLE "production_lines" ADD CONSTRAINT "production_lines_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_lines" ADD CONSTRAINT "production_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_tech_card_id_tech_cards_id_fk" FOREIGN KEY ("tech_card_id") REFERENCES "public"."tech_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_department_id_locations_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_lines_production_idx" ON "production_lines" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "productions_department_idx" ON "productions" USING btree ("department_id","created_at");--> statement-breakpoint
ALTER TABLE "tech_cards" ADD CONSTRAINT "tech_cards_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;