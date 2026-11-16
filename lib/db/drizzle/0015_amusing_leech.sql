CREATE TABLE "counterparties" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'company' NOT NULL,
	"roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"contact_person" text,
	"phone" text,
	"phone2" text,
	"email" text,
	"telegram" text,
	"address" text,
	"tax_id" text,
	"bank_details" text,
	"payment_terms" text,
	"rating" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_clerk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_kind_ck" CHECK ("counterparties"."kind" in ('company', 'person')),
	CONSTRAINT "counterparties_rating_ck" CHECK ("counterparties"."rating" is null or "counterparties"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "counterparty_id" integer;--> statement-breakpoint
CREATE INDEX "counterparties_name_idx" ON "counterparties" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "counterparties_roles_idx" ON "counterparties" USING gin ("roles");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing free-text suppliers become directory entries and their receipts get linked.
INSERT INTO "counterparties" ("kind", "roles", "name", "notes")
SELECT 'company', ARRAY['supplier'], MIN(TRIM("supplier")), 'Создан автоматически из истории поступлений'
FROM "receipts" WHERE "supplier" IS NOT NULL AND TRIM("supplier") <> ''
GROUP BY LOWER(TRIM("supplier"));--> statement-breakpoint
UPDATE "receipts" r SET "counterparty_id" = c."id"
FROM "counterparties" c
WHERE r."supplier" IS NOT NULL AND LOWER(TRIM(r."supplier")) = LOWER(c."name") AND 'supplier' = ANY(c."roles");
