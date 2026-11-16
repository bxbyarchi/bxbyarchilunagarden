CREATE TABLE "sale_stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_item_id" integer NOT NULL,
	"return_id" integer,
	"item_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"qty" numeric(12, 4) NOT NULL,
	"unit_cost" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "total_returns_cash" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "shift_id" integer;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "restocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tech_card_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "item_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "item_qty" numeric(12, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "write_off_location_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "sale_stock_movements" ADD CONSTRAINT "sale_stock_movements_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_stock_movements" ADD CONSTRAINT "sale_stock_movements_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_stock_movements" ADD CONSTRAINT "sale_stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_stock_movements" ADD CONSTRAINT "sale_stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_stock_movements_sale_item_idx" ON "sale_stock_movements" USING btree ("sale_item_id");--> statement-breakpoint
CREATE INDEX "sale_stock_movements_item_date_idx" ON "sale_stock_movements" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tech_card_id_tech_cards_id_fk" FOREIGN KEY ("tech_card_id") REFERENCES "public"."tech_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_write_off_location_id_locations_id_fk" FOREIGN KEY ("write_off_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_barcode_idx" ON "products" USING btree ("barcode");--> statement-breakpoint
-- Before this migration every return was deducted from expected cash; keep that for old shifts.
UPDATE "shifts" SET "total_returns_cash" = "total_returns";