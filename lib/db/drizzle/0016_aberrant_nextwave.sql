CREATE TABLE "stock_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"delta" numeric(14, 4) NOT NULL,
	"balance_after" numeric(14, 4) NOT NULL,
	"kind" text NOT NULL,
	"ref_id" integer,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_ledger_item_loc_date_idx" ON "stock_ledger" USING btree ("item_id","location_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_date_idx" ON "stock_ledger" USING btree ("created_at");--> statement-breakpoint
-- Every change of warehouse_stock is logged here, whoever makes it.
CREATE OR REPLACE FUNCTION lg_stock_ledger() RETURNS trigger AS $$
DECLARE
  d numeric;
  item integer;
  loc integer;
  bal numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN d := NEW.current_stock; item := NEW.item_id; loc := NEW.location_id; bal := NEW.current_stock;
  ELSIF TG_OP = 'UPDATE' THEN d := NEW.current_stock - OLD.current_stock; item := NEW.item_id; loc := NEW.location_id; bal := NEW.current_stock;
  ELSE d := -OLD.current_stock; item := OLD.item_id; loc := OLD.location_id; bal := 0;
  END IF;
  IF d = 0 THEN RETURN NULL; END IF;
  -- The whole item/location is being deleted (cascade): nothing to keep.
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM items WHERE id = item) OR NOT EXISTS (SELECT 1 FROM locations WHERE id = loc)) THEN RETURN NULL; END IF;
  INSERT INTO stock_ledger (item_id, location_id, delta, balance_after, kind, ref_id, user_id)
  VALUES (item, loc, d, bal,
    COALESCE(NULLIF(current_setting('lg.move_kind', true), ''), 'other'),
    NULLIF(current_setting('lg.move_ref', true), '')::integer,
    NULLIF(current_setting('lg.user', true), ''));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER warehouse_stock_ledger AFTER INSERT OR UPDATE OF current_stock OR DELETE ON warehouse_stock
FOR EACH ROW EXECUTE FUNCTION lg_stock_ledger();--> statement-breakpoint
-- Opening balances, so that SUM(delta) always equals the current stock.
INSERT INTO stock_ledger (item_id, location_id, delta, balance_after, kind)
SELECT item_id, location_id, current_stock, current_stock, 'opening' FROM warehouse_stock WHERE current_stock <> 0;
