import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { requireRole } from "../middleware/rbac";
import {
  db, productionsTable, productionLinesTable, techCardsTable, itemsTable, warehouseStockTable,
  locationsTable, categoriesTable, usersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";
import { getWarehouseScope, canAccessLocation, isWarehouseAdmin } from "../lib/warehouseScope";
import { loadGraph } from "../lib/techCardGraph";
import { addStock, type Tx } from "../lib/stock";
import { convert, rawRequirements, stockUnitFor, weightedPrice, type ItemInfo } from "../lib/techCardMath";

const router: IRouter = Router();

const SEMI_CATEGORY = { name: "Полуфабрикаты", slug: "polufabrikaty" };
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Locks the stock rows of these items in a department and returns itemId → qty. */
async function lockStock(tx: Tx, locationId: number, itemIds: number[]) {
  if (!itemIds.length) return new Map<number, number>();
  const rows = await tx.select({ itemId: warehouseStockTable.itemId, qty: warehouseStockTable.currentStock })
    .from(warehouseStockTable)
    .where(and(eq(warehouseStockTable.locationId, locationId), inArray(warehouseStockTable.itemId, itemIds)))
    .for("update");
  return new Map(rows.map((r) => [r.itemId, Number(r.qty)]));
}

interface PlanInput { techCardId: number; departmentId: number; batches: number }

/** What a production would consume, with current department stock and shortages. */
async function plan({ techCardId, departmentId, batches }: PlanInput) {
  const { cards, items, cardRows } = await loadGraph();
  const row = cardRows.find((c) => c.id === techCardId);
  const card = cards.get(techCardId);
  if (!row || !card) throw new HttpError(404, "Тех-карта не найдена");
  if (row.kind !== "semi") throw new HttpError(400, "Акт производства оформляется на полуфабрикат. Блюда списываются при продаже.");
  if (!(card.outputQty > 0)) throw new HttpError(400, "У тех-карты не указан выход");

  const req = rawRequirements(techCardId, cards, items, batches);
  if (req.size === 0) throw new HttpError(400, "В тех-карте нет ингредиентов, которые можно списать");
  const stockRows = await db.select({ itemId: warehouseStockTable.itemId, qty: warehouseStockTable.currentStock })
    .from(warehouseStockTable).where(and(eq(warehouseStockTable.locationId, departmentId), inArray(warehouseStockTable.itemId, [...req.keys()])));
  const stock = new Map(stockRows.map((r) => [r.itemId, Number(r.qty)]));

  const lines = [...req].map(([itemId, qty]) => {
    const item = items.get(itemId)!;
    const have = stock.get(itemId) ?? 0;
    return {
      itemId, name: item.name, unit: item.unit, qty: round(qty, 4), unitPrice: item.pricePerUnit,
      cost: round(qty * item.pricePerUnit, 2), stock: have, shortage: have + 1e-9 < qty ? round(qty - have, 4) : 0,
    };
  });
  return {
    card: row, items,
    plannedOutput: round(card.outputQty * batches, 3),
    outputUnit: card.outputUnit,
    totalCost: round(lines.reduce((s, l) => s + l.cost, 0), 2),
    lines,
  };
}

function parseInput(src: Record<string, unknown>): PlanInput {
  const techCardId = Number(src.techCardId);
  const departmentId = Number(src.departmentId);
  const batches = Number(String(src.batches ?? "").replace(",", "."));
  if (!Number.isInteger(techCardId)) throw new HttpError(400, "Выберите полуфабрикат");
  if (!Number.isInteger(departmentId)) throw new HttpError(400, "Выберите подразделение");
  if (!(batches > 0) || batches > 10000) throw new HttpError(400, "Количество закладок должно быть больше нуля");
  return { techCardId, departmentId, batches };
}

async function checkDepartment(req: Request, departmentId: number) {
  const scope = await getWarehouseScope(req);
  if (!scope || !canAccessLocation(scope, departmentId)) throw new HttpError(403, "Нет доступа к этому подразделению");
  const loc = await db.query.locationsTable.findFirst({ where: eq(locationsTable.id, departmentId) });
  if (!loc?.isActive) throw new HttpError(400, "Подразделение не найдено");
  return scope;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message, ...e.extra }); return; }
      throw e;
    }
  };
}

