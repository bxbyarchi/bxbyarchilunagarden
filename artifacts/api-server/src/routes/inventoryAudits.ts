import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db } from "@workspace/db";
import { inventoryAuditsTable, auditItemsTable, itemsTable, warehouseStockTable, locationsTable, categoriesTable, usersTable } from "@workspace/db";
import { eq, and, sql, inArray, desc, asc } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";
import { requireRole } from "../middleware/rbac";
import { sendLowStockAlert } from "../lib/telegramBot";
import { getWarehouseScope, canAccessLocation, locationExists, isWarehouseAdmin } from "../lib/warehouseScope";
import { auditLineMath, auditTotals } from "../lib/inventoryMath";
import { moveContext } from "../lib/stock";

const router: IRouter = Router();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  };
}

async function syncLegacyTotal(tx: Tx, itemId: number) {
  await tx.update(itemsTable).set({ currentStock: sql`COALESCE((SELECT SUM(CAST(${warehouseStockTable.currentStock} AS DECIMAL)) FROM ${warehouseStockTable} WHERE ${warehouseStockTable.itemId} = ${itemId}), 0)` }).where(eq(itemsTable.id, itemId));
}

/** Loads an audit the caller may access (their department, or any for admins). */
async function loadAudit(req: Request, id: number) {
  const audit = await db.query.inventoryAuditsTable.findFirst({ where: eq(inventoryAuditsTable.id, id) });
  if (!audit) throw new HttpError(404, "Инвентаризация не найдена");
  const scope = await getWarehouseScope(req);
  if (!scope || !canAccessLocation(scope, audit.locationId ?? -1)) throw new HttpError(403, "Нет доступа к этому подразделению");
  return audit;
}

function parseQty(v: unknown): number | null | undefined {
  if (v === null || v === "") return null; // clears the count
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new HttpError(400, "Количество должно быть числом от нуля");
  return n;
}

const userName = sql<string | null>`NULLIF(TRIM(COALESCE(${usersTable.firstName}, '') || ' ' || COALESCE(${usersTable.lastName}, '')), '')`;

// ─── List ────────────────────────────────────────────────────────────────────

router.get("/inventory-audits", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const scope = await getWarehouseScope(req);
  if (!scope) throw new HttpError(403, "Пользователь не настроен");
  const requested = req.query.locationId ? Number(req.query.locationId) : null;
  const conditions = [];
  if (!isWarehouseAdmin(scope.role)) {
    const own = requested ?? scope.locationId;
    if (!own || !canAccessLocation(scope, own)) { res.json([]); return; }
    conditions.push(eq(inventoryAuditsTable.locationId, own));
  } else if (requested) conditions.push(eq(inventoryAuditsTable.locationId, requested));

  const counted = sql<number>`COUNT(${auditItemsTable.actualStock})::int`;
  const diffValue = (sign: ">" | "<") => sql<string>`COALESCE(SUM(CASE WHEN ${auditItemsTable.actualStock} IS NOT NULL AND CAST(${auditItemsTable.actualStock} AS DECIMAL) ${sql.raw(sign)} CAST(${auditItemsTable.systemStock} AS DECIMAL) THEN ABS(CAST(${auditItemsTable.actualStock} AS DECIMAL) - CAST(${auditItemsTable.systemStock} AS DECIMAL)) * CAST(${auditItemsTable.unitPrice} AS DECIMAL) ELSE 0 END), 0)`;
  const rows = await db.select({
    id: inventoryAuditsTable.id, title: inventoryAuditsTable.title, locationId: inventoryAuditsTable.locationId,
    locationName: locationsTable.name, status: inventoryAuditsTable.status,
    createdAt: inventoryAuditsTable.createdAt, submittedAt: inventoryAuditsTable.submittedAt,
    itemsTotal: sql<number>`COUNT(${auditItemsTable.id})::int`, itemsCounted: counted,
    shortageValue: diffValue("<"), surplusValue: diffValue(">"),
  }).from(inventoryAuditsTable)
    .leftJoin(locationsTable, eq(inventoryAuditsTable.locationId, locationsTable.id))
    .leftJoin(auditItemsTable, eq(auditItemsTable.auditId, inventoryAuditsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(inventoryAuditsTable.id, locationsTable.name)
    .orderBy(desc(inventoryAuditsTable.createdAt));
  res.json(rows.map((r) => ({ ...r, shortageValue: Number(r.shortageValue), surplusValue: Number(r.surplusValue) })));
}));

