import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { requireRole, requireVenueRole } from "../middleware/rbac";
import {
  db, stockLedgerTable, itemsTable, categoriesTable, locationsTable, usersTable, receiptsTable, counterpartiesTable,
  shiftsTable, registersTable, housesTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope, isWarehouseAdmin } from "../lib/warehouseScope";
import { isVenueAdmin } from "../lib/venueScope";
import { buildMovement, MOVEMENT_COLUMNS } from "../lib/movementMath";

const router: IRouter = Router();
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  };
}

const DAY = 24 * 3600 * 1000;
function day(v: unknown, fallback: Date): Date {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}
/** [from, to) for a period given as inclusive days; defaults to the current month. */
function period(q: Record<string, unknown>) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = day(q.from, new Date(today.getFullYear(), today.getMonth(), 1));
  const to = new Date(day(q.to, today).getTime() + DAY);
  if (to <= from) throw new HttpError(400, "Дата «по» раньше даты «с»");
  if (to.getTime() - from.getTime() > 400 * DAY) throw new HttpError(400, "Период не больше 400 дней");
  return { from, to };
}
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Departments the caller may see: all for warehouse admins, else their own. */
async function locationScope(req: Request): Promise<number | null> {
  const scope = await getWarehouseScope(req);
  if (!scope) throw new HttpError(403, "Пользователь не настроен");
  const requested = req.query.locationId ? Number(req.query.locationId) : null;
  if (isWarehouseAdmin(scope.role)) return requested;
  if (!scope.locationId) throw new HttpError(403, "Вам не назначен склад");
  return scope.locationId;
}

async function itemInfo() {
  const rows = await db.select({ id: itemsTable.id, name: itemsTable.name, unit: itemsTable.unit, price: itemsTable.pricePerUnit, category: categoriesTable.name, categoryId: itemsTable.categoryId })
    .from(itemsTable).leftJoin(categoriesTable, eq(itemsTable.categoryId, categoriesTable.id));
  return new Map(rows.map((r) => [r.id, { ...r, price: Number(r.price) }]));
}
async function locationNames() {
  const rows = await db.select({ id: locationsTable.id, name: locationsTable.name }).from(locationsTable);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ─── Stock movement ─────────────────────────────────────────────────────────

router.get("/reports/stock-movement", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const { from, to } = period(req.query);
  const locationId = await locationScope(req);
  const conds: SQL[] = [lt(stockLedgerTable.createdAt, to)];
  if (locationId) conds.push(eq(stockLedgerTable.locationId, locationId));
  if (req.query.itemId) conds.push(eq(stockLedgerTable.itemId, Number(req.query.itemId)));
  const inRange = sql<boolean>`${stockLedgerTable.createdAt} >= ${from}`;
  const sums = await db.select({
    itemId: stockLedgerTable.itemId, locationId: stockLedgerTable.locationId, kind: stockLedgerTable.kind,
    inRange, delta: sql<string>`SUM(${stockLedgerTable.delta})`,
  }).from(stockLedgerTable).where(and(...conds))
    // By position: the in-range flag is a parameterised expression Postgres won't match by text.
    .groupBy(sql`1, 2, 3, 4`);

  const [items, locs] = await Promise.all([itemInfo(), locationNames()]);
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
  const rows = buildMovement(sums.map((s) => ({ ...s, delta: Number(s.delta) })))
    .filter((r) => !categoryId || items.get(r.itemId)?.categoryId === categoryId)
    .map((r) => {
      const it = items.get(r.itemId);
      return { ...r, name: it?.name ?? `#${r.itemId}`, unit: it?.unit ?? "", category: it?.category ?? null, locationName: locs.get(r.locationId) ?? null, price: it?.price ?? 0, closingValue: Math.round(r.closing * (it?.price ?? 0) * 100) / 100 };
    })
    .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? "") || (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
  res.json({ from: isoDay(from), to: isoDay(new Date(to.getTime() - DAY)), columns: MOVEMENT_COLUMNS, rows, closingValue: Math.round(rows.reduce((s, r) => s + r.closingValue, 0) * 100) / 100 });
}));

