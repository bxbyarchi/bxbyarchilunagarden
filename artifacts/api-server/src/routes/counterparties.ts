import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { requireRole } from "../middleware/rbac";
import { db, counterpartiesTable, receiptsTable, itemsTable, COUNTERPARTY_ROLES } from "@workspace/db";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";

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

const TEXT_FIELDS = { category: 100, contactPerson: 200, phone: 50, phone2: 50, email: 200, telegram: 100, address: 500, taxId: 50, bankDetails: 2000, paymentTerms: 200, notes: 5000 } as const;
type TextField = keyof typeof TEXT_FIELDS;

/** Validates create/update input. `partial` = PATCH (only provided fields). */
function parseBody(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 200) throw new HttpError(400, "Укажите название (до 200 символов)");
    out.name = name;
  }
  if (!partial || body.kind !== undefined) out.kind = body.kind === "person" ? "person" : "company";
  if (!partial || body.roles !== undefined) {
    const roles = Array.isArray(body.roles) ? [...new Set(body.roles.filter((r): r is string => (COUNTERPARTY_ROLES as readonly string[]).includes(r as string)))] : [];
    if (!roles.length) throw new HttpError(400, "Выберите хотя бы одну роль: поставщик, клиент, услуги или специалист");
    out.roles = roles;
  }
  for (const [k, max] of Object.entries(TEXT_FIELDS) as Array<[TextField, number]>) {
    if (body[k] === undefined) continue;
    const v = typeof body[k] === "string" ? (body[k] as string).trim() : "";
    if (v.length > max) throw new HttpError(400, `Слишком длинное поле: ${k}`);
    out[k] = v || null;
  }
  if (typeof out.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new HttpError(400, "Неверный email");
  if (body.rating !== undefined) {
    const r = body.rating === null || body.rating === "" ? null : Number(body.rating);
    if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 5)) throw new HttpError(400, "Оценка — от 1 до 5");
    out.rating = r;
  }
  if (body.isActive !== undefined) out.isActive = body.isActive !== false;
  return out;
}

async function assertUniqueName(name: string, exceptId: number | null) {
  const [dup] = await db.select({ id: counterpartiesTable.id }).from(counterpartiesTable)
    .where(and(sql`lower(${counterpartiesTable.name}) = ${name.toLowerCase()}`, eq(counterpartiesTable.isActive, true), exceptId ? sql`${counterpartiesTable.id} <> ${exceptId}` : undefined));
  if (dup) throw new HttpError(409, `Контрагент «${name}» уже есть в справочнике`);
}

const supplied = db.$with("supplied").as(
  db.select({
    counterpartyId: receiptsTable.counterpartyId,
    receiptsCount: sql<number>`COUNT(*)::int`.as("receipts_count"),
    receiptsTotal: sql<string>`SUM(CAST(${receiptsTable.totalCost} AS DECIMAL))`.as("receipts_total"),
    lastReceiptAt: sql<string>`MAX(${receiptsTable.createdAt})`.as("last_receipt_at"),
  }).from(receiptsTable).groupBy(receiptsTable.counterpartyId),
);

router.get("/counterparties", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const { q, role, category, includeInactive } = req.query;
  const conds: SQL[] = [];
  if (includeInactive !== "1") conds.push(eq(counterpartiesTable.isActive, true));
  if (typeof role === "string" && (COUNTERPARTY_ROLES as readonly string[]).includes(role)) conds.push(sql`${role} = ANY(${counterpartiesTable.roles})`);
  if (typeof category === "string" && category) conds.push(sql`lower(${counterpartiesTable.category}) = ${category.toLowerCase()}`);
  if (typeof q === "string" && q.trim()) {
    const term = `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`;
    const digits = q.replace(/\D/g, "");
    conds.push(or(
      ilike(counterpartiesTable.name, term), ilike(counterpartiesTable.category, term), ilike(counterpartiesTable.contactPerson, term),
      ilike(counterpartiesTable.notes, term), ilike(counterpartiesTable.email, term), ilike(counterpartiesTable.taxId, term),
      // Phone search ignores spaces, dashes and the +996 prefix formatting.
      ...(digits.length >= 3 ? [sql`regexp_replace(coalesce(${counterpartiesTable.phone}, '') || ' ' || coalesce(${counterpartiesTable.phone2}, ''), '\\D', '', 'g') LIKE ${`%${digits}%`}`] : []),
    )!);
  }
  const rows = await db.with(supplied).select({
    id: counterpartiesTable.id, kind: counterpartiesTable.kind, roles: counterpartiesTable.roles, name: counterpartiesTable.name,
    category: counterpartiesTable.category, contactPerson: counterpartiesTable.contactPerson, phone: counterpartiesTable.phone,
    telegram: counterpartiesTable.telegram, rating: counterpartiesTable.rating, isActive: counterpartiesTable.isActive,
    receiptsCount: supplied.receiptsCount, receiptsTotal: supplied.receiptsTotal, lastReceiptAt: supplied.lastReceiptAt,
  }).from(counterpartiesTable)
    .leftJoin(supplied, eq(supplied.counterpartyId, counterpartiesTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(counterpartiesTable.name)
    .limit(1000);
  res.json(rows.map((r) => ({ ...r, receiptsCount: r.receiptsCount ?? 0, receiptsTotal: Number(r.receiptsTotal ?? 0) })));
}));