// ─── Create ──────────────────────────────────────────────────────────────────

router.post("/inventory-audits", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const { title, locationId: rawLocation, scope: rawScope, notes } = req.body as Record<string, unknown>;
  const scope = await getWarehouseScope(req);
  if (!scope) throw new HttpError(403, "Пользователь не настроен");
  const locationId = rawLocation != null && rawLocation !== "" ? Number(rawLocation) : scope.locationId;
  if (!locationId || !Number.isInteger(locationId)) throw new HttpError(400, "Выберите подразделение");
  if (!canAccessLocation(scope, locationId)) throw new HttpError(403, "Нет доступа к этому подразделению");
  if (!(await locationExists(locationId))) throw new HttpError(400, "Подразделение не найдено");
  const location = await db.query.locationsTable.findFirst({ where: eq(locationsTable.id, locationId) });

  const openDraft = await db.query.inventoryAuditsTable.findFirst({ where: and(eq(inventoryAuditsTable.locationId, locationId), eq(inventoryAuditsTable.status, "draft")) });
  if (openDraft) throw new HttpError(409, `В подразделении уже идёт инвентаризация «${openDraft.title}» — завершите или удалите её`);

  // "stocked": only items that have ever had stock in this department (the usual case);
  // "all": every item in the catalogue (first inventory of a new department).
  const allItems = rawScope === "all";
  const finalTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, 200)
    : `Инвентаризация · ${location?.name ?? ""} · ${new Date().toLocaleDateString("ru-RU")}`;

  const audit = await db.transaction(async (tx) => {
    const [created] = await tx.insert(inventoryAuditsTable).values({
      title: finalTitle, locationId, status: "draft", createdByClerkId: req.auth?.userId ?? null,
      notes: typeof notes === "string" && notes.trim() ? notes.trim().slice(0, 2000) : null,
    }).returning();
    const stockJoin = and(eq(warehouseStockTable.itemId, itemsTable.id), eq(warehouseStockTable.locationId, locationId));
    const items = allItems
      ? await tx.select({ itemId: itemsTable.id, stock: warehouseStockTable.currentStock, price: itemsTable.pricePerUnit }).from(itemsTable).leftJoin(warehouseStockTable, stockJoin)
      : await tx.select({ itemId: itemsTable.id, stock: warehouseStockTable.currentStock, price: itemsTable.pricePerUnit }).from(itemsTable).innerJoin(warehouseStockTable, stockJoin);
    if (items.length) {
      await tx.insert(auditItemsTable).values(items.map((i) => ({ auditId: created.id, itemId: i.itemId, systemStock: i.stock ?? "0", actualStock: null, unitPrice: i.price ?? "0" })));
    }
    return created;
  });
  await logAudit({ action: "create", entityType: "inventory_audit", entityId: audit.id, clerkUserId: req.auth?.userId, details: audit.title });
  res.status(201).json(audit);
}));

// ─── Detail ──────────────────────────────────────────────────────────────────