/** Every ledger entry of one item (optionally one department) in a period, with running balance. */
router.get("/reports/stock-movement/:itemId", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const { from, to } = period(req.query);
  const locationId = await locationScope(req);
  const itemId = Number(req.params.itemId);
  const conds: SQL[] = [eq(stockLedgerTable.itemId, itemId), gte(stockLedgerTable.createdAt, from), lt(stockLedgerTable.createdAt, to)];
  if (locationId) conds.push(eq(stockLedgerTable.locationId, locationId));
  const rows = await db.select({
    id: stockLedgerTable.id, createdAt: stockLedgerTable.createdAt, locationId: stockLedgerTable.locationId, locationName: locationsTable.name,
    kind: stockLedgerTable.kind, refId: stockLedgerTable.refId, delta: stockLedgerTable.delta, balanceAfter: stockLedgerTable.balanceAfter,
    userName: sql<string | null>`NULLIF(TRIM(COALESCE(${usersTable.firstName}, '') || ' ' || COALESCE(${usersTable.lastName}, '')), '')`,
  }).from(stockLedgerTable)
    .leftJoin(locationsTable, eq(stockLedgerTable.locationId, locationsTable.id))
    .leftJoin(usersTable, eq(stockLedgerTable.userId, usersTable.clerkUserId))
    .where(and(...conds)).orderBy(asc(stockLedgerTable.createdAt), asc(stockLedgerTable.id)).limit(2000);
  const item = (await itemInfo()).get(itemId);
  res.json({ item: item ?? null, rows: rows.map((r) => ({ ...r, delta: Number(r.delta), balanceAfter: Number(r.balanceAfter) })) });
}));

// ─── Stock on a date ────────────────────────────────────────────────────────

router.get("/reports/stock-on-date", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const at = new Date(day(req.query.date, today).getTime() + DAY); // end of the chosen day
  const locationId = await locationScope(req);
  const conds: SQL[] = [lt(stockLedgerTable.createdAt, at)];
  if (locationId) conds.push(eq(stockLedgerTable.locationId, locationId));
  const sums = await db.select({ itemId: stockLedgerTable.itemId, locationId: stockLedgerTable.locationId, qty: sql<string>`SUM(${stockLedgerTable.delta})` })
    .from(stockLedgerTable).where(and(...conds)).groupBy(stockLedgerTable.itemId, stockLedgerTable.locationId);
  const [items, locs] = await Promise.all([itemInfo(), locationNames()]);
  const rows = sums.map((s) => {
    const it = items.get(s.itemId); const qty = Math.round(Number(s.qty) * 10000) / 10000;
    return { itemId: s.itemId, name: it?.name ?? `#${s.itemId}`, unit: it?.unit ?? "", category: it?.category ?? null, locationId: s.locationId, locationName: locs.get(s.locationId) ?? null, qty, price: it?.price ?? 0, value: Math.round(qty * (it?.price ?? 0) * 100) / 100 };
  }).filter((r) => r.qty !== 0)
    .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? "") || (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
  res.json({ date: isoDay(new Date(at.getTime() - DAY)), rows, totalValue: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100, negative: rows.filter((r) => r.qty < 0).length });
}));

// ─── Purchases by supplier ──────────────────────────────────────────────────

router.get("/reports/purchases", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const { from, to } = period(req.query);
  const rows = await db.select({
    counterpartyId: receiptsTable.counterpartyId, name: sql<string>`COALESCE(${counterpartiesTable.name}, NULLIF(TRIM(${receiptsTable.supplier}), ''), 'Без поставщика')`,
    category: counterpartiesTable.category,
    receipts: sql<number>`COUNT(*)::int`, items: sql<number>`COUNT(DISTINCT ${receiptsTable.itemId})::int`,
    total: sql<string>`SUM(CAST(${receiptsTable.totalCost} AS DECIMAL))`, last: sql<string>`MAX(${receiptsTable.createdAt})`,
  }).from(receiptsTable).leftJoin(counterpartiesTable, eq(receiptsTable.counterpartyId, counterpartiesTable.id))
    .where(and(gte(receiptsTable.createdAt, from), lt(receiptsTable.createdAt, to)))
    .groupBy(receiptsTable.counterpartyId, counterpartiesTable.name, counterpartiesTable.category, sql`COALESCE(${counterpartiesTable.name}, NULLIF(TRIM(${receiptsTable.supplier}), ''), 'Без поставщика')`)
    .orderBy(desc(sql`SUM(CAST(${receiptsTable.totalCost} AS DECIMAL))`));
  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  res.json({
    from: isoDay(from), to: isoDay(new Date(to.getTime() - DAY)), total: Math.round(total * 100) / 100,
    rows: rows.map((r) => ({ ...r, total: Number(r.total), share: total > 0 ? Math.round((Number(r.total) / total) * 1000) / 10 : 0 })),
  });
}));

