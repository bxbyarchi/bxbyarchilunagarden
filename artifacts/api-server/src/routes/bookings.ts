import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, guestsTable, bookingsTable, diningTablesTable, usersTable } from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope } from "../lib/warehouseScope";
import { logAudit } from "../lib/auditLogger";
import {
  BookingError, createGuest, updateGuest, findOrCreateGuest, checkAvailability, createBooking, updateBooking,
  setBookingStatus, setDeposit, notifyAboutBooking,
} from "../lib/bookingService";
import { normalizePhone } from "../lib/bookingMath";

const router: IRouter = Router();

/** Front-of-house roles: admins, managers and cashiers/hosts. */
const FOH_ROLES = ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"];
function requireFoh() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const scope = await getWarehouseScope(req);
    if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!FOH_ROLES.includes(scope.role)) { res.status(403).json({ error: "Брони доступны администраторам, менеджерам и кассирам" }); return; }
    next();
  };
}
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof BookingError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  };
}
const guard = [requireAuth(), requireFoh()];

// ─── Guests ─────────────────────────────────────────────────────────────────

const visits = db.$with("visits").as(
  db.select({
    guestId: bookingsTable.guestId,
    visits: sql<number>`COUNT(*) FILTER (WHERE ${bookingsTable.status} = 'completed')::int`.as("visits"),
    noShows: sql<number>`COUNT(*) FILTER (WHERE ${bookingsTable.status} = 'no_show')::int`.as("no_shows"),
    lastVisit: sql<string | null>`MAX(${bookingsTable.startsAt}) FILTER (WHERE ${bookingsTable.status} = 'completed')`.as("last_visit"),
    nextBooking: sql<string | null>`MIN(${bookingsTable.startsAt}) FILTER (WHERE ${bookingsTable.status} IN ('new','confirmed') AND ${bookingsTable.startsAt} >= now())`.as("next_booking"),
  }).from(bookingsTable).groupBy(bookingsTable.guestId),
);

router.get("/guests", ...guard, handle(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const conds: SQL[] = [];
  if (q) {
    const term = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const digits = q.replace(/\D/g, "");
    conds.push(or(ilike(guestsTable.name, term), ilike(guestsTable.instagram, term), ilike(guestsTable.notes, term),
      ...(digits.length >= 3 ? [sql`${guestsTable.phone} LIKE ${`%${digits.replace(/^0/, "")}%`}`] : []))!);
  }
  if (req.query.tag) conds.push(sql`${String(req.query.tag)} = ANY(${guestsTable.tags})`);
  if (req.query.vip === "1") conds.push(eq(guestsTable.isVip, true));
  const rows = await db.with(visits).select({
    id: guestsTable.id, name: guestsTable.name, phone: guestsTable.phone, instagram: guestsTable.instagram, tags: guestsTable.tags,
    isVip: guestsTable.isVip, isBlacklisted: guestsTable.isBlacklisted, source: guestsTable.source, birthday: guestsTable.birthday,
    visits: visits.visits, noShows: visits.noShows, lastVisit: visits.lastVisit, nextBooking: visits.nextBooking, createdAt: guestsTable.createdAt,
  }).from(guestsTable).leftJoin(visits, eq(visits.guestId, guestsTable.id))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(guestsTable.updatedAt)).limit(500);
  res.json(rows.map((r) => ({ ...r, visits: r.visits ?? 0, noShows: r.noShows ?? 0 })));
}));

router.get("/guests/:id", ...guard, handle(async (req, res) => {
  const id = Number(req.params.id);
  const guest = await db.query.guestsTable.findFirst({ where: eq(guestsTable.id, id) });
  if (!guest) throw new BookingError(404, "Гость не найден");
  const bookings = await db.select().from(bookingsTable).where(eq(bookingsTable.guestId, id)).orderBy(desc(bookingsTable.startsAt)).limit(200);
  const deposits = bookings.filter((b) => b.depositStatus === "paid").reduce((s, b) => s + Number(b.depositAmount ?? 0), 0);
  res.json({ ...guest, bookings, stats: {
    visits: bookings.filter((b) => b.status === "completed").length, noShows: bookings.filter((b) => b.status === "no_show").length,
    cancelled: bookings.filter((b) => b.status === "cancelled").length, depositsPaid: deposits,
  } });
}));