router.get("/inventory-audits/:id", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const audit = await loadAudit(req, Number(req.params.id));
  const rows = await db.select({
    id: auditItemsTable.id, itemId: auditItemsTable.itemId, itemName: itemsTable.name, unit: itemsTable.unit,
    categoryName: categoriesTable.name, systemStock: auditItemsTable.systemStock, actualStock: auditItemsTable.actualStock,
    unitPrice: auditItemsTable.unitPrice, currentStock: warehouseStockTable.currentStock,
  }).from(auditItemsTable)
    .leftJoin(itemsTable, eq(auditItemsTable.itemId, itemsTable.id))
    .leftJoin(categoriesTable, eq(itemsTable.categoryId, categoriesTable.id))
    .leftJoin(warehouseStockTable, and(eq(warehouseStockTable.itemId, auditItemsTable.itemId), eq(warehouseStockTable.locationId, audit.locationId ?? -1)))
    .where(eq(auditItemsTable.auditId, audit.id))
    .orderBy(asc(categoriesTable.name), asc(itemsTable.name));

  const items = rows.map((r) => {
    const line = auditLineMath(Number(r.systemStock), r.actualStock == null ? null : Number(r.actualStock), Number(r.unitPrice));
    return {
      ...r, ...line,
      systemStock: Number(r.systemStock), actualStock: r.actualStock == null ? null : Number(r.actualStock),
      unitPrice: Number(r.unitPrice),
      // Stock moved since the snapshot (receipts, productions, transfers during the count).
      movedSinceSnapshot: audit.status === "draft" ? Number(r.currentStock ?? 0) - Number(r.systemStock) : 0,
    };
  });
  const [names] = await db.select({
    location: locationsTable.name,
    createdBy: sql<string | null>`(SELECT ${userName} FROM ${usersTable} WHERE ${usersTable.clerkUserId} = ${audit.createdByClerkId ?? ""})`,
    submittedBy: sql<string | null>`(SELECT ${userName} FROM ${usersTable} WHERE ${usersTable.clerkUserId} = ${audit.submittedByClerkId ?? ""})`,
  }).from(locationsTable).where(eq(locationsTable.id, audit.locationId ?? -1));
  res.json({
    ...audit, locationName: names?.location ?? null, createdByName: names?.createdBy ?? null, submittedByName: names?.submittedBy ?? null,
    shortageValue: audit.shortageValue == null ? null : Number(audit.shortageValue),
    surplusValue: audit.surplusValue == null ? null : Number(audit.surplusValue),
    totals: auditTotals(items), items,
  });
}));

// ─── Counting ────────────────────────────────────────────────────────────────

/** Save counts: [{ itemId, actualStock }] — actualStock in the item's unit; null clears a count. */
router.patch("/inventory-audits/:id", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const audit = await loadAudit(req, Number(req.params.id));
  if (audit.status !== "draft") throw new HttpError(409, "Инвентаризация уже проведена");
  const { items } = req.body as { items?: Array<{ itemId?: unknown; actualStock?: unknown }> };
  if (!Array.isArray(items) || items.length > 5000) throw new HttpError(400, "Передайте список позиций");
  let saved = 0;
  await db.transaction(async (tx) => {
    for (const it of items) {
      const itemId = Number(it?.itemId);
      const qty = parseQty(it?.actualStock);
      if (!Number.isInteger(itemId) || qty === undefined) continue;
      const r = await tx.update(auditItemsTable).set({ actualStock: qty == null ? null : String(qty) })
        .where(and(eq(auditItemsTable.auditId, audit.id), eq(auditItemsTable.itemId, itemId))).returning({ id: auditItemsTable.id });
      saved += r.length;
    }
  });
  res.json({ saved });
}));

/** Add an item that isn't on the sheet yet (e.g. found on a shelf of another department). */
router.post("/inventory-audits/:id/items", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const audit = await loadAudit(req, Number(req.params.id));
  if (audit.status !== "draft") throw new HttpError(409, "Инвентаризация уже проведена");
  const itemId = Number((req.body as { itemId?: unknown }).itemId);
  const item = Number.isInteger(itemId) ? await db.query.itemsTable.findFirst({ where: eq(itemsTable.id, itemId) }) : null;
  if (!item) throw new HttpError(400, "Позиция не найдена");
  const stock = await db.query.warehouseStockTable.findFirst({ where: and(eq(warehouseStockTable.itemId, itemId), eq(warehouseStockTable.locationId, audit.locationId ?? -1)) });
  await db.insert(auditItemsTable).values({ auditId: audit.id, itemId, systemStock: stock?.currentStock ?? "0", actualStock: null, unitPrice: item.pricePerUnit }).onConflictDoNothing();
  res.status(201).json({ ok: true });
}));

