import { pgTable, serial, text, timestamp, integer, numeric, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locationsTable } from "./locations";
import { itemsTable } from "./items";
import { techCardsTable } from "./techCards";

/**
 * Акт производства: по тех-карте полуфабриката в подразделении списано сырьё
 * и оприходован готовый полуфабрикат (outputItemId).
 * Количества: batches — число закладок; plannedOutput/actualOutput — в outputUnit
 * тех-карты; outputItemQty — сколько оприходовано в единице складской позиции.
 */
export const productionsTable = pgTable("productions", {
  id: serial("id").primaryKey(),
  techCardId: integer("tech_card_id").notNull().references(() => techCardsTable.id, { onDelete: "restrict" }),
  departmentId: integer("department_id").notNull().references(() => locationsTable.id, { onDelete: "restrict" }),
  batches: numeric("batches", { precision: 12, scale: 3 }).notNull(),
  plannedOutput: numeric("planned_output", { precision: 12, scale: 3 }).notNull(),
  actualOutput: numeric("actual_output", { precision: 12, scale: 3 }).notNull(),
  outputUnit: text("output_unit").notNull(),
  outputItemId: integer("output_item_id").notNull().references(() => itemsTable.id, { onDelete: "restrict" }),
  outputItemQty: numeric("output_item_qty", { precision: 12, scale: 4 }).notNull(),
  totalCost: numeric("total_cost", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull().default("done"),
  notes: text("notes"),
  recordedByClerkId: text("recorded_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByClerkId: text("cancelled_by_clerk_id"),
}, (t) => ({
  statusCheck: check("productions_status_ck", sql`${t.status} in ('done', 'cancelled')`),
  departmentIdx: index("productions_department_idx").on(t.departmentId, t.createdAt),
}));

/** Что списано по акту: позиция, количество в её единице, цена на момент списания. */
export const productionLinesTable = pgTable("production_lines", {
  id: serial("id").primaryKey(),
  productionId: integer("production_id").notNull().references(() => productionsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "restrict" }),
  qty: numeric("qty", { precision: 12, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 4 }).notNull(),
  cost: numeric("cost", { precision: 12, scale: 2 }).notNull(),
}, (t) => ({
  productionIdx: index("production_lines_production_idx").on(t.productionId),
}));

export type Production = typeof productionsTable.$inferSelect;
export type ProductionLine = typeof productionLinesTable.$inferSelect;