/** Preview: what will be written off and what is missing. */
router.get("/productions/preview", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const input = parseInput(req.query as Record<string, unknown>);
  await checkDepartment(req, input.departmentId);
  const p = await plan(input);
  res.json({ plannedOutput: p.plannedOutput, outputUnit: p.outputUnit, totalCost: p.totalCost, lines: p.lines, canProduce: p.lines.every((l) => l.shortage === 0) });
}));

/** Ensures the semi-finished product has its own stock item; returns it. */
async function ensureOutputItem(tx: Tx, cardId: number, name: string, outputUnit: string): Promise<ItemInfo & { currentStock: number }> {
  const [card] = await tx.select({ outputItemId: techCardsTable.outputItemId }).from(techCardsTable).where(eq(techCardsTable.id, cardId)).for("update");
  if (card?.outputItemId) {
    const [it] = await tx.select().from(itemsTable).where(eq(itemsTable.id, card.outputItemId));
    if (it) return { id: it.id, name: it.name, unit: it.unit, pricePerUnit: Number(it.pricePerUnit), currentStock: Number(it.currentStock) };
  }
  await tx.insert(categoriesTable).values(SEMI_CATEGORY).onConflictDoNothing();
  const [cat] = await tx.select({ id: categoriesTable.id }).from(categoriesTable).where(eq(categoriesTable.slug, SEMI_CATEGORY.slug));
  const unit = stockUnitFor(outputUnit);
  const [created] = await tx.insert(itemsTable).values({ name: `${name} (п/ф)`, categoryId: cat.id, unit, pricePerUnit: "0", currentStock: "0", notes: "Полуфабрикат собственного производства — приходуется актом производства" }).returning();
  await tx.update(techCardsTable).set({ outputItemId: created.id }).where(eq(techCardsTable.id, cardId));
  return { id: created.id, name: created.name, unit, pricePerUnit: 0, currentStock: 0 };
}

router.post("/productions", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const input = parseInput(body);
  await checkDepartment(req, input.departmentId);
  const p = await plan(input);

  const actualRaw = body.actualOutput == null || body.actualOutput === "" ? p.plannedOutput : Number(String(body.actualOutput).replace(",", "."));
  if (!(actualRaw > 0)) throw new HttpError(400, "Фактический выход должен быть больше нуля");
  if (actualRaw > p.plannedOutput * 1.5) throw new HttpError(400, `Фактический выход намного больше планового (${p.plannedOutput} ${p.outputUnit}) — проверьте число`);
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null;

  const production = await db.transaction(async (tx) => {
    // Re-read stock under row locks: another act/sale may have run since the preview.
    const locked = await lockStock(tx, input.departmentId, p.lines.map((l) => l.itemId));
    const short = p.lines.filter((l) => (locked.get(l.itemId) ?? 0) + 1e-9 < l.qty)
      .map((l) => ({ itemId: l.itemId, name: l.name, unit: l.unit, need: l.qty, have: locked.get(l.itemId) ?? 0 }));
    if (short.length) throw new HttpError(409, `Не хватает: ${short.map((s) => `${s.name} (нужно ${s.need} ${s.unit}, есть ${s.have})`).join("; ")}`, { shortages: short });

    const outItem = await ensureOutputItem(tx, input.techCardId, p.card.name, p.outputUnit);
    const outQty = convert(actualRaw, p.outputUnit, outItem.unit);
    const unitCost = p.totalCost / outQty;

    const [created] = await tx.insert(productionsTable).values({
      techCardId: input.techCardId, departmentId: input.departmentId, batches: String(input.batches),
      plannedOutput: String(p.plannedOutput), actualOutput: String(actualRaw), outputUnit: p.outputUnit,
      outputItemId: outItem.id, outputItemQty: String(round(outQty, 4)), totalCost: String(p.totalCost),
      notes, recordedByClerkId: req.auth?.userId ?? null,
    }).returning();
    await tx.insert(productionLinesTable).values(p.lines.map((l) => ({
      productionId: created.id, itemId: l.itemId, qty: String(l.qty), unitPrice: String(l.unitPrice), cost: String(l.cost),
    })));
    for (const l of p.lines) await addStock(tx, l.itemId, input.departmentId, -l.qty);

    // New price of the semi: weighted average of what was in stock and this batch.
    const newPrice = weightedPrice(outItem.currentStock, outItem.pricePerUnit, outQty, unitCost);
    await tx.update(itemsTable).set({ pricePerUnit: String(round(newPrice, 2)) }).where(eq(itemsTable.id, outItem.id));
    await addStock(tx, outItem.id, input.departmentId, outQty);
    return created;
  });

  await logAudit({ action: "create", entityType: "production", entityId: production.id, clerkUserId: req.auth?.userId, details: `${p.card.name}: ${production.actualOutput} ${p.outputUnit}, ${p.totalCost} сом` });
  res.status(201).json({ id: production.id });
}));

