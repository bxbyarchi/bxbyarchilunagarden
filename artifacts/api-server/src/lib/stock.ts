import { db, itemsTable, warehouseStockTable, type StockMoveKind } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Keeps items.currentStock = sum of per-department stock (as receipts do). */
export async function refreshItemTotal(tx: Tx, itemId: number) {
  await tx.update(itemsTable).set({
    currentStock: sql`(SELECT COALESCE(SUM(CAST(${warehouseStockTable.currentStock} AS DECIMAL)), 0) FROM ${warehouseStockTable} WHERE ${warehouseStockTable.itemId} = ${itemId})`,
  }).where(eq(itemsTable.id, itemId));
}

/**
 * Adds `delta` (negative = write-off) to one item's stock in one department.
 * Sales may push stock below zero on purpose: a sale is never refused because
 * the books are behind reality — the negative balance shows what to receive/count.
 */
export async function addStock(tx: Tx, itemId: number, locationId: number, delta: number) {
  await tx.insert(warehouseStockTable).values({ itemId, locationId, currentStock: String(delta) })
    .onConflictDoUpdate({ target: [warehouseStockTable.itemId, warehouseStockTable.locationId], set: { currentStock: sql`CAST(${warehouseStockTable.currentStock} AS DECIMAL) + ${delta}` } });
  await refreshItemTotal(tx, itemId);
}

/**
 * Labels the stock changes of the current transaction for the ledger (the
 * warehouse_stock trigger reads these settings). Transaction-local: call it
 * inside db.transaction, before the stock updates. Call again to change the
 * label mid-transaction (e.g. production: ingredients out, then product in).
 */
export async function moveContext(tx: Tx, kind: StockMoveKind, refId?: number | null, userId?: string | null) {
  await tx.execute(sql`SELECT set_config('lg.move_kind', ${kind}, true), set_config('lg.move_ref', ${refId != null ? String(refId) : ""}, true), set_config('lg.user', ${userId ?? ""}, true)`);
}
