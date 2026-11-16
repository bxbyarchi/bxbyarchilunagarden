import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { requireRole } from "../middleware/rbac";
import { db, techCardsTable, techCardIngredientsTable, itemsTable, locationsTable, productsTable } from "@workspace/db";
import { loadGraph, departmentStock } from "../lib/techCardGraph";
import { and, eq, inArray } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";
import {
  UNITS, normalizeUnit, unitsCompatible, costCard, pricing, rawRequirements, portionsAvailable,
  type CardInfo, type ItemInfo, type IngredientInput,
} from "../lib/techCardMath";

const router: IRouter = Router();

router.get("/tech-cards/units", requireAuth(), (_req, res) => {
  res.json(UNITS);
});

router.get("/tech-cards", requireAuth(), requireRole("warehouse"), async (req: Request, res: Response) => {
  const { departmentId, kind, q } = req.query;
  const { cardRows, cards, items } = await loadGraph();
  const locations = await db.select({ id: locationsTable.id, name: locationsTable.name }).from(locationsTable);
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const stockCache = new Map<number, Map<number, number> | null>();

  const search = typeof q === "string" ? q.trim().toLowerCase() : "";
  const filtered = cardRows.filter((c) =>
    (!departmentId || c.departmentId === Number(departmentId)) &&
    (!kind || c.kind === kind) &&
    (!search || c.name.toLowerCase().includes(search) || (c.category ?? "").toLowerCase().includes(search)));

  const out = [];
  for (const c of filtered) {
    const { cost, errors } = costCard(c.id, cards, items);
    let portions: number | null = null;
    if (c.departmentId != null) {
      if (!stockCache.has(c.departmentId)) stockCache.set(c.departmentId, await departmentStock(c.departmentId));
      const stock = stockCache.get(c.departmentId)!;
      portions = stock ? portionsAvailable(rawRequirements(c.id, cards, items), stock).portions : null;
    }
    out.push({
      id: c.id, name: c.name, kind: c.kind, category: c.category, isActive: c.isActive,
      departmentId: c.departmentId, departmentName: c.departmentId ? locName.get(c.departmentId) ?? null : null,
      outputQty: Number(c.outputQty), outputUnit: c.outputUnit,
      salePrice: c.salePrice == null ? null : Number(c.salePrice),
      cost, ...pricing(cost, c.salePrice == null ? null : Number(c.salePrice)),
      ingredientCount: cards.get(c.id)?.ingredients.length ?? 0,
      portionsAvailable: portions,
      hasErrors: errors.length > 0,
    });
  }
  res.json(out);
});

router.get("/tech-cards/:id", requireAuth(), requireRole("warehouse"), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { cardRows, cards, items } = await loadGraph();
  const row = cardRows.find((c) => c.id === id);
  if (!row) { res.status(404).json({ error: "Тех-карта не найдена" }); return; }

  const { cost, lines, errors } = costCard(id, cards, items);
  const stock = await departmentStock(row.departmentId);
  const requirements = rawRequirements(id, cards, items);
  const availability = stock ? portionsAvailable(requirements, stock) : { portions: null, limitingItemIds: [] as number[] };
  const department = row.departmentId ? await db.query.locationsTable.findFirst({ where: eq(locationsTable.id, row.departmentId) }) : null;
  const usedIn = cardRows.filter((c) => cards.get(c.id)?.ingredients.some((i) => i.semiCardId === id)).map((c) => ({ id: c.id, name: c.name }));

  res.json({
    ...row,
    outputQty: Number(row.outputQty),
    salePrice: row.salePrice == null ? null : Number(row.salePrice),
    departmentName: department?.name ?? null,
    cost, ...pricing(cost, row.salePrice == null ? null : Number(row.salePrice)),
    lines: lines.map((l) => ({
      ...l,
      sourceUnit: l.itemId != null ? items.get(l.itemId)?.unit ?? null : cards.get(l.semiCardId!)?.outputUnit ?? null,
      stock: l.itemId != null && stock ? stock.get(l.itemId) ?? 0 : null,
    })),
    errors,
    portionsAvailable: availability.portions,
    limitingItems: availability.limitingItemIds.map((iid) => ({ id: iid, name: items.get(iid)?.name ?? `#${iid}` })),
    requirements: [...requirements].map(([itemId, qty]) => ({ itemId, name: items.get(itemId)?.name ?? `#${itemId}`, unit: items.get(itemId)?.unit ?? "", qty, stock: stock ? stock.get(itemId) ?? 0 : null })),
    usedIn,
  });
});