/** Cancel: returns raw stock, removes the produced semi (if it is still in stock). */
router.post("/productions/:id/cancel", requireAuth(), requireRole("manager"), handle(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.query.productionsTable.findFirst({ where: eq(productionsTable.id, id) });
  if (!existing) throw new HttpError(404, "Акт не найден");
  if (existing.status === "cancelled") throw new HttpError(409, "Акт уже отменён");
  await checkDepartment(req, existing.departmentId);

  await db.transaction(async (tx) => {
    const outQty = Number(existing.outputItemQty);
    const locked = await lockStock(tx, existing.departmentId, [existing.outputItemId]);
    const have = locked.get(existing.outputItemId) ?? 0;
    if (have + 1e-9 < outQty) {
      throw new HttpError(409, `Полуфабрикат уже частично израсходован (на складе ${round(have, 3)} из ${round(outQty, 3)}). Отмена невозможна — оформите списание или инвентаризацию.`);
    }
    const [upd] = await tx.update(productionsTable).set({ status: "cancelled", cancelledAt: new Date(), cancelledByClerkId: req.auth?.userId ?? null })
      .where(and(eq(productionsTable.id, id), eq(productionsTable.status, "done"))).returning({ id: productionsTable.id });
    if (!upd) throw new HttpError(409, "Акт уже отменён");
    // Undo this batch's share of the weighted-average price.
    const [item] = await tx.select({ price: itemsTable.pricePerUnit, total: itemsTable.currentStock }).from(itemsTable).where(eq(itemsTable.id, existing.outputItemId)).for("update");
    if (item) {
      const totalQty = Number(item.total), price = Number(item.price), batchCost = Number(existing.totalCost);
      const restQty = totalQty - outQty;
      const restored = restQty > 1e-9 ? (price * totalQty - batchCost) / restQty : null;
      if (restored != null && restored >= 0) await tx.update(itemsTable).set({ pricePerUnit: String(round(restored, 2)) }).where(eq(itemsTable.id, existing.outputItemId));
    }
    await addStock(tx, existing.outputItemId, existing.departmentId, -outQty);
    const lines = await tx.select().from(productionLinesTable).where(eq(productionLinesTable.productionId, id));
    for (const l of lines) await addStock(tx, l.itemId, existing.departmentId, Number(l.qty));
  });

  await logAudit({ action: "update", entityType: "production", entityId: id, clerkUserId: req.auth?.userId, details: "Акт производства отменён" });
  res.json({ success: true });
}));

const recordedBy = sql<string | null>`NULLIF(TRIM(COALESCE(${usersTable.firstName}, '') || ' ' || COALESCE(${usersTable.lastName}, '')), '')`;

