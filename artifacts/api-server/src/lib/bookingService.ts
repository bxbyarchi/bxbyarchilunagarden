/**
 * Guests and bookings business rules, shared by the CRM routes and the AI
 * agent's tools — so a booking made by the AI obeys exactly the same checks.
 */
import { db, guestsTable, diningTablesTable, bookingsTable } from "@workspace/db";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { normalizePhone, formatPhone, freeTables, suggestTables, overlaps, type TableInfo } from "./bookingMath";
import { notifyStaff } from "./telegramBot";
import { logger } from "./logger";

export class BookingError extends Error { constructor(public status: number, message: string) { super(message); } }

export const ACTIVE_STATUSES = ["new", "confirmed", "seated"] as const;
const DAY = 24 * 3600 * 1000;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Guests ─────────────────────────────────────────────────────────────────

export interface GuestInput {
  name?: string | null; phone?: string | null; whatsapp?: string | null; instagram?: string | null; telegram?: string | null;
  email?: string | null; birthday?: string | null; notes?: string | null; tags?: string[]; source?: string | null; isVip?: boolean; isBlacklisted?: boolean;
}

function cleanGuest(input: GuestInput, partial: boolean) {
  const out: Record<string, unknown> = {};
  const txt = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  if (!partial || input.name !== undefined) {
    const name = txt(input.name, 200);
    if (!name) throw new BookingError(400, "Укажите имя гостя");
    out.name = name;
  }
  if (input.phone !== undefined) {
    if (input.phone && !normalizePhone(input.phone)) throw new BookingError(400, "Неверный номер телефона");
    out.phone = normalizePhone(input.phone);
  }
  if (input.whatsapp !== undefined) out.whatsapp = normalizePhone(input.whatsapp) ?? txt(input.whatsapp, 50);
  if (input.instagram !== undefined) out.instagram = txt(input.instagram, 100)?.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, "") ?? null;
  if (input.telegram !== undefined) out.telegram = txt(input.telegram, 100);
  if (input.email !== undefined) out.email = txt(input.email, 200);
  if (input.birthday !== undefined) {
    const b = txt(input.birthday, 10);
    if (b && !/^\d{4}-\d{2}-\d{2}$/.test(b)) throw new BookingError(400, "Дата рождения в формате ГГГГ-ММ-ДД");
    out.birthday = b;
  }
  if (input.notes !== undefined) out.notes = txt(input.notes, 5000);
  if (input.tags !== undefined) out.tags = [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20))];
  if (input.source !== undefined) out.source = txt(input.source, 30);
  if (input.isVip !== undefined) out.isVip = !!input.isVip;
  if (input.isBlacklisted !== undefined) out.isBlacklisted = !!input.isBlacklisted;
  return out;
}

export async function createGuest(input: GuestInput, actor: string | null) {
  const values = cleanGuest(input, false);
  if (values.phone) {
    const dup = await db.query.guestsTable.findFirst({ where: eq(guestsTable.phone, values.phone as string) });
    if (dup) throw new BookingError(409, `Гость с телефоном ${formatPhone(dup.phone)} уже есть: ${dup.name}`);
  }
  const [g] = await db.insert(guestsTable).values({ ...(values as typeof guestsTable.$inferInsert), createdByClerkId: actor }).returning();
  return g;
}

export async function updateGuest(id: number, input: GuestInput) {
  const values = cleanGuest(input, true);
  if (values.phone) {
    const dup = await db.query.guestsTable.findFirst({ where: and(eq(guestsTable.phone, values.phone as string), sql`${guestsTable.id} <> ${id}`) });
    if (dup) throw new BookingError(409, `Телефон уже записан у гостя ${dup.name}`);
  }
  const [g] = await db.update(guestsTable).set(values).where(eq(guestsTable.id, id)).returning();
  if (!g) throw new BookingError(404, "Гость не найден");
  return g;
}

