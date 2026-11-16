import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { requireVenueRole } from "../middleware/rbac";
import { db, salesTable, saleItemsTable, registersTable, housesTable, productsTable, returnsTable, saleStockMovementsTable } from "@workspace/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getWarehouseScope } from "../lib/warehouseScope";
import { isVenueAdmin } from "../lib/venueScope";
import { aggregateMargin, type MarginLine } from "../lib/marginMath";

const router: IRouter = Router();

function parseDay(v: unknown, fallback: Date): Date {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Actual cost and margin of sales: revenue after the receipt discount and
 * refunds, cost = what was really written off for the line (restocks netted).
 */
router.get("/reports/sales-margin", requireAuth(), requireVenueRole("location_admin"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = parseDay(req.query.from, new Date(today.getFullYear(), today.getMonth(), 1));
  const toDay = parseDay(req.query.to, today);
  const to = new Date(toDay.getTime() + 24 * 3600 * 1000); // inclusive end day
  if (to.getTime() - from.getTime() > 400 * 24 * 3600 * 1000) { res.status(400).json({ error: "Период не больше 400 дней" }); return; }

  const locationId = isVenueAdmin(scope.role) ? (req.query.locationId ? Number(req.query.locationId) : null) : scope.locationId;
  if (!isVenueAdmin(scope.role) && !locationId) { res.status(403).json({ error: "Вам не назначена площадка" }); return; }
  const houseId = req.query.houseId ? Number(req.query.houseId) : null;

  const conds = [gte(salesTable.createdAt, from), lt(salesTable.createdAt, to)];
  if (locationId) conds.push(eq(housesTable.locationId, locationId));
  if (houseId) conds.push(eq(housesTable.id, houseId));

  const refunded = db.$with("refunded").as(
    db.select({ saleItemId: returnsTable.saleItemId, amount: sql<string>`SUM(CAST(${returnsTable.amount} AS DECIMAL))`.as("amount") })
      .from(returnsTable).groupBy(returnsTable.saleItemId),
  );
  const costs = db.$with("costs").as(
    db.select({ saleItemId: saleStockMovementsTable.saleItemId, cost: sql<string>`SUM(CAST(${saleStockMovementsTable.qty} AS DECIMAL) * CAST(${saleStockMovementsTable.unitCost} AS DECIMAL))`.as("cost") })
      .from(saleStockMovementsTable).groupBy(saleStockMovementsTable.saleItemId),
  );

  const rows = await db.with(refunded, costs).select({
    productId: saleItemsTable.productId,
    name: saleItemsTable.name,
    category: productsTable.category,
    linked: sql<boolean>`(${productsTable.techCardId} IS NOT NULL OR ${productsTable.itemId} IS NOT NULL)`,
    day: sql<string>`to_char(${salesTable.createdAt}, 'YYYY-MM-DD')`,
    quantity: saleItemsTable.quantity,
    returnedQuantity: saleItemsTable.returnedQuantity,
    lineTotal: saleItemsTable.totalPrice,
    discountPercent: salesTable.discountPercent,
    refunded: refunded.amount,
    cost: costs.cost,
  }).from(saleItemsTable)
    .innerJoin(salesTable, eq(saleItemsTable.saleId, salesTable.id))
    .innerJoin(registersTable, eq(salesTable.registerId, registersTable.id))
    .innerJoin(housesTable, eq(registersTable.houseId, housesTable.id))
    .leftJoin(productsTable, eq(saleItemsTable.productId, productsTable.id))
    .leftJoin(refunded, eq(refunded.saleItemId, saleItemsTable.id))
    .leftJoin(costs, eq(costs.saleItemId, saleItemsTable.id))
    .where(and(...conds));

  const lines: MarginLine[] = rows.map((r) => ({
    key: r.productId != null ? `p${r.productId}` : `n:${r.name}`,
    name: r.name,
    category: r.category ?? "Свободная цена",
    day: r.day,
    linked: !!r.linked,
    soldQty: Number(r.quantity) - Number(r.returnedQuantity),
    revenue: Number(r.lineTotal) * (1 - Number(r.discountPercent) / 100) - Number(r.refunded ?? 0),
    cost: Number(r.cost ?? 0),
  }));

  res.json({ from: from.toISOString().slice(0, 10), to: toDay.toISOString().slice(0, 10), ...aggregateMargin(lines) });
});

export default router;