// ─── Cash by shift ──────────────────────────────────────────────────────────

router.get("/reports/cash", requireAuth(), requireVenueRole("location_admin"), handle(async (req, res) => {
  const { from, to } = period(req.query);
  const scope = await getWarehouseScope(req);
  if (!scope) throw new HttpError(403, "Пользователь не настроен");
  const conds: SQL[] = [gte(shiftsTable.openedAt, from), lt(shiftsTable.openedAt, to)];
  if (!isVenueAdmin(scope.role)) {
    if (!scope.locationId) throw new HttpError(403, "Вам не назначена площадка");
    conds.push(eq(housesTable.locationId, scope.locationId));
  }
  if (req.query.houseId) conds.push(eq(housesTable.id, Number(req.query.houseId)));
  const rows = await db.select({
    id: shiftsTable.id, openedAt: shiftsTable.openedAt, closedAt: shiftsTable.closedAt, status: shiftsTable.status,
    pointName: housesTable.name, registerName: registersTable.name, cashierName: shiftsTable.cashierName,
    openingCash: shiftsTable.openingCash, salesCash: shiftsTable.totalSalesCash, salesCard: shiftsTable.totalSalesCard,
    returns: shiftsTable.totalReturns, returnsCash: shiftsTable.totalReturnsCash,
    collected: shiftsTable.totalCollected, deposited: shiftsTable.totalDeposited,
    expected: shiftsTable.expectedCash, counted: shiftsTable.closingCashCounted, difference: shiftsTable.cashDifference,
  }).from(shiftsTable)
    .innerJoin(registersTable, eq(shiftsTable.registerId, registersTable.id))
    .innerJoin(housesTable, eq(registersTable.houseId, housesTable.id))
    .where(and(...conds)).orderBy(desc(shiftsTable.openedAt)).limit(1000);
  const n = (v: string | null) => (v == null ? null : Number(v));
  const out = rows.map((r) => {
    const returnsCash = Number(r.returnsCash), returns = Number(r.returns);
    const expectedNow = Number(r.openingCash) + Number(r.salesCash) - returnsCash - Number(r.collected) + Number(r.deposited);
    return {
      ...r, openingCash: Number(r.openingCash), salesCash: Number(r.salesCash), salesCard: Number(r.salesCard),
      returnsCash, returnsCard: Math.round((returns - returnsCash) * 100) / 100, collected: Number(r.collected), deposited: Number(r.deposited),
      revenue: Math.round((Number(r.salesCash) + Number(r.salesCard) - returns) * 100) / 100,
      expected: n(r.expected) ?? Math.round(expectedNow * 100) / 100, counted: n(r.counted), difference: n(r.difference),
    };
  });
  const sum = (k: "salesCash" | "salesCard" | "returnsCash" | "returnsCard" | "collected" | "deposited" | "revenue") => Math.round(out.reduce((s, r) => s + r[k], 0) * 100) / 100;
  res.json({
    from: isoDay(from), to: isoDay(new Date(to.getTime() - DAY)), shifts: out,
    totals: {
      salesCash: sum("salesCash"), salesCard: sum("salesCard"), returnsCash: sum("returnsCash"), returnsCard: sum("returnsCard"),
      collected: sum("collected"), deposited: sum("deposited"), revenue: sum("revenue"),
      shortage: Math.round(out.reduce((s, r) => s + Math.min(r.difference ?? 0, 0), 0) * 100) / 100,
      surplus: Math.round(out.reduce((s, r) => s + Math.max(r.difference ?? 0, 0), 0) * 100) / 100,
    },
  });
}));

export default router;