router.get("/counterparties/categories", requireAuth(), requireRole("warehouse"), handle(async (_req, res) => {
  const rows = await db.select({ category: counterpartiesTable.category, count: sql<number>`COUNT(*)::int` }).from(counterpartiesTable)
    .where(and(eq(counterpartiesTable.isActive, true), sql`${counterpartiesTable.category} IS NOT NULL`))
    .groupBy(counterpartiesTable.category).orderBy(counterpartiesTable.category);
  res.json(rows);
}));

router.get("/counterparties/:id", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const id = Number(req.params.id);
  const cp = await db.query.counterpartiesTable.findFirst({ where: eq(counterpartiesTable.id, id) });
  if (!cp) throw new HttpError(404, "Контрагент не найден");
  const [stats] = await db.select({
    count: sql<number>`COUNT(*)::int`, total: sql<string>`COALESCE(SUM(CAST(${receiptsTable.totalCost} AS DECIMAL)), 0)`,
    first: sql<string | null>`MIN(${receiptsTable.createdAt})`, last: sql<string | null>`MAX(${receiptsTable.createdAt})`,
  }).from(receiptsTable).where(eq(receiptsTable.counterpartyId, id));
  const items = await db.select({
    itemId: receiptsTable.itemId, name: itemsTable.name, unit: itemsTable.unit,
    qty: sql<string>`SUM(CAST(${receiptsTable.quantity} AS DECIMAL))`, total: sql<string>`SUM(CAST(${receiptsTable.totalCost} AS DECIMAL))`,
    lastPrice: sql<string>`(array_agg(${receiptsTable.pricePerUnit} ORDER BY ${receiptsTable.createdAt} DESC))[1]`,
    lastAt: sql<string>`MAX(${receiptsTable.createdAt})`,
  }).from(receiptsTable).leftJoin(itemsTable, eq(receiptsTable.itemId, itemsTable.id))
    .where(eq(receiptsTable.counterpartyId, id)).groupBy(receiptsTable.itemId, itemsTable.name, itemsTable.unit)
    .orderBy(desc(sql`SUM(CAST(${receiptsTable.totalCost} AS DECIMAL))`)).limit(50);
  const recent = await db.select({
    id: receiptsTable.id, itemName: itemsTable.name, unit: itemsTable.unit, quantity: receiptsTable.quantity,
    pricePerUnit: receiptsTable.pricePerUnit, totalCost: receiptsTable.totalCost, createdAt: receiptsTable.createdAt,
  }).from(receiptsTable).leftJoin(itemsTable, eq(receiptsTable.itemId, itemsTable.id))
    .where(eq(receiptsTable.counterpartyId, id)).orderBy(desc(receiptsTable.createdAt)).limit(30);
  res.json({
    ...cp,
    stats: { receiptsCount: stats.count, receiptsTotal: Number(stats.total), firstReceiptAt: stats.first, lastReceiptAt: stats.last },
    items: items.map((i) => ({ ...i, qty: Number(i.qty), total: Number(i.total), lastPrice: Number(i.lastPrice) })),
    recentReceipts: recent.map((r) => ({ ...r, quantity: Number(r.quantity), pricePerUnit: Number(r.pricePerUnit), totalCost: Number(r.totalCost) })),
  });
}));

router.post("/counterparties", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const values = parseBody(req.body as Record<string, unknown>, false);
  await assertUniqueName(values.name as string, null);
  const [row] = await db.insert(counterpartiesTable).values({ ...(values as typeof counterpartiesTable.$inferInsert), createdByClerkId: req.auth?.userId ?? null }).returning();
  await logAudit({ action: "create", entityType: "counterparty", entityId: row.id, clerkUserId: req.auth?.userId, details: row.name });
  res.status(201).json(row);
}));

router.patch("/counterparties/:id", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.query.counterpartiesTable.findFirst({ where: eq(counterpartiesTable.id, id) });
  if (!existing) throw new HttpError(404, "Контрагент не найден");
  const values = parseBody(req.body as Record<string, unknown>, true);
  if (values.name) await assertUniqueName(values.name as string, id);
  const [row] = await db.update(counterpartiesTable).set(values).where(eq(counterpartiesTable.id, id)).returning();
  await logAudit({ action: "update", entityType: "counterparty", entityId: id, clerkUserId: req.auth?.userId, details: row.name });
  res.json(row);
}));

/** Delete; a counterparty with receipts is archived instead so history keeps its supplier. */
router.delete("/counterparties/:id", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.query.counterpartiesTable.findFirst({ where: eq(counterpartiesTable.id, id) });
  if (!existing) throw new HttpError(404, "Контрагент не найден");
  const [used] = await db.select({ id: receiptsTable.id }).from(receiptsTable).where(eq(receiptsTable.counterpartyId, id)).limit(1);
  if (used) await db.update(counterpartiesTable).set({ isActive: false }).where(eq(counterpartiesTable.id, id));
  else await db.delete(counterpartiesTable).where(eq(counterpartiesTable.id, id));
  await logAudit({ action: "delete", entityType: "counterparty", entityId: id, clerkUserId: req.auth?.userId, details: used ? `${existing.name} — в архив (есть поступления)` : existing.name });
  res.json({ archived: !!used });
}));

export default router;