// ─── Submit / delete ─────────────────────────────────────────────────────────

router.post("/inventory-audits/:id/submit", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const audit = await loadAudit(req, Number(req.params.id));
  if (audit.status !== "draft") throw new HttpError(409, "Инвентаризация уже проведена");
  const locationId = audit.locationId;
  if (locationId == null) throw new HttpError(400, "У инвентаризации нет подразделения");

  const lines = await db.select().from(auditItemsTable).where(eq(auditItemsTable.auditId, audit.id));
  const counted = lines.filter((l) => l.actualStock != null);
  if (!counted.length) throw new HttpError(400, "Не введено ни одного фактического остатка");
  const totals = auditTotals(counted.map((l) => auditLineMath(Number(l.systemStock), Number(l.actualStock), Number(l.unitPrice))));

  const lowStock: Array<{ name: string; unit: string; stock: number; min: number }> = [];
  await db.transaction(async (tx) => { await moveContext(tx, "inventory", audit.id, req.auth?.userId); 
    const [claimed] = await tx.update(inventoryAuditsTable).set({
      status: "submitted", submittedAt: new Date(), submittedByClerkId: req.auth?.userId ?? null,
      shortageValue: String(totals.shortageValue), surplusValue: String(totals.surplusValue),
    }).where(and(eq(inventoryAuditsTable.id, audit.id), eq(inventoryAuditsTable.status, "draft"))).returning({ id: inventoryAuditsTable.id });
    if (!claimed) throw new HttpError(409, "Инвентаризация уже проведена");

    const ids = counted.map((l) => l.itemId);
    const locked = await tx.select({ itemId: warehouseStockTable.itemId, qty: warehouseStockTable.currentStock }).from(warehouseStockTable)
      .where(and(eq(warehouseStockTable.locationId, locationId), inArray(warehouseStockTable.itemId, ids))).for("update");
    const current = new Map(locked.map((r) => [r.itemId, Number(r.qty)]));

    for (const l of counted) {
      // Apply "actual − snapshot" to the CURRENT stock: anything received or
      // consumed while people were counting stays accounted for.
      const delta = Number(l.actualStock) - Number(l.systemStock);
      const next = Math.max(0, (current.get(l.itemId) ?? 0) + delta);
      await tx.insert(warehouseStockTable).values({ itemId: l.itemId, locationId, currentStock: String(next) })
        .onConflictDoUpdate({ target: [warehouseStockTable.itemId, warehouseStockTable.locationId], set: { currentStock: String(next) } });
      await syncLegacyTotal(tx, l.itemId);
      const [item] = await tx.select({ name: itemsTable.name, unit: itemsTable.unit, min: itemsTable.minThreshold }).from(itemsTable).where(eq(itemsTable.id, l.itemId));
      if (item?.min != null && next <= Number(item.min)) lowStock.push({ name: item.name, unit: item.unit, stock: next, min: Number(item.min) });
    }
  });
  for (const s of lowStock) void sendLowStockAlert(s.name, s.stock, s.min, s.unit);

  await logAudit({ action: "submit", entityType: "inventory_audit", entityId: audit.id, clerkUserId: req.auth?.userId,
    details: `Проведено позиций: ${counted.length}; недостача ${totals.shortageValue} сом, излишки ${totals.surplusValue} сом` });
  res.json({ ok: true, ...totals });
}));

router.delete("/inventory-audits/:id", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const audit = await loadAudit(req, Number(req.params.id));
  if (audit.status !== "draft") throw new HttpError(409, "Проведённую инвентаризацию удалить нельзя");
  await db.delete(inventoryAuditsTable).where(and(eq(inventoryAuditsTable.id, audit.id), eq(inventoryAuditsTable.status, "draft")));
  await logAudit({ action: "delete", entityType: "inventory_audit", entityId: audit.id, clerkUserId: req.auth?.userId, details: audit.title });
  res.json({ success: true });
}));

export default router;
