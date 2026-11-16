import { pgTable, bigserial, integer, numeric, text, timestamp, index } from "drizzle-orm/pg-core";
import { itemsTable } from "./items";
import { locationsTable } from "./locations";

/** Kinds of stock movement written to the ledger (set per transaction, see lib/stock.ts). */
export const STOCK_MOVE_KINDS = [
  "opening", "item_create", "receipt", "receipt_edit", "receipt_delete", "write_off", "write_off_edit", "write_off_delete",
  "transfer_out", "transfer_in", "transfer_return", "production_out", "production_in", "production_cancel",
  "sale", "sale_return", "inventory", "manual_adjust", "telegram_receipt", "telegram_write_off", "other",
] as const;
export type StockMoveKind = (typeof STOCK_MOVE_KINDS)[number];

/**
 * Журнал складских движений. Пишется ТРИГГЕРОМ на warehouse_stock (миграция
 * 0016), поэтому в него попадает любое изменение остатка, а вид операции и
 * документ берутся из настроек транзакции lg.move_kind / lg.move_ref / lg.user.
 * Инвариант: сумма delta по позиции и подразделению = текущий остаток.
 */
export const stockLedgerTable = pgTable("stock_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").notNull().references(() => locationsTable.id, { onDelete: "cascade" }),
  delta: numeric("delta", { precision: 14, scale: 4 }).notNull(),
  balanceAfter: numeric("balance_after", { precision: 14, scale: 4 }).notNull(),
  kind: text("kind").notNull(),
  refId: integer("ref_id"),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  itemLocDateIdx: index("stock_ledger_item_loc_date_idx").on(t.itemId, t.locationId, t.createdAt),
  dateIdx: index("stock_ledger_date_idx").on(t.createdAt),
}));

export type StockLedgerRow = typeof stockLedgerTable.$inferSelect;
