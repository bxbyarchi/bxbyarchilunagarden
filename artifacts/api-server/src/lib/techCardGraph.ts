import { db, techCardsTable, techCardIngredientsTable, itemsTable, warehouseStockTable } from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";
import type { CardInfo, ItemInfo } from "./techCardMath";

/** Loads every card (semis can be referenced by any card) and the items they use. */
export async function loadGraph() {
  const [cardRows, ingRows] = await Promise.all([
    db.select().from(techCardsTable).orderBy(asc(techCardsTable.name)),
    db.select().from(techCardIngredientsTable).orderBy(asc(techCardIngredientsTable.sortOrder), asc(techCardIngredientsTable.id)),
  ]);
  const itemIds = [...new Set([...ingRows.map((r) => r.itemId), ...cardRows.map((c) => c.outputItemId)].filter((v): v is number => v != null))];
  const itemRows = itemIds.length
    ? await db.select({ id: itemsTable.id, name: itemsTable.name, unit: itemsTable.unit, pricePerUnit: itemsTable.pricePerUnit }).from(itemsTable).where(inArray(itemsTable.id, itemIds))
    : [];
  const items = new Map<number, ItemInfo>(itemRows.map((i) => [i.id, { id: i.id, name: i.name, unit: i.unit, pricePerUnit: Number(i.pricePerUnit) }]));
  const cards = new Map<number, CardInfo>();
  for (const c of cardRows) {
    cards.set(c.id, { id: c.id, name: c.name, kind: c.kind, outputQty: Number(c.outputQty), outputUnit: c.outputUnit, salePrice: c.salePrice == null ? null : Number(c.salePrice), outputItemId: c.outputItemId, departmentId: c.departmentId, ingredients: [] });
  }
  for (const r of ingRows) {
    cards.get(r.techCardId)?.ingredients.push({
      itemId: r.itemId, semiCardId: r.semiCardId, grossQty: Number(r.grossQty), unit: r.unit,
      coldLossPct: Number(r.coldLossPct), hotLossPct: Number(r.hotLossPct),
    });
  }
  return { cardRows, cards, items };
}

/** itemId → stock (in the item's unit) for one department. */
export async function departmentStock(departmentId: number | null): Promise<Map<number, number> | null> {
  if (departmentId == null) return null;
  const rows = await db.select({ itemId: warehouseStockTable.itemId, qty: warehouseStockTable.currentStock }).from(warehouseStockTable).where(eq(warehouseStockTable.locationId, departmentId));
  return new Map(rows.map((r) => [r.itemId, Number(r.qty)]));
}


/** Adds stock items that aren't referenced by any tech card (e.g. bottled drinks sold as is). */
export async function loadMoreItems(items: Map<number, ItemInfo>, ids: number[]) {
  const missing = [...new Set(ids)].filter((id) => !items.has(id));
  if (!missing.length) return;
  const rows = await db.select({ id: itemsTable.id, name: itemsTable.name, unit: itemsTable.unit, pricePerUnit: itemsTable.pricePerUnit }).from(itemsTable).where(inArray(itemsTable.id, missing));
  for (const r of rows) items.set(r.id, { id: r.id, name: r.name, unit: r.unit, pricePerUnit: Number(r.pricePerUnit) });
}