// ─── Write ──────────────────────────────────────────────────────────────────

interface CardBody {
  name?: unknown; kind?: unknown; departmentId?: unknown; category?: unknown;
  outputQty?: unknown; outputUnit?: unknown; salePrice?: unknown; technology?: unknown; isActive?: unknown;
  ingredients?: unknown;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Validates the body against the current graph. Returns an error message or the clean values. */
async function validate(body: CardBody, selfId: number | null) {
  const name = str(body.name);
  if (!name) return { error: "Укажите название" } as const;
  const kind = body.kind === "semi" ? "semi" : "dish";
  const outputQty = num(body.outputQty);
  if (!(outputQty > 0)) return { error: "Укажите выход (больше нуля)" } as const;
  const outputUnit = normalizeUnit(typeof body.outputUnit === "string" ? body.outputUnit : null);
  if (!outputUnit) return { error: "Единица выхода: г, кг, мл, л или шт" } as const;
  const salePriceRaw = body.salePrice == null || body.salePrice === "" ? null : num(body.salePrice);
  if (salePriceRaw != null && !(salePriceRaw >= 0)) return { error: "Неверная цена продажи" } as const;
  const departmentId = body.departmentId == null || body.departmentId === "" ? null : num(body.departmentId);
  if (departmentId != null && !Number.isInteger(departmentId)) return { error: "Неверное подразделение" } as const;
  if (!Array.isArray(body.ingredients) || body.ingredients.length === 0) return { error: "Добавьте хотя бы один ингредиент" } as const;
  if (body.ingredients.length > 200) return { error: "Слишком много ингредиентов" } as const;

  const { cards, items } = await loadGraph();
  const itemIds = body.ingredients.map((i: { itemId?: unknown }) => num(i?.itemId)).filter((v) => Number.isInteger(v));
  if (itemIds.length) {
    const missing = itemIds.filter((iid) => !items.has(iid));
    if (missing.length) {
      const rows = await db.select({ id: itemsTable.id, name: itemsTable.name, unit: itemsTable.unit, pricePerUnit: itemsTable.pricePerUnit }).from(itemsTable).where(inArray(itemsTable.id, missing));
      for (const r of rows) items.set(r.id, { id: r.id, name: r.name, unit: r.unit, pricePerUnit: Number(r.pricePerUnit) });
    }
  }

  const ingredients: IngredientInput[] = [];
  for (const [idx, raw] of (body.ingredients as Array<Record<string, unknown>>).entries()) {
    const n = idx + 1;
    const itemId = raw?.itemId == null || raw.itemId === "" ? null : num(raw.itemId);
    const semiCardId = raw?.semiCardId == null || raw.semiCardId === "" ? null : num(raw.semiCardId);
    if ((itemId == null) === (semiCardId == null)) return { error: `Строка ${n}: выберите позицию склада или полуфабрикат` } as const;
    const grossQty = num(raw.grossQty);
    if (!(grossQty > 0)) return { error: `Строка ${n}: количество брутто должно быть больше нуля` } as const;
    const unit = normalizeUnit(typeof raw.unit === "string" ? raw.unit : null);
    if (!unit) return { error: `Строка ${n}: единица г, кг, мл, л или шт` } as const;
    const coldLossPct = raw.coldLossPct == null || raw.coldLossPct === "" ? 0 : num(raw.coldLossPct);
    const hotLossPct = raw.hotLossPct == null || raw.hotLossPct === "" ? 0 : num(raw.hotLossPct);
    if (!(coldLossPct >= 0 && coldLossPct < 100 && hotLossPct >= 0 && hotLossPct < 100)) return { error: `Строка ${n}: потери от 0 до 99%` } as const;

    if (itemId != null) {
      const item = items.get(itemId);
      if (!item) return { error: `Строка ${n}: позиция склада не найдена` } as const;
      if (!unitsCompatible(unit, item.unit)) return { error: `Строка ${n}: «${item.name}» учитывается в «${item.unit}», нельзя указать в «${unit}»` } as const;
    } else {
      const semi = cards.get(semiCardId!);
      if (!semi || semi.kind !== "semi") return { error: `Строка ${n}: полуфабрикат не найден` } as const;
      if (semi.id === selfId) return { error: `Строка ${n}: тех-карта не может содержать саму себя` } as const;
      if (!unitsCompatible(unit, semi.outputUnit)) return { error: `Строка ${n}: выход «${semi.name}» в «${semi.outputUnit}», нельзя указать в «${unit}»` } as const;
    }
    ingredients.push({ itemId, semiCardId, grossQty, unit, coldLossPct, hotLossPct });
  }

  // Cycle check: put the candidate into the graph and cost it.
  const probeId = selfId ?? -1;
  cards.set(probeId, { id: probeId, name, kind, outputQty, outputUnit, salePrice: salePriceRaw, ingredients });
  const probe = costCard(probeId, cards, items);
  const cycle = probe.errors.find((e) => /Циклическая|вложенность/.test(e));
  if (cycle) return { error: cycle } as const;

  return {
    values: {
      name, kind, outputQty: String(outputQty), outputUnit, salePrice: salePriceRaw == null ? null : String(salePriceRaw),
      departmentId, category: str(body.category, 100), technology: str(body.technology, 5000),
      isActive: body.isActive === undefined ? true : body.isActive !== false,
    },
    ingredients,
  } as const;
}

function ingredientRows(cardId: number, ingredients: IngredientInput[]) {
  return ingredients.map((i, idx) => ({
    techCardId: cardId, itemId: i.itemId, semiCardId: i.semiCardId, grossQty: String(i.grossQty), unit: i.unit,
    coldLossPct: String(i.coldLossPct), hotLossPct: String(i.hotLossPct), sortOrder: idx,
  }));
}

router.post("/tech-cards", requireAuth(), requireRole("manager"), async (req: Request, res: Response) => {
  const v = await validate(req.body as CardBody, null);
  if ("error" in v) { res.status(400).json({ error: v.error }); return; }
  const card = await db.transaction(async (tx) => {
    const [created] = await tx.insert(techCardsTable).values(v.values).returning();
    await tx.insert(techCardIngredientsTable).values(ingredientRows(created.id, v.ingredients));
    return created;
  });
  await logAudit({ action: "create", entityType: "tech-card", entityId: card.id, clerkUserId: req.auth?.userId, details: card.name });
  res.status(201).json({ id: card.id });
});

router.put("/tech-cards/:id", requireAuth(), requireRole("manager"), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await db.query.techCardsTable.findFirst({ where: eq(techCardsTable.id, id) });
  if (!existing) { res.status(404).json({ error: "Тех-карта не найдена" }); return; }
  const v = await validate(req.body as CardBody, id);
  if ("error" in v) { res.status(400).json({ error: v.error }); return; }
  if (existing.kind === "semi" && v.values.kind !== "semi") {
    const used = await db.select({ id: techCardIngredientsTable.id }).from(techCardIngredientsTable).where(eq(techCardIngredientsTable.semiCardId, id)).limit(1);
    if (used.length) { res.status(409).json({ error: "Полуфабрикат используется в других тех-картах — его нельзя сделать блюдом" }); return; }
  }
  await db.transaction(async (tx) => {
    await tx.update(techCardsTable).set(v.values).where(eq(techCardsTable.id, id));
    await tx.delete(techCardIngredientsTable).where(eq(techCardIngredientsTable.techCardId, id));
    await tx.insert(techCardIngredientsTable).values(ingredientRows(id, v.ingredients));
  });
  await logAudit({ action: "update", entityType: "tech-card", entityId: id, clerkUserId: req.auth?.userId, details: v.values.name });
  res.json({ id });
});