router.post("/guests", ...guard, handle(async (req, res) => {
  const g = await createGuest(req.body, req.auth?.userId ?? null);
  await logAudit({ action: "create", entityType: "guest", entityId: g.id, clerkUserId: req.auth?.userId, details: g.name });
  res.status(201).json(g);
}));

router.patch("/guests/:id", ...guard, handle(async (req, res) => {
  const g = await updateGuest(Number(req.params.id), req.body);
  await logAudit({ action: "update", entityType: "guest", entityId: g.id, clerkUserId: req.auth?.userId, details: g.name });
  res.json(g);
}));

/** Quick lookup by phone while typing a booking. */
router.get("/guests-lookup", ...guard, handle(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  res.json(phone ? (await db.query.guestsTable.findFirst({ where: eq(guestsTable.phone, phone) })) ?? null : null);
}));

// ─── Tables ─────────────────────────────────────────────────────────────────

router.get("/dining-tables", ...guard, handle(async (_req, res) => {
  res.json(await db.select().from(diningTablesTable).orderBy(asc(diningTablesTable.sortOrder), asc(diningTablesTable.name)));
}));

function tableValues(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 50) : "";
    if (!name) throw new BookingError(400, "Укажите номер или название стола");
    out.name = name;
  }
  if (body.zone !== undefined) out.zone = typeof body.zone === "string" && body.zone.trim() ? body.zone.trim().slice(0, 50) : null;
  if (!partial || body.seats !== undefined) {
    const seats = Math.round(Number(body.seats));
    if (!(seats >= 1 && seats <= 100)) throw new BookingError(400, "Мест за столом — от 1 до 100");
    out.seats = seats;
  }
  if (body.sortOrder !== undefined) out.sortOrder = Math.round(Number(body.sortOrder)) || 0;
  if (body.isActive !== undefined) out.isActive = body.isActive !== false;
  return out;
}

router.post("/dining-tables", ...guard, handle(async (req, res) => {
  const [row] = await db.insert(diningTablesTable).values(tableValues(req.body, false) as typeof diningTablesTable.$inferInsert).onConflictDoNothing().returning();
  if (!row) throw new BookingError(409, "Стол с таким названием уже есть");
  res.status(201).json(row);
}));

router.patch("/dining-tables/:id", ...guard, handle(async (req, res) => {
  const [row] = await db.update(diningTablesTable).set(tableValues(req.body, true)).where(eq(diningTablesTable.id, Number(req.params.id))).returning();
  if (!row) throw new BookingError(404, "Стол не найден");
  res.json(row);
}));

// ─── Bookings ───────────────────────────────────────────────────────────────

const createdByName = sql<string | null>`CASE WHEN ${bookingsTable.createdBy} = 'ai' THEN 'ИИ-агент' ELSE (SELECT NULLIF(TRIM(COALESCE(${usersTable.firstName}, '') || ' ' || COALESCE(${usersTable.lastName}, '')), '') FROM ${usersTable} WHERE ${usersTable.clerkUserId} = ${bookingsTable.createdBy}) END`;

router.get("/bookings", ...guard, handle(async (req, res) => {
  const from = new Date(String(req.query.from ?? ""));
  const to = new Date(String(req.query.to ?? ""));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 93 * 24 * 3600 * 1000) throw new BookingError(400, "Укажите период до 3 месяцев");
  const rows = await db.select({
    id: bookingsTable.id, startsAt: bookingsTable.startsAt, durationMin: bookingsTable.durationMin, partySize: bookingsTable.partySize,
    tableIds: bookingsTable.tableIds, status: bookingsTable.status, occasion: bookingsTable.occasion, comment: bookingsTable.comment,
    depositAmount: bookingsTable.depositAmount, depositStatus: bookingsTable.depositStatus, depositMethod: bookingsTable.depositMethod,
    channel: bookingsTable.channel, cancelReason: bookingsTable.cancelReason, createdAt: bookingsTable.createdAt, createdByName,
    guestId: guestsTable.id, guestName: guestsTable.name, guestPhone: guestsTable.phone, guestVip: guestsTable.isVip, guestNotes: guestsTable.notes,
  }).from(bookingsTable).innerJoin(guestsTable, eq(bookingsTable.guestId, guestsTable.id))
    .where(and(gte(bookingsTable.startsAt, from), lt(bookingsTable.startsAt, to))).orderBy(asc(bookingsTable.startsAt));
  res.json(rows.map((r) => ({ ...r, depositAmount: r.depositAmount == null ? null : Number(r.depositAmount) })));
}));

router.get("/bookings/availability", ...guard, handle(async (req, res) => {
  const startsAt = new Date(String(req.query.startsAt ?? ""));
  if (Number.isNaN(startsAt.getTime())) throw new BookingError(400, "Укажите время");
  const r = await checkAvailability({
    startsAt, durationMin: req.query.durationMin ? Number(req.query.durationMin) : undefined, partySize: Number(req.query.partySize) || 1,
    zone: typeof req.query.zone === "string" && req.query.zone ? req.query.zone : null, exceptBookingId: req.query.exceptId ? Number(req.query.exceptId) : null,
  });
  res.json({ free: r.free, suggestion: r.suggestion, tablesConfigured: r.tables.length > 0 });
}));

router.post("/bookings", ...guard, handle(async (req, res) => {
  const body = req.body as Record<string, unknown> & { guest?: { name?: string; phone?: string; instagram?: string } };
  let guestId = body.guestId != null ? Number(body.guestId) : null;
  if (!guestId && body.guest) guestId = (await findOrCreateGuest({ ...body.guest, name: body.guest.name ?? "", source: (body.channel as string) ?? "crm" }, req.auth?.userId ?? null)).guest.id;
  const booking = await createBooking({ ...(body as object), guestId: guestId ?? undefined } as Parameters<typeof createBooking>[0], req.auth?.userId ?? "crm");
  await logAudit({ action: "create", entityType: "booking", entityId: booking.id, clerkUserId: req.auth?.userId });
  res.status(201).json(booking);
}));

router.patch("/bookings/:id", ...guard, handle(async (req, res) => {
  const row = await updateBooking(Number(req.params.id), req.body);
  await logAudit({ action: "update", entityType: "booking", entityId: row.id, clerkUserId: req.auth?.userId });
  res.json(row);
}));

router.post("/bookings/:id/status", ...guard, handle(async (req, res) => {
  const { status, reason } = req.body as { status?: string; reason?: string };
  const row = await setBookingStatus(Number(req.params.id), String(status ?? ""), reason);
  await logAudit({ action: "update", entityType: "booking", entityId: row.id, clerkUserId: req.auth?.userId, details: `Статус: ${row.status}` });
  res.json(row);
}));

router.post("/bookings/:id/deposit", ...guard, handle(async (req, res) => {
  const row = await setDeposit(Number(req.params.id), req.body);
  await logAudit({ action: "update", entityType: "booking", entityId: row.id, clerkUserId: req.auth?.userId, details: `Предоплата: ${row.depositStatus}${row.depositMethod ? ` (${row.depositMethod})` : ""}` });
  res.json(row);
}));

router.post("/bookings/:id/notify", ...guard, handle(async (req, res) => {
  await notifyAboutBooking(Number(req.params.id), "Напоминание о брони");
  res.json({ ok: true });
}));

export default router;