/** Finds a guest by phone, or creates one (used by bookings and the AI agent). Fills in missing contact fields. */
export async function findOrCreateGuest(input: GuestInput & { name: string }, actor: string | null) {
  const phone = normalizePhone(input.phone);
  if (phone) {
    const existing = await db.query.guestsTable.findFirst({ where: eq(guestsTable.phone, phone) });
    if (existing) {
      const fill: GuestInput = {};
      if (!existing.instagram && input.instagram) fill.instagram = input.instagram;
      if (!existing.whatsapp && input.whatsapp) fill.whatsapp = input.whatsapp;
      if (Object.keys(fill).length) await updateGuest(existing.id, fill);
      return { guest: existing, created: false };
    }
  }
  return { guest: await createGuest({ ...input, phone }, actor), created: true };
}

// ─── Availability ───────────────────────────────────────────────────────────

async function activeTables(): Promise<TableInfo[]> {
  return db.select({ id: diningTablesTable.id, name: diningTablesTable.name, zone: diningTablesTable.zone, seats: diningTablesTable.seats })
    .from(diningTablesTable).where(eq(diningTablesTable.isActive, true)).orderBy(asc(diningTablesTable.sortOrder), asc(diningTablesTable.name));
}

/** Bookings that may collide with a slot (±1 day window keeps the query small). */
async function busyAround(startsAt: Date, executor: Tx | typeof db = db) {
  return executor.select({ id: bookingsTable.id, tableIds: bookingsTable.tableIds, startsAt: bookingsTable.startsAt, durationMin: bookingsTable.durationMin })
    .from(bookingsTable)
    .where(and(inArray(bookingsTable.status, [...ACTIVE_STATUSES]), gte(bookingsTable.startsAt, new Date(startsAt.getTime() - DAY)), lt(bookingsTable.startsAt, new Date(startsAt.getTime() + DAY))));
}

export async function checkAvailability(p: { startsAt: Date; durationMin?: number; partySize: number; zone?: string | null; exceptBookingId?: number | null }) {
  const durationMin = p.durationMin ?? 120;
  const tables = await activeTables();
  const free = freeTables(tables, await busyAround(p.startsAt), { startsAt: p.startsAt, durationMin }, p.exceptBookingId);
  return { tables, free, suggestion: suggestTables(free, p.partySize, p.zone) };
}

// ─── Bookings ───────────────────────────────────────────────────────────────

export interface BookingInput {
  guestId?: number; startsAt?: string | Date; durationMin?: number; partySize?: number; tableIds?: number[] | null; zone?: string | null;
  occasion?: string | null; comment?: string | null; depositAmount?: number | string | null; channel?: string | null;
}

function parseStart(v: unknown): Date {
  const d = v instanceof Date ? v : new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new BookingError(400, "Укажите дату и время брони");
  return d;
}

/**
 * Creates a booking. Without tableIds, picks tables automatically. The overlap
 * check runs under an advisory lock so two channels can't take one table.
 */
