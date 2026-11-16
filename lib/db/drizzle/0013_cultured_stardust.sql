ALTER TABLE "audit_items" DROP CONSTRAINT "audit_items_audit_id_inventory_audits_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_items" ADD COLUMN "unit_price" numeric(12, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD COLUMN "created_by_clerk_id" text;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD COLUMN "submitted_by_clerk_id" text;--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD COLUMN "shortage_value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "inventory_audits" ADD COLUMN "surplus_value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "audit_items" ADD CONSTRAINT "audit_items_audit_id_inventory_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."inventory_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Older data may hold duplicate rows per item; keep the first before enforcing uniqueness.
DELETE FROM "audit_items" a USING "audit_items" b WHERE a."audit_id" = b."audit_id" AND a."item_id" = b."item_id" AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "audit_items_audit_item_uq" ON "audit_items" USING btree ("audit_id","item_id");