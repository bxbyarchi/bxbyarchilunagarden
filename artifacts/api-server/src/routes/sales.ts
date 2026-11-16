import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, salesTable, saleItemsTable, shiftsTable, registersTable, housesTable, locationsTable, returnsTable, productsTable, saleStockMovementsTable } from "@workspace/db";
import { eq, and, sql, inArray, gt } from "drizzle-orm";
import { loadGraph, loadMoreItems } from "../lib/techCardGraph";
import { saleWriteOffs, restockShare, refundAmount, type WriteOff } from "../lib/saleWriteOff";
import { addStock } from "../lib/stock";
import { logAudit } from "../lib/auditLogger";
import { requireVenueRole } from "../middleware/rbac";
import { getWarehouseScope } from "../lib/warehouseScope";
import { isVenueAdmin, canAccessVenueLocation, getRegisterLocationId } from "../lib/venueScope";

const router: IRouter = Router();

type SaleItemInput = { productId?: number; name?: string; quantity: number; pricePerUnit?: number };

router.get("/sales", requireAuth(), requireVenueRole("cashier"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const requestedLocation = isVenueAdmin(scope.role) && req.query.locationId ? Number(req.query.locationId) : scope.locationId;

  const conditions = [];
  if (requestedLocation) conditions.push(eq(housesTable.locationId, requestedLocation));
  if (req.query.shiftId) conditions.push(eq(salesTable.shiftId, Number(req.query.shiftId)));
  if (req.query.registerId) conditions.push(eq(salesTable.registerId, Number(req.query.registerId)));

  const rows = await db
    .select({
      id: salesTable.id,
      shiftId: salesTable.shiftId,
      registerId: salesTable.registerId,
      registerName: registersTable.name,
      houseName: housesTable.name,
      locationName: locationsTable.name,
      subtotalAmount: salesTable.subtotalAmount,
      discountPercent: salesTable.discountPercent,
      discountAmount: salesTable.discountAmount,
      discountReason: salesTable.discountReason,
      totalAmount: salesTable.totalAmount,
      paymentMethod: salesTable.paymentMethod,
      status: salesTable.status,
      createdAt: salesTable.createdAt,
    })
    .from(salesTable)
    .innerJoin(registersTable, eq(salesTable.registerId, registersTable.id))
    .innerJoin(housesTable, eq(registersTable.houseId, housesTable.id))
    .leftJoin(locationsTable, eq(housesTable.locationId, locationsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${salesTable.createdAt} DESC`)
    .limit(200);
  res.json(rows);
});

router.get("/sales/:id", requireAuth(), requireVenueRole("cashier"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const id = Number(req.params.id);
  const sale = await db.query.salesTable.findFirst({ where: eq(salesTable.id, id) });
  if (!sale) { res.status(404).json({ error: "Not found" }); return; }
  const locationId = await getRegisterLocationId(sale.registerId);
  if (!canAccessVenueLocation(scope, locationId)) { res.status(403).json({ error: "Нет доступа" }); return; }
  const items = await db.select().from(saleItemsTable).where(eq(saleItemsTable.saleId, id));
  res.json({ ...sale, items });
});

/** Roles allowed to ring up free-price lines that aren't on the menu. */
const canSellFreePrice = (role: string) => role === "super_admin" || role === "location_admin";

router.post("/sales", requireAuth(), requireVenueRole("cashier"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const { shiftId, items, paymentMethod, discountPercent, discountReason } = req.body as {
    shiftId: number; items: SaleItemInput[]; paymentMethod?: "cash" | "card"; discountPercent?: number; discountReason?: string;
  };
  if (!shiftId || !Array.isArray(items) || items.length === 0 || items.length > 200) { res.status(400).json({ error: "shiftId и items обязательны" }); return; }
  for (const it of items) {
    if (!(Number(it.quantity) > 0) || Number(it.quantity) > 10000) { res.status(400).json({ error: "Некорректное количество" }); return; }
  }
  const discPct = Math.min(Math.max(Number(discountPercent) || 0, 0), 100);
  if (discPct > 0 && !discountReason?.trim()) { res.status(400).json({ error: "Укажите причину скидки" }); return; }

  const shift = await db.query.shiftsTable.findFirst({ where: eq(shiftsTable.id, Number(shiftId)) });
  if (!shift) { res.status(404).json({ error: "Смена не найдена" }); return; }
  if (shift.status !== "open") { res.status(409).json({ error: "Смена закрыта" }); return; }
  const [reg] = await db.select({ houseId: registersTable.houseId, locationId: housesTable.locationId }).from(registersTable)
    .innerJoin(housesTable, eq(registersTable.houseId, housesTable.id)).where(eq(registersTable.id, shift.registerId));
  if (!reg || !canAccessVenueLocation(scope, reg.locationId)) { res.status(403).json({ error: "Нет доступа к этой смене" }); return; }

  // Prices come from the menu, never from the client.
  const productIds = [...new Set(items.map((it) => Number(it.productId)).filter((id) => Number.isInteger(id) && id > 0))];
  const products = productIds.length ? await db.select().from(productsTable).where(inArray(productsTable.id, productIds)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: Array<{ productId: number | null; name: string; quantity: number; price: number }> = [];
  for (const it of items) {
    const qty = Number(it.quantity);
    if (it.productId != null) {
      const p = byId.get(Number(it.productId));
      if (!p || p.houseId !== reg.houseId || !p.isActive) { res.status(400).json({ error: `Позиции «${it.name ?? it.productId}» нет в меню этой точки` }); return; }
      lines.push({ productId: p.id, name: p.name, quantity: qty, price: Number(p.price) });
    } else {
      if (!canSellFreePrice(scope.role)) { res.status(403).json({ error: "Позицию по свободной цене может пробить только администратор" }); return; }
      const price = Number(it.pricePerUnit);
      if (!it.name?.trim() || !(price >= 0)) { res.status(400).json({ error: "Укажите название и цену позиции" }); return; }
      lines.push({ productId: null, name: it.name.trim().slice(0, 200), quantity: qty, price });
    }
  }

  // Stock to write off, per line.
  const { cards, items: stockItems } = await loadGraph();
  await loadMoreItems(stockItems, products.map((p) => p.itemId).filter((v): v is number => v != null));
  const writeOffs: WriteOff[][] = lines.map((l) => {
    const p = l.productId != null ? byId.get(l.productId) : undefined;
    return p ? saleWriteOffs({ id: p.id, techCardId: p.techCardId, itemId: p.itemId, itemQty: Number(p.itemQty), writeOffLocationId: p.writeOffLocationId }, l.quantity, reg.locationId, cards, stockItems) : [];
  });

  const method = paymentMethod === "card" ? "card" : "cash";
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const subtotalAmount = round2(lines.reduce((sum, l) => sum + l.quantity * l.price, 0));
  const discountAmount = round2(subtotalAmount * (discPct / 100));
  const totalAmount = round2(subtotalAmount - discountAmount);

  const sale = await db.transaction(async (tx) => {
    const [createdSale] = await tx.insert(salesTable).values({
      shiftId: shift.id,
      registerId: shift.registerId,
      subtotalAmount: String(subtotalAmount),
      discountPercent: String(discPct),
      discountAmount: String(discountAmount),
      discountReason: discPct > 0 ? discountReason?.trim() : null,
      totalAmount: String(totalAmount),
      paymentMethod: method,
      createdByClerkId: req.auth?.userId,
    }).returning();

    const saleItems = await tx.insert(saleItemsTable).values(lines.map((l) => ({
      saleId: createdSale.id,
      productId: l.productId,
      name: l.name,
      quantity: String(l.quantity),
      pricePerUnit: String(l.price),
      totalPrice: String(round2(l.quantity * l.price)),
    }))).returning({ id: saleItemsTable.id });

    for (const [i, row] of saleItems.entries()) {
      for (const w of writeOffs[i]) {
        await tx.insert(saleStockMovementsTable).values({ saleItemId: row.id, itemId: w.itemId, locationId: w.locationId, qty: String(w.qty), unitCost: String(w.unitCost) });
        await addStock(tx, w.itemId, w.locationId, -w.qty);
      }
    }

    await tx.update(shiftsTable).set({
      totalSalesCash: sql`${shiftsTable.totalSalesCash} + ${method === "cash" ? totalAmount : 0}`,
      totalSalesCard: sql`${shiftsTable.totalSalesCard} + ${method === "card" ? totalAmount : 0}`,
    }).where(eq(shiftsTable.id, shift.id));

    return createdSale;
  });

  await logAudit({ action: "create", entityType: "sale", entityId: sale.id, clerkUserId: req.auth?.userId, details: `${totalAmount} сом, ${method}${discPct > 0 ? `, скидка ${discPct}%` : ""}` });
  const saleItems = await db.select().from(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
  res.status(201).json({ ...sale, items: saleItems });
});

router.post("/sales/:id/returns", requireAuth(), requireVenueRole("cashier"), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope) { res.status(403).json({ error: "Пользователь не настроен" }); return; }
  const saleId = Number(req.params.id);
  const { items, reason, restock, shiftId: bodyShiftId } = req.body as {
    items: Array<{ saleItemId: number; quantity: number }>; reason?: string; restock?: boolean; shiftId?: number;
  };
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "items обязателен" }); return; }

  const sale = await db.query.salesTable.findFirst({ where: eq(salesTable.id, saleId) });
  if (!sale) { res.status(404).json({ error: "Продажа не найдена" }); return; }
  const locationId = await getRegisterLocationId(sale.registerId);
  if (!canAccessVenueLocation(scope, locationId)) { res.status(403).json({ error: "Нет доступа" }); return; }

  // Money goes back out of an OPEN shift: the sale's own, or the current one at the same venue.
  const saleShift = await db.query.shiftsTable.findFirst({ where: eq(shiftsTable.id, sale.shiftId) });
  let returnShiftId: number;
  if (saleShift?.status === "open") returnShiftId = saleShift.id;
  else {
    const current = bodyShiftId ? await db.query.shiftsTable.findFirst({ where: eq(shiftsTable.id, Number(bodyShiftId)) }) : null;
    if (!current || current.status !== "open" || (await getRegisterLocationId(current.registerId)) !== locationId) {
      res.status(409).json({ error: "Смена продажи закрыта — оформите возврат из текущей открытой смены этой площадки" }); return;
    }
    returnShiftId = current.id;
  }
  const discountPct = Number(sale.discountPercent);

  let result: { totalReturnAmount: number; status: string };
  try {
    result = await db.transaction(async (tx) => {
      let totalReturnAmount = 0;
      for (const it of items) {
        const [saleItem] = await tx.select().from(saleItemsTable).where(and(eq(saleItemsTable.id, it.saleItemId), eq(saleItemsTable.saleId, saleId))).for("update");
        if (!saleItem) throw new Error(`Позиция ${it.saleItemId} не найдена в этой продаже`);
        const available = Number(saleItem.quantity) - Number(saleItem.returnedQuantity);
        const qty = Number(it.quantity);
        if (!(qty > 0) || qty > available + 1e-9) throw new Error(`Некорректное количество для возврата по позиции «${saleItem.name}»`);
        const amount = refundAmount(qty, Number(saleItem.pricePerUnit), discountPct);
        totalReturnAmount += amount;

        const [ret] = await tx.insert(returnsTable).values({
          saleItemId: saleItem.id,
          quantity: String(qty),
          amount: String(amount),
          reason: reason?.trim() || "Возврат",
          shiftId: returnShiftId,
          restocked: !!restock,
          createdByClerkId: req.auth?.userId,
        }).returning({ id: returnsTable.id });
        await tx.update(saleItemsTable).set({ returnedQuantity: sql`${saleItemsTable.returnedQuantity} + ${qty}` }).where(eq(saleItemsTable.id, saleItem.id));

        if (restock) {
          // Dish wasn't prepared: put the written-off ingredients back, pro rata.
          const moved = await tx.select().from(saleStockMovementsTable).where(and(eq(saleStockMovementsTable.saleItemId, saleItem.id), gt(saleStockMovementsTable.qty, "0")));
          const back = restockShare(moved.map((m) => ({ itemId: m.itemId, locationId: m.locationId, qty: Number(m.qty), unitCost: Number(m.unitCost) })), Number(saleItem.quantity), qty);
          for (const w of back) {
            await tx.insert(saleStockMovementsTable).values({ saleItemId: saleItem.id, returnId: ret.id, itemId: w.itemId, locationId: w.locationId, qty: String(-w.qty), unitCost: String(w.unitCost) });
            await addStock(tx, w.itemId, w.locationId, w.qty);
          }
        }
      }
      totalReturnAmount = Math.round(totalReturnAmount * 100) / 100;

      const allItems = await tx.select().from(saleItemsTable).where(eq(saleItemsTable.saleId, saleId));
      const fullyReturned = allItems.every((i) => Number(i.returnedQuantity) >= Number(i.quantity));
      const anyReturned = allItems.some((i) => Number(i.returnedQuantity) > 0);
      const newStatus = fullyReturned ? "returned" : anyReturned ? "partially_returned" : "completed";
      await tx.update(salesTable).set({ status: newStatus }).where(eq(salesTable.id, saleId));
      // Card refunds go back to the card, so only cash refunds reduce the cash drawer.
      await tx.update(shiftsTable).set({
        totalReturns: sql`${shiftsTable.totalReturns} + ${totalReturnAmount}`,
        totalReturnsCash: sql`${shiftsTable.totalReturnsCash} + ${sale.paymentMethod === "cash" ? totalReturnAmount : 0}`,
      }).where(eq(shiftsTable.id, returnShiftId));

      return { totalReturnAmount, status: newStatus };
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Ошибка возврата" });
    return;
  }

  await logAudit({ action: "return", entityType: "sale", entityId: saleId, clerkUserId: req.auth?.userId, details: `${result.totalReturnAmount} сом${restock ? ", продукты возвращены на склад" : ""}` });
  res.json(result);
});

export default router;