router.get("/productions", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const scope = await getWarehouseScope(req);
  if (!scope) throw new HttpError(403, "Пользователь не настроен");
  const requested = req.query.departmentId ? Number(req.query.departmentId) : null;
  // Non-admins only ever see their own department.
  const departmentId = isWarehouseAdmin(scope.role) ? requested : scope.locationId;
  const techCardId = req.query.techCardId ? Number(req.query.techCardId) : null;
  const conds = [];
  if (departmentId) conds.push(eq(productionsTable.departmentId, departmentId));
  if (techCardId) conds.push(eq(productionsTable.techCardId, techCardId));
  if (!isWarehouseAdmin(scope.role) && !departmentId) { res.json([]); return; }
  const rows = await db.select({
    id: productionsTable.id, techCardId: productionsTable.techCardId, techCardName: techCardsTable.name,
    departmentId: productionsTable.departmentId, departmentName: locationsTable.name,
    batches: productionsTable.batches, plannedOutput: productionsTable.plannedOutput, actualOutput: productionsTable.actualOutput,
    outputUnit: productionsTable.outputUnit, totalCost: productionsTable.totalCost, status: productionsTable.status,
    notes: productionsTable.notes, createdAt: productionsTable.createdAt, recordedByName: recordedBy,
  }).from(productionsTable)
    .leftJoin(techCardsTable, eq(productionsTable.techCardId, techCardsTable.id))
    .leftJoin(locationsTable, eq(productionsTable.departmentId, locationsTable.id))
    .leftJoin(usersTable, eq(productionsTable.recordedByClerkId, usersTable.clerkUserId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(productionsTable.createdAt)).limit(500);
  res.json(rows.map((r) => ({ ...r, batches: Number(r.batches), plannedOutput: Number(r.plannedOutput), actualOutput: Number(r.actualOutput), totalCost: Number(r.totalCost) })));
}));

router.get("/productions/:id", requireAuth(), requireRole("warehouse"), handle(async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db.select({
    id: productionsTable.id, techCardId: productionsTable.techCardId, techCardName: techCardsTable.name,
    departmentId: productionsTable.departmentId, departmentName: locationsTable.name,
    batches: productionsTable.batches, plannedOutput: productionsTable.plannedOutput, actualOutput: productionsTable.actualOutput,
    outputUnit: productionsTable.outputUnit, outputItemId: productionsTable.outputItemId, outputItemQty: productionsTable.outputItemQty,
    totalCost: productionsTable.totalCost, status: productionsTable.status, notes: productionsTable.notes,
    createdAt: productionsTable.createdAt, cancelledAt: productionsTable.cancelledAt, recordedByName: recordedBy,
  }).from(productionsTable)
    .leftJoin(techCardsTable, eq(productionsTable.techCardId, techCardsTable.id))
    .leftJoin(locationsTable, eq(productionsTable.departmentId, locationsTable.id))
    .leftJoin(usersTable, eq(productionsTable.recordedByClerkId, usersTable.clerkUserId))
    .where(eq(productionsTable.id, id));
  if (!row) throw new HttpError(404, "Акт не найден");
  const scope = await getWarehouseScope(req);
  if (!canAccessLocation(scope, row.departmentId)) throw new HttpError(403, "Нет доступа");
  const lines = await db.select({ itemId: productionLinesTable.itemId, name: itemsTable.name, unit: itemsTable.unit, qty: productionLinesTable.qty, unitPrice: productionLinesTable.unitPrice, cost: productionLinesTable.cost })
    .from(productionLinesTable).leftJoin(itemsTable, eq(productionLinesTable.itemId, itemsTable.id))
    .where(eq(productionLinesTable.productionId, id));
  const outputItem = await db.query.itemsTable.findFirst({ where: eq(itemsTable.id, row.outputItemId) });
  res.json({
    ...row, batches: Number(row.batches), plannedOutput: Number(row.plannedOutput), actualOutput: Number(row.actualOutput),
    outputItemQty: Number(row.outputItemQty), totalCost: Number(row.totalCost),
    outputItem: outputItem ? { id: outputItem.id, name: outputItem.name, unit: outputItem.unit } : null,
    lines: lines.map((l) => ({ ...l, qty: Number(l.qty), unitPrice: Number(l.unitPrice), cost: Number(l.cost) })),
  });
}));

export default router;