router.delete("/tech-cards/:id", requireAuth(), requireRole("manager"), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const users = await db.select({ name: techCardsTable.name }).from(techCardIngredientsTable)
    .innerJoin(techCardsTable, eq(techCardIngredientsTable.techCardId, techCardsTable.id))
    .where(eq(techCardIngredientsTable.semiCardId, id));
  if (users.length) { res.status(409).json({ error: `Полуфабрикат используется в: ${[...new Set(users.map((u) => u.name))].join(", ")}` }); return; }
  const onMenu = await db.select({ name: productsTable.name }).from(productsTable).where(and(eq(productsTable.techCardId, id), eq(productsTable.isActive, true))).limit(5);
  if (onMenu.length) { res.status(409).json({ error: `Тех-карта стоит в меню кассы (${onMenu.map((m) => m.name).join(", ")}) — сначала уберите её из меню` }); return; }
  const [deleted] = await db.delete(techCardsTable).where(eq(techCardsTable.id, id)).returning({ name: techCardsTable.name });
  if (!deleted) { res.status(404).json({ error: "Тех-карта не найдена" }); return; }
  await logAudit({ action: "delete", entityType: "tech-card", entityId: id, clerkUserId: req.auth?.userId, details: deleted.name });
  res.json({ success: true });
});

export default router;