export async function createBooking(input: BookingInput, actor: string, opts: { notify?: boolean } = {}) {
  const startsAt = parseStart(input.startsAt);
  if (startsAt.getTime() < Date.now() - 15 * 60_000) throw new BookingError(400, "Нельзя забронировать на прошедшее время");
  const durationMin = Math.round(Number(input.durationMin ?? 120));
  const partySize = Math.round(Number(input.partySize));
  if (!(partySize >= 1 && partySize <= 500)) throw new BookingError(400, "Укажите количество гостей");
  if (!(durationMin >= 15 && durationMin <= 1440)) throw new BookingError(400, "Длительность — от 15 минут до суток");
  const guest = input.guestId ? await db.query.guestsTable.findFirst({ where: eq(guestsTable.id, Number(input.guestId)) }) : null;
  if (!guest) throw new BookingError(400, "Гость не найден");
  const deposit = input.depositAmount == null || input.depositAmount === "" ? null : Number(input.depositAmount);
  if (deposit != null && !(deposit >= 0)) throw new BookingError(400, "Неверная сумма предоплаты");

  const booking = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4242017)`);
    const tables = await activeTables();
    const free = freeTables(tables, await busyAround(startsAt, tx), { startsAt, durationMin });
    let tableIds: number[];
    if (input.tableIds?.length) {
      const freeIds = new Set(free.map((t) => t.id));
      const taken = input.tableIds.filter((id) => !freeIds.has(id));
      if (taken.length) {
        const names = tables.filter((t) => taken.includes(t.id)).map((t) => t.name);
        throw new BookingError(409, `Стол ${names.join(", ") || taken.join(", ")} занят в это время`);
      }
      tableIds = input.tableIds;
    } else if (tables.length) {
      const pick = suggestTables(free, partySize, input.zone);
      if (!pick) throw new BookingError(409, "На это время нет свободных столов под такую компанию");
      tableIds = pick.map((t) => t.id);
    } else tableIds = []; // tables not set up yet — bookings still work without seating
    const [created] = await tx.insert(bookingsTable).values({
      guestId: guest.id, startsAt, durationMin, partySize, tableIds, status: "new",
      occasion: input.occasion?.trim() || null, comment: input.comment?.trim() || null,
      depositAmount: deposit != null ? String(deposit) : null, depositStatus: deposit ? "requested" : "none",
      channel: input.channel ?? "crm", createdBy: actor,
    }).returning();
    return created;
  });

  if (opts.notify !== false) void notifyAboutBooking(booking.id, "Новая бронь");
  return booking;
}

export async function bookingSummary(id: number) {
  const [b] = await db.select({ booking: bookingsTable, guest: guestsTable }).from(bookingsTable).innerJoin(guestsTable, eq(bookingsTable.guestId, guestsTable.id)).where(eq(bookingsTable.id, id));
  if (!b) return null;
  const tables = b.booking.tableIds.length ? await db.select({ name: diningTablesTable.name }).from(diningTablesTable).where(inArray(diningTablesTable.id, b.booking.tableIds)) : [];
  return { ...b, tableNames: tables.map((t) => t.name) };
}

export async function notifyAboutBooking(id: number, title: string) {
  try {
    const s = await bookingSummary(id);
    if (!s) return;
    const when = s.booking.startsAt.toLocaleString("ru-RU", { timeZone: process.env.TZ_NAME || "Asia/Bishkek", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    const lines = [
      `📅 ${title} №${s.booking.id}`,
      `${when}, гостей: ${s.booking.partySize}${s.tableNames.length ? `, стол ${s.tableNames.join(" + ")}` : ""}`,
      `${s.guest.name}${s.guest.phone ? ` · ${formatPhone(s.guest.phone)}` : ""}${s.guest.isVip ? " · VIP" : ""}`,
      s.booking.occasion ? `Повод: ${s.booking.occasion}` : "",
      s.booking.comment ? `Комментарий: ${s.booking.comment}` : "",
      s.booking.depositAmount ? `Предоплата: ${Number(s.booking.depositAmount)} сом (${s.booking.depositStatus === "paid" ? "оплачена" : "ожидается"})` : "",
      s.booking.createdBy === "ai" ? `Создана ИИ-агентом (${s.booking.channel ?? "чат"})` : "",
    ].filter(Boolean);
    await notifyStaff(lines.join("\n"));
  } catch (err) { logger.warn({ err }, "notifyAboutBooking failed"); }
}

/** Edits time/size/tables with the same overlap check. */
export async function updateBooking(id: number, input: BookingInput) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4242017)`);
    const [cur] = await tx.select().from(bookingsTable).where(eq(bookingsTable.id, id)).for("update");
    if (!cur) throw new BookingError(404, "Бронь не найдена");
    const startsAt = input.startsAt !== undefined ? parseStart(input.startsAt) : cur.startsAt;
    const durationMin = input.durationMin !== undefined ? Math.round(Number(input.durationMin)) : cur.durationMin;
    const partySize = input.partySize !== undefined ? Math.round(Number(input.partySize)) : cur.partySize;
    if (!(partySize >= 1 && partySize <= 500) || !(durationMin >= 15 && durationMin <= 1440)) throw new BookingError(400, "Проверьте количество гостей и длительность");
    let tableIds = input.tableIds !== undefined && input.tableIds !== null ? input.tableIds : cur.tableIds;
    if (ACTIVE_STATUSES.includes(cur.status as (typeof ACTIVE_STATUSES)[number]) && tableIds.length) {
      const busy = await busyAround(startsAt, tx);
      const clash = busy.filter((b) => b.id !== id && overlaps(b, { startsAt, durationMin }) && b.tableIds.some((t) => tableIds.includes(t)));
      if (clash.length) throw new BookingError(409, `Стол занят другой бронью (№${clash.map((c) => c.id).join(", №")})`);
    }
    const deposit = input.depositAmount === undefined ? undefined : input.depositAmount == null || input.depositAmount === "" ? null : Number(input.depositAmount);
    const [row] = await tx.update(bookingsTable).set({
      startsAt, durationMin, partySize, tableIds,
      ...(input.occasion !== undefined ? { occasion: input.occasion?.trim() || null } : {}),
      ...(input.comment !== undefined ? { comment: input.comment?.trim() || null } : {}),
      ...(deposit !== undefined ? { depositAmount: deposit != null ? String(deposit) : null, ...(cur.depositStatus === "none" && deposit ? { depositStatus: "requested" } : {}) } : {}),
    }).where(eq(bookingsTable.id, id)).returning();
    tableIds = row.tableIds;
    return row;
  });
}

