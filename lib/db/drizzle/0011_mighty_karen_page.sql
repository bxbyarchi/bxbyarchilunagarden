CREATE TABLE "tech_card_ingredients" (
	"id" serial PRIMARY KEY NOT NULL,
	"tech_card_id" integer NOT NULL,
	"item_id" integer,
	"semi_card_id" integer,
	"gross_qty" numeric(12, 4) NOT NULL,
	"unit" text NOT NULL,
	"cold_loss_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"hot_loss_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tech_card_ingredients_source_ck" CHECK (("tech_card_ingredients"."item_id" is null) <> ("tech_card_ingredients"."semi_card_id" is null))
);
--> statement-breakpoint
CREATE TABLE "tech_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'dish' NOT NULL,
	"department_id" integer,
	"category" text,
	"output_qty" numeric(12, 3) NOT NULL,
	"output_unit" text DEFAULT 'г' NOT NULL,
	"sale_price" numeric(12, 2),
	"technology" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_cards_kind_ck" CHECK ("tech_cards"."kind" in ('dish', 'semi'))
);
--> statement-breakpoint
ALTER TABLE "tech_card_ingredients" ADD CONSTRAINT "tech_card_ingredients_tech_card_id_tech_cards_id_fk" FOREIGN KEY ("tech_card_id") REFERENCES "public"."tech_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_card_ingredients" ADD CONSTRAINT "tech_card_ingredients_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_card_ingredients" ADD CONSTRAINT "tech_card_ingredients_semi_card_id_tech_cards_id_fk" FOREIGN KEY ("semi_card_id") REFERENCES "public"."tech_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_cards" ADD CONSTRAINT "tech_cards_department_id_locations_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tech_card_ingredients_card_idx" ON "tech_card_ingredients" USING btree ("tech_card_id");--> statement-breakpoint
CREATE INDEX "tech_cards_department_idx" ON "tech_cards" USING btree ("department_id");