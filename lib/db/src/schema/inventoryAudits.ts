import { pgTable, serial, text, timestamp, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { itemsTable } from "./items";
import { locationsTable } from "./locations";

/**
 * Инвентаризация подразделения. При создании фиксируются учётные остатки
 * (systemStock) и цены; при проведении к текущему остатку применяется
 * разница «факт − учёт», так что движения во время пересчёта не теряются.
 */
export const inventoryAuditsTable = pgTable("inventory_audits", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("draft"),
  notes: text("notes"),
  createdByClerkId: text("created_by_clerk_id"),
  submittedByClerkId: text("submitted_by_clerk_id"),
  // Итоги, фиксируются при проведении (сом).
  shortageValue: numeric("shortage_value", { precision: 14, scale: 2 }),
  surplusValue: numeric("surplus_value", { precision: 14, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
});

export const auditItemsTable = pgTable("audit_items", {
  id: serial("id").primaryKey(),
  auditId: integer("audit_id").notNull().references(() => inventoryAuditsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  // Количества — в единице учёта позиции (items.unit).
  systemStock: numeric("system_stock", { precision: 12, scale: 3 }).notNull(),
  actualStock: numeric("actual_stock", { precision: 12, scale: 3 }),
  unitPrice: numeric("unit_price", { precision: 12, scale: 4 }).notNull().default("0"),
}, (t) => ({
  auditItemUnique: uniqueIndex("audit_items_audit_item_uq").on(t.auditId, t.itemId),
}));

export const insertInventoryAuditSchema = createInsertSchema(inventoryAuditsTable).omit({ id: true, createdAt: true, submittedAt: true });
export type InsertInventoryAudit = z.infer<typeof insertInventoryAuditSchema>;
export type InventoryAudit = typeof inventoryAuditsTable.$inferSelect;
export type AuditItem = typeof auditItemsTable.$inferSelect;
