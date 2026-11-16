import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, productsTable, housesTable, techCardsTable, itemsTable, locationsTable, saleItemsTable } from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";
import { requireVenueRole } from "../middleware/rbac";
import { getWarehouseScope } from "../lib/warehouseScope";
import { canAccessVenueLocation } from "../lib/venueScope";

const router: IRouter = Router();

type LinkFields = { techCardId?: number | null; itemId?: number | null; itemQty?: string; writeOffLocationId?: number | null; barcode?: string | null };

/** Validates the stock-link fields of a menu position; returns the clean values or an error. */
async function parseLinks(body: Record<string, unknown>): Promise<{ values: LinkFields } | { error: string }> {
  const values: LinkFields = {};
  const id = (v: unknown) => (v === null || v === "" ? null : Number(v));
  if (body.techCardId !== undefined) {
    values.techCardId = id(body.techCardId);
    if (values.techCardId != null) {
      const card = await db.query.techCardsTable.findFirst({ where: eq(techCardsTable.id, values.techCardId) });
      if (!card) return { error: "Тех-карта не найдена" };
      if (card.kind !== "dish") return { error: "В меню можно добавить только блюдо или напиток, не полуфабрикат" };
    }
  }
  if (body.itemId !== undefined) {
    values.itemId = id(body.itemId);
    if (values.itemId != null && !(await db.query.itemsTable.findFirst({ where: eq(itemsTable.id, values.itemId) }))) return { error: "Позиция склада не найдена" };
  }
  if (values.techCardId != null && values.itemId != null) return { error: "Укажите либо тех-карту, либо позицию склада" };
  if (body.itemQty !== undefined) {
    const q = Number(String(body.itemQty).replace(",", "."));
    if (!(q > 0)) return { error: "Количество списания должно быть больше нуля" };
    values.itemQty = String(q);
  }
  if (body.writeOffLocationId !== undefined) {
    values.writeOffLocationId = id(body.writeOffLocationId);
    if (values.writeOffLocationId != null && !(await db.query.locationsTable.findFirst({ where: eq(locationsTable.id, values.writeOffLocationId) }))) return { error: "Склад списания не найден" };
  }
  if (body.barcode !== undefined) {
    const b = typeof body.barcode === "string" ? body.barcode.trim() : "";
    if (b && !/^[0-9A-Za-z-]{3,64}$/.test(b)) return { error: "Штрих-код: цифры и латиница, 3–64 символа" };
    values.barcode = b || null;
  }
  return { values };
}

router.get("/products", requireAuth(), requireVenueRole("cashier"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const houseId = req.query.houseId ? Number(req.query.houseId) : undefined;
  if (!houseId) { res.status(400).json({ error: "houseId required" }); return; }

  const house = await db.query.housesTable.findFirst({ where: eq(housesTable.id, houseId) });
  if (!house) { res.status(404).json({ error: "Точка продаж не найдена" }); return; }
  if (!canAccessVenueLocation(scope, house.locationId)) { res.status(403).json({ error: "Нет доступа к этой точке продаж" }); return; }

  const rows = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.houseId, houseId), eq(productsTable.isActive, true)))
    .orderBy(asc(productsTable.category), asc(productsTable.sortOrder), asc(productsTable.name));
  res.json(rows);
});

router.post("/products", requireAuth(), requireVenueRole("location_admin"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const { houseId, category, name, price, sortOrder } = req.body;
  const hId = Number(houseId);
  if (!hId || !category || !name || price === undefined) { res.status(400).json({ error: "houseId, category, name, price обязательны" }); return; }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) { res.status(400).json({ error: "Некорректная цена" }); return; }

  const house = await db.query.housesTable.findFirst({ where: eq(housesTable.id, hId) });
  if (!house) { res.status(400).json({ error: "Точка продаж не найдена" }); return; }
  if (!canAccessVenueLocation(scope, house.locationId)) { res.status(403).json({ error: "Нет доступа к этой точке продаж" }); return; }

  const links = await parseLinks(req.body);
  if ("error" in links) { res.status(400).json({ error: links.error }); return; }
  const [row] = await db.insert(productsTable).values({ houseId: hId, category, name, price: String(priceNum), sortOrder: sortOrder ?? 0, ...links.values }).returning();
  await logAudit({ action: "create", entityType: "product", entityId: row.id, clerkUserId: req.auth?.userId });
  res.status(201).json(row);
});

