import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, salesTable, saleItemsTable, returnsTable, saleStockMovementsTable, writeOffsTable, receiptsTable, moneyRequestsTable, staffTable, staffSchedulesTable, attendanceTable } from "@workspace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getWarehouseScope } from "../lib/warehouseScope";
import { localDateTime } from "../lib/ai/helpers";
import { isDate, addDays, summarize, type PlanRow, type PresenceRow } from "../lib/timesheet";
import { buildPnl, previousPeriod } from "../lib/finance";

const router: IRouter = Router();
// Profit and payroll are sensitive: owner, managers and accounting only.
const FINANCE = ["super_admin", "manager", "accountant"];

export async function gather(from: string, to: string) {
  const start = localDateTime(from, "00:00")!, end = localDateTime(addDays(to, 1), "00:00")!;
  const inSales = and(gte(salesTable.createdAt, start), lt(salesTable.createdAt, end));
  const sales = await db.select({ method: salesTable.paymentMethod, amount: sql<string>`coalesce(sum(${salesTable.totalAmount}), 0)`, checks: sql<number>`count(*)::int` })
    .from(salesTable).where(inSales).groupBy(salesTable.paymentMethod);
  const [ret] = await db.select({ v: sql<string>`coalesce(sum(${returnsTable.amount}), 0)` }).from(returnsTable).where(and(gte(returnsTable.createdAt, start), lt(returnsTable.createdAt, end)));
  const [cogs] = await db.select({ v: sql<string>`coalesce(sum(${saleStockMovementsTable.qty} * ${saleStockMovementsTable.unitCost}), 0)` })
    .from(saleStockMovementsTable).innerJoin(saleItemsTable, eq(saleItemsTable.id, saleStockMovementsTable.saleItemId)).innerJoin(salesTable, eq(salesTable.id, saleItemsTable.saleId)).where(inSales);
  const writeOffs = await db.select({ reason: writeOffsTable.reason, value: sql<string>`coalesce(sum(${writeOffsTable.totalValue}), 0)` })
    .from(writeOffsTable).where(and(gte(writeOffsTable.createdAt, start), lt(writeOffsTable.createdAt, end))).groupBy(writeOffsTable.reason);
  const [purchases] = await db.select({ v: sql<string>`coalesce(sum(${receiptsTable.totalCost}), 0)` }).from(receiptsTable).where(and(gte(receiptsTable.createdAt, start), lt(receiptsTable.createdAt, end)));
  // Money that actually left: invoices and reimbursements paid, advances by what the receipts show.
  const money = await db.select({ category: moneyRequestsTable.expenseCategory, amount: sql<string>`sum(CASE WHEN ${moneyRequestsTable.kind} = 'advance' THEN coalesce(${moneyRequestsTable.amountSpent}, 0) ELSE coalesce(${moneyRequestsTable.amountIssued}, 0) END)` })
    .from(moneyRequestsTable).where(and(eq(moneyRequestsTable.status, "closed"), gte(moneyRequestsTable.closedAt, start), lt(moneyRequestsTable.closedAt, end))).groupBy(moneyRequestsTable.expenseCategory);
  // Payroll as the timesheet accrues it.
  const staff = await db.select().from(staffTable);
  const ids = staff.map((s) => s.id);
  const plans = ids.length ? await db.select().from(staffSchedulesTable).where(and(inArray(staffSchedulesTable.staffId, ids), gte(staffSchedulesTable.date, from), sql`${staffSchedulesTable.date} <= ${to}`)) : [];
  const presence = ids.length ? await db.select().from(attendanceTable).where(and(gte(attendanceTable.checkInAt, start), lt(attendanceTable.checkInAt, end))) : [];
  const rates = new Map(staff.map((s) => [s.id, { hourlyRate: s.hourlyRate == null ? null : Number(s.hourlyRate), shiftRate: s.shiftRate == null ? null : Number(s.shiftRate) }]));
  const ts = summarize(ids, plans as PlanRow[], presence as PresenceRow[], rates, { now: new Date() });
  const dept = new Map(staff.map((s) => [s.id, s.department]));
  return buildPnl({
    sales: sales.map((s) => ({ method: s.method, amount: Number(s.amount), checks: s.checks })),
    returns: Number(ret.v), cogs: Number(cogs.v),
    writeOffs: writeOffs.map((w) => ({ reason: w.reason, value: Number(w.value) })),
    payroll: ts.filter((t) => t.pay).map((t) => ({ department: dept.get(t.staffId) ?? null, pay: t.pay })),
    money: money.map((m) => ({ category: m.category, amount: Number(m.amount) })),
    purchases: Number(purchases.v),
  });
}

router.get("/reports/pnl", requireAuth(), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!FINANCE.includes(scope.role)) { res.status(403).json({ error: "Финансовый отчёт доступен владельцу, управляющим и бухгалтеру" }); return; }
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) { res.status(400).json({ error: "Укажите период" }); return; }
  if (Date.parse(to) - Date.parse(from) > 400 * 86400_000) { res.status(400).json({ error: "Период не больше 400 дней" }); return; }
  const prev = previousPeriod(from, to);
  const start = localDateTime(from, "00:00")!, end = localDateTime(addDays(to, 1), "00:00")!;
  const [current, previous, byDay] = await Promise.all([
    gather(from, to), gather(prev.from, prev.to),
    db.select({
      day: sql<string>`to_char(${salesTable.createdAt} AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD')`,
      revenue: sql<string>`coalesce(sum(${salesTable.totalAmount}), 0)`, checks: sql<number>`count(*)::int`,
    }).from(salesTable).where(and(gte(salesTable.createdAt, start), lt(salesTable.createdAt, end))).groupBy(sql`1`).orderBy(sql`1`),
  ]);
  res.json({ from, to, previousPeriod: prev, current, previous, byDay: byDay.map((d) => ({ day: d.day, revenue: Number(d.revenue), checks: d.checks })) });
});

export default router;
