import { db, itemsTable, warehouseStockTable } from "@workspace/db";
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