export const STATUS_LABEL: Record<string, string> = { new: "новая", confirmed: "подтверждена", seated: "гости в зале", completed: "завершена", cancelled: "отменена", no_show: "не пришли" };

const TRANSITIONS: Record<string, string[]> = {
  new: ["confirmed", "seated", "cancelled", "no_show"],
  confirmed: ["seated", "cancelled", "no_show", "new"],
  seated: ["completed", "confirmed"],
  completed: ["seated"],
  cancelled: ["new"],
  no_show: ["new"],
};

export async function setBookingStatus(id: number, status: string, reason?: string | null) {
  const cur = await db.query.bookingsTable.findFirst({ where: eq(bookingsTable.id, id) });
  if (!cur) throw new BookingError(404, "Бронь не найдена");
  if (!TRANSITIONS[cur.status]?.includes(status)) throw new BookingError(409, `Нельзя перевести бронь из «${STATUS_LABEL[cur.status] ?? cur.status}» в «${STATUS_LABEL[status] ?? status}»`);
  if (status === "new" || status === "confirmed") {
    // Reopening: make sure the tables are still free.
    const busy = await busyAround(cur.startsAt);
    const clash = busy.filter((b) => b.id !== id && overlaps(b, cur) && b.tableIds.some((t) => cur.tableIds.includes(t)));
    if (clash.length) throw new BookingError(409, "Стол уже занят другой бронью — выберите другой");
  }
  const [row] = await db.update(bookingsTable).set({ status, ...(status === "cancelled" ? { cancelReason: reason?.trim() || null } : {}) }).where(eq(bookingsTable.id, id)).returning();
  if (status === "cancelled") void notifyAboutBooking(id, "Бронь отменена");
  return row;
}

export async function setDeposit(id: number, p: { status: string; method?: string | null; amount?: number | string | null }) {
  if (!["none", "requested", "paid", "refunded"].includes(p.status)) throw new BookingError(400, "Неверный статус предоплаты");
  if (p.status === "paid" && !["qr", "transfer", "cash"].includes(p.method ?? "")) throw new BookingError(400, "Укажите способ оплаты: QR, перевод или наличные");
  const amount = p.amount === undefined ? undefined : p.amount == null || p.amount === "" ? null : Number(p.amount);
  if (amount !== undefined && amount !== null && !(amount >= 0)) throw new BookingError(400, "Неверная сумма");
  const [row] = await db.update(bookingsTable).set({
    depositStatus: p.status, depositMethod: p.status === "paid" ? p.method! : p.status === "none" ? null : undefined,
    depositPaidAt: p.status === "paid" ? new Date() : p.status === "none" || p.status === "requested" ? null : undefined,
    ...(amount !== undefined ? { depositAmount: amount != null ? String(amount) : null } : {}),
  }).where(eq(bookingsTable.id, id)).returning();
  if (!row) throw new BookingError(404, "Бронь не найдена");
  if (p.status === "paid") void notifyAboutBooking(id, "Предоплата получена по брони");
  return row;
}