router.patch("/products/:id", requireAuth(), requireVenueRole("location_admin"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const id = Number(req.params.id);
  const product = await db.query.productsTable.findFirst({ where: eq(productsTable.id, id) });
  if (!product) { res.status(404).json({ error: "Not found" }); return; }
  const house = await db.query.housesTable.findFirst({ where: eq(housesTable.id, product.houseId) });
  if (!canAccessVenueLocation(scope, house?.locationId ?? null)) { res.status(403).json({ error: "Нет доступа" }); return; }

  const { category, name, price, isActive, sortOrder } = req.body;
  const updates: Record<string, unknown> = {};
  if (category !== undefined) updates.category = category;
  if (name !== undefined) updates.name = name;
  if (price !== undefined) updates.price = String(Number(price));
  if (isActive !== undefined) updates.isActive = isActive;
  if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder);
  const links = await parseLinks(req.body);
  if ("error" in links) { res.status(400).json({ error: links.error }); return; }
  Object.assign(updates, links.values);
  // Linking one source clears the other.
  if (links.values.techCardId != null && req.body.itemId === undefined) updates.itemId = null;
  if (links.values.itemId != null && req.body.techCardId === undefined) updates.techCardId = null;

  const [row] = await db.update(productsTable).set(updates).where(eq(productsTable.id, id)).returning();
  await logAudit({ action: "update", entityType: "product", entityId: id, clerkUserId: req.auth?.userId });
  res.json(row);
});

router.delete("/products/:id", requireAuth(), requireVenueRole("location_admin"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const id = Number(req.params.id);
  const product = await db.query.productsTable.findFirst({ where: eq(productsTable.id, id) });
  if (!product) { res.status(404).json({ error: "Not found" }); return; }
  const house = await db.query.housesTable.findFirst({ where: eq(housesTable.id, product.houseId) });
  if (!canAccessVenueLocation(scope, house?.locationId ?? null)) { res.status(403).json({ error: "Нет доступа" }); return; }

  // Sold positions stay for receipts and reports — hide them from the menu instead.
  const sold = await db.select({ id: saleItemsTable.id }).from(saleItemsTable).where(eq(saleItemsTable.productId, id)).limit(1);
  if (sold.length) await db.update(productsTable).set({ isActive: false }).where(eq(productsTable.id, id));
  else await db.delete(productsTable).where(eq(productsTable.id, id));
  await logAudit({ action: "delete", entityType: "product", entityId: id, clerkUserId: req.auth?.userId, details: sold.length ? "скрыта из меню (есть продажи)" : undefined });
  res.status(204).end();
});

/** Adds dish tech cards to a point of sale's menu (name, price and category from the card). */
router.post("/products/from-tech-cards", requireAuth(), requireVenueRole("location_admin"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const { houseId, techCardIds } = req.body as { houseId?: number; techCardIds?: number[] };
  const house = houseId ? await db.query.housesTable.findFirst({ where: eq(housesTable.id, Number(houseId)) }) : null;
  if (!house) { res.status(400).json({ error: "Точка продаж не найдена" }); return; }
  if (!canAccessVenueLocation(scope, house.locationId)) { res.status(403).json({ error: "Нет доступа" }); return; }
  if (!Array.isArray(techCardIds) || !techCardIds.length || techCardIds.length > 500) { res.status(400).json({ error: "Выберите тех-карты" }); return; }
  const cards = await db.select().from(techCardsTable).where(and(inArray(techCardsTable.id, techCardIds.map(Number)), eq(techCardsTable.kind, "dish")));
  const existing = await db.select({ name: productsTable.name, techCardId: productsTable.techCardId }).from(productsTable).where(eq(productsTable.houseId, house.id));
  const taken = new Set(existing.map((e) => e.name.toLowerCase()));
  const linked = new Set(existing.map((e) => e.techCardId).filter((v) => v != null));
  const toAdd = cards.filter((c) => !linked.has(c.id) && !taken.has(c.name.toLowerCase()));
  if (toAdd.length) {
    await db.insert(productsTable).values(toAdd.map((c, i) => ({
      houseId: house.id, category: c.category?.trim() || "Меню", name: c.name, price: c.salePrice ?? "0", techCardId: c.id, sortOrder: i,
    })));
  }
  await logAudit({ action: "create", entityType: "product", clerkUserId: req.auth?.userId, details: `Из тех-карт: ${toAdd.length} позиций` });
  res.status(201).json({ added: toAdd.length, skipped: cards.length - toAdd.length, noPrice: toAdd.filter((c) => !c.salePrice).map((c) => c.name) });
});

export default router;
