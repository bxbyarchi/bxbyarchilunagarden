import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { saveDataUrl, readStored, FileError } from "../lib/files";
import { bestMatch, isDescriptor, consistentSamples } from "../lib/faceMath";
import { requireAuth } from "../lib/requireAuth";
import { db, staffTable, staffSchedulesTable, attendanceTable, staffFacesTable, usersTable, locationsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope, isWarehouseAdmin, type WarehouseScope } from "../lib/warehouseScope";
import { logAudit } from "../lib/auditLogger";
import { summarize, planWindow, addDays, isDate, isTime, type PlanRow, type PresenceRow } from "../lib/timesheet";
import { localDateTime, toLocal } from "../lib/ai/helpers";

const router: IRouter = Router();

// Who may edit staff cards, schedules and correct attendance.
const ADMIN = ["super_admin", "warehouse_chief", "location_admin", "manager"];
// Who may look at timesheets (accounting needs hours and pay).
const VIEW = [...ADMIN, "accountant"];
// Who may run the check-in kiosk (a tablet logged in by a manager or cashier).
const KIOSK = [...ADMIN, "cashier"];
export const DEPARTMENTS = ["kitchen", "bar", "pastry", "hall", "admin", "tech", "other"] as const;

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
type Handler = (req: Request, res: Response, scope: WarehouseScope) => Promise<void>;
function route(roles: string[], fn: Handler) {
  return [requireAuth(), async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const scope = await getWarehouseScope(req);
      if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!roles.includes(scope.role)) { res.status(403).json({ error: "Нет доступа" }); return; }
      await fn(req, res, scope);
    } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      if ((e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505") { res.status(409).json({ error: "Запись уже существует" }); return; }
      throw e;
    }
  }];
}

/** Staff visible to this user: admins see all (or a chosen location); others their location + unassigned. */
function staffScope(scope: WarehouseScope, requested?: unknown): SQL | undefined {
  const req = requested ? Number(requested) : null;
  if (isWarehouseAdmin(scope.role) || scope.role === "location_admin" || !scope.locationId) return req ? eq(staffTable.locationId, req) : undefined;
  return or(eq(staffTable.locationId, scope.locationId), isNull(staffTable.locationId));
}
async function staffInScope(scope: WarehouseScope, id: number) {
  const [s] = await db.select().from(staffTable).where(and(eq(staffTable.id, id), staffScope(scope)));
  if (!s) throw new HttpError(404, "Сотрудник не найден");
  return s;
}

// PINs are short, so hashing only keeps them out of plain sight in the DB; the
// real protection is the kiosk's rate limit and that the kiosk needs a login.
const pinHash = (pin: string) => createHash("sha256").update(`lg-pin:${pin}`).digest("hex");
const num = (v: unknown) => (v === "" || v == null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? String(Number(v)) : (() => { throw new HttpError(400, "Неверная ставка"); })());

async function savePhoto(dataUrl: unknown): Promise<string | null> {
  if (dataUrl == null || dataUrl === "") return null;
  try { return await saveDataUrl("attendance", dataUrl); } catch (e) { if (e instanceof FileError) throw new HttpError(400, e.message); throw e; }
}
const photoUrl = (rel: string | null) => (rel ? `/api/personnel/photo/${rel}` : null);

// ─── Staff cards ────────────────────────────────────────────────────────────

router.get("/personnel/staff", ...route(VIEW, async (req, res, scope) => {
  const rows = await db.select({
    id: staffTable.id, name: staffTable.name, position: staffTable.position, phone: staffTable.phone, isActive: staffTable.isActive,
    locationId: staffTable.locationId, locationName: locationsTable.name, department: staffTable.department, userClerkId: staffTable.userClerkId,
    hourlyRate: staffTable.hourlyRate, shiftRate: staffTable.shiftRate, hasPin: sql<boolean>`${staffTable.pinHash} IS NOT NULL`,
    faceSamples: sql<number>`(SELECT count(*)::int FROM ${staffFacesTable} f WHERE f.staff_id = ${staffTable.id})`,
    hireDate: staffTable.hireDate, notes: staffTable.notes, photoConsentAt: staffTable.photoConsentAt,
    accountName: sql<string | null>`NULLIF(concat_ws(' ', ${usersTable.firstName}, ${usersTable.lastName}), '')`, accountLogin: usersTable.email,
    openSince: sql<string | null>`(SELECT a.check_in_at FROM ${attendanceTable} a WHERE a.staff_id = ${staffTable.id} AND a.check_out_at IS NULL)`,
  }).from(staffTable)
    .leftJoin(locationsTable, eq(staffTable.locationId, locationsTable.id))
    .leftJoin(usersTable, eq(usersTable.clerkUserId, staffTable.userClerkId))
    .where(staffScope(scope, req.query.locationId))
    .orderBy(desc(staffTable.isActive), asc(staffTable.name));
  res.json(rows.map((r) => ({ ...r, hourlyRate: r.hourlyRate == null ? null : Number(r.hourlyRate), shiftRate: r.shiftRate == null ? null : Number(r.shiftRate) })));
}));

router.get("/personnel/accounts", ...route(ADMIN, async (_req, res) => {
  res.json(await db.select({ clerkUserId: usersTable.clerkUserId, login: usersTable.email, firstName: usersTable.firstName, lastName: usersTable.lastName, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.isActive, true)).orderBy(usersTable.firstName));
}));

async function staffValues(body: Record<string, unknown>, scope: WarehouseScope, id: number | null) {
  const v: Partial<typeof staffTable.$inferInsert> = {};
  if (body.name !== undefined) { const n = String(body.name ?? "").trim(); if (!n) throw new HttpError(400, "Укажите имя"); v.name = n; }
  for (const k of ["position", "phone", "notes"] as const) if (body[k] !== undefined) v[k] = body[k] ? String(body[k]).trim() : null;
  if (body.department !== undefined) {
    if (body.department && !DEPARTMENTS.includes(body.department as never)) throw new HttpError(400, "Неизвестный отдел");
    v.department = (body.department as string) || null;
  }
  if (body.isActive !== undefined) v.isActive = !!body.isActive;
  if (body.hourlyRate !== undefined) v.hourlyRate = num(body.hourlyRate);
  if (body.shiftRate !== undefined) v.shiftRate = num(body.shiftRate);
  if (body.hireDate !== undefined) { if (body.hireDate && !isDate(body.hireDate)) throw new HttpError(400, "Неверная дата"); v.hireDate = (body.hireDate as string) || null; }
  if (body.locationId !== undefined) {
    const loc = body.locationId ? Number(body.locationId) : null;
    v.locationId = isWarehouseAdmin(scope.role) || scope.role === "location_admin" || !scope.locationId ? loc : scope.locationId;
  }
  if (body.userClerkId !== undefined) {
    const u = body.userClerkId ? String(body.userClerkId) : null;
    if (u) {
      if (!(await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, u) }))) throw new HttpError(400, "Аккаунт не найден");
      const [other] = await db.select({ id: staffTable.id, name: staffTable.name }).from(staffTable).where(eq(staffTable.userClerkId, u));
      if (other && other.id !== id) throw new HttpError(409, `Этот аккаунт уже привязан к сотруднику «${other.name}»`);
    }
    v.userClerkId = u;
  }
  if (body.pin !== undefined) {
    if (body.pin === null || body.pin === "") v.pinHash = null;
    else {
      if (!/^\d{4,6}$/.test(String(body.pin))) throw new HttpError(400, "PIN — от 4 до 6 цифр");
      const h = pinHash(String(body.pin));
      const [other] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.pinHash, h));
      if (other && other.id !== id) throw new HttpError(409, "Этот PIN уже у другого сотрудника — выберите другой");
      v.pinHash = h;
    }
  }
  if (body.photoConsent !== undefined) v.photoConsentAt = body.photoConsent ? new Date() : null;
  return v;
}

router.post("/personnel/staff", ...route(ADMIN, async (req, res, scope) => {
  const v = await staffValues(req.body ?? {}, scope, null);
  if (!v.name) throw new HttpError(400, "Укажите имя");
  const [row] = await db.insert(staffTable).values({ ...v, name: v.name }).returning({ id: staffTable.id });
  await logAudit({ action: "create", entityType: "staff", entityId: row.id, clerkUserId: scope.userId });
  res.status(201).json(row);
}));

router.patch("/personnel/staff/:id", ...route(ADMIN, async (req, res, scope) => {
  const s = await staffInScope(scope, Number(req.params.id));
  const body = { ...(req.body ?? {}) };
  if (body.photoConsent !== undefined && !!body.photoConsent === !!s.photoConsentAt) delete body.photoConsent;
  const v = await staffValues(body, scope, s.id);
  if (Object.keys(v).length) await db.update(staffTable).set(v).where(eq(staffTable.id, s.id));
  // Without consent we may not keep biometric data.
  if (v.photoConsentAt === null || v.isActive === false) await db.delete(staffFacesTable).where(eq(staffFacesTable.staffId, s.id));
  await logAudit({ action: "update", entityType: "staff", entityId: s.id, clerkUserId: scope.userId, details: JSON.stringify({ fields: Object.keys(v).map((k) => (k === "pinHash" ? "pin" : k)) }) });
  res.json({ ok: true });
}));

// ─── Schedule ───────────────────────────────────────────────────────────────

function range(req: Request) {
  const from = req.query.from, to = req.query.to;
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, "Укажите период");
  if (Date.parse(to) - Date.parse(from) > 92 * 86400_000) throw new HttpError(400, "Период не больше 3 месяцев");
  return { from, to };
}

async function loadPeriod(scope: WarehouseScope, from: string, to: string, locationId?: unknown, staffId?: number) {
  const conds = [staffScope(scope, locationId), staffId ? eq(staffTable.id, staffId) : undefined].filter(Boolean) as SQL[];
  const staff = await db.select().from(staffTable).where(conds.length ? and(...conds) : undefined).orderBy(asc(staffTable.name));
  const ids = staff.map((s) => s.id);
  if (!ids.length) return { staff, plans: [] as (typeof staffSchedulesTable.$inferSelect)[], presence: [] as (typeof attendanceTable.$inferSelect)[] };
  const plans = await db.select().from(staffSchedulesTable)
    .where(and(inArray(staffSchedulesTable.staffId, ids), gte(staffSchedulesTable.date, from), lte(staffSchedulesTable.date, to)));
  // Presence a little wider than the period so overnight / early arrivals still match their plan.
  const start = new Date(localDateTime(from, "00:00")!.getTime() - 6 * 3600_000);
  const end = new Date(localDateTime(addDays(to, 1), "00:00")!.getTime() + 6 * 3600_000);
  const presence = await db.select().from(attendanceTable)
    .where(and(inArray(attendanceTable.staffId, ids), gte(attendanceTable.checkInAt, start), lt(attendanceTable.checkInAt, end)))
    .orderBy(asc(attendanceTable.checkInAt));
  return { staff, plans, presence };
}

router.get("/personnel/schedule", ...route(VIEW, async (req, res, scope) => {
  const { from, to } = range(req);
  const { staff, plans, presence } = await loadPeriod(scope, from, to, req.query.locationId);
  const sum = summarize(staff.map((s) => s.id), plans as PlanRow[], presence as PresenceRow[], new Map(), { now: new Date() });
  const status = new Map(sum.flatMap((s) => s.plans.map((p) => [p.planId, p] as const)));
  res.json({
    staff: staff.filter((s) => s.isActive || plans.some((p) => p.staffId === s.id)).map((s) => ({ id: s.id, name: s.name, position: s.position, department: s.department })),
    plans: plans.map((p) => { const st = status.get(p.id); return { id: p.id, staffId: p.staffId, date: p.date, startTime: p.startTime, endTime: p.endTime, note: p.note, status: st?.status ?? "upcoming", lateMin: st?.lateMin ?? 0, workedMin: st?.workedMin ?? 0 }; }),
  });
}));

router.put("/personnel/schedule", ...route(ADMIN, async (req, res, scope) => {
  const { staffId, date, startTime, endTime, note } = req.body ?? {};
  const s = await staffInScope(scope, Number(staffId));
  if (!isDate(date)) throw new HttpError(400, "Неверная дата");
  if (startTime == null || startTime === "") {
    await db.delete(staffSchedulesTable).where(and(eq(staffSchedulesTable.staffId, s.id), eq(staffSchedulesTable.date, date)));
    res.json({ ok: true, deleted: true }); return;
  }
  if (!isTime(startTime) || !isTime(endTime)) throw new HttpError(400, "Время в формате ЧЧ:ММ");
  if (startTime === endTime) throw new HttpError(400, "Начало и конец смены совпадают");
  const values = { staffId: s.id, date, startTime, endTime, note: note ? String(note) : null, createdByClerkId: scope.userId };
  const [row] = await db.insert(staffSchedulesTable).values(values)
    .onConflictDoUpdate({ target: [staffSchedulesTable.staffId, staffSchedulesTable.date], set: { startTime, endTime, note: values.note } }).returning();
  res.json(row);
}));

router.post("/personnel/schedule/copy-week", ...route(ADMIN, async (req, res, scope) => {
  const { fromMonday, toMonday, locationId } = req.body ?? {};
  if (!isDate(fromMonday) || !isDate(toMonday) || fromMonday === toMonday) throw new HttpError(400, "Неверные недели");
  const { staff, plans } = await loadPeriod(scope, fromMonday, addDays(fromMonday, 6), locationId);
  const active = new Set(staff.filter((s) => s.isActive).map((s) => s.id));
  const shift = Math.round((Date.parse(toMonday) - Date.parse(fromMonday)) / 86400_000);
  const values = plans.filter((p) => active.has(p.staffId)).map((p) => ({ staffId: p.staffId, date: addDays(p.date, shift), startTime: p.startTime, endTime: p.endTime, note: p.note, createdByClerkId: scope.userId }));
  const inserted = values.length ? await db.insert(staffSchedulesTable).values(values).onConflictDoNothing().returning({ id: staffSchedulesTable.id }) : [];
  res.json({ copied: inserted.length, skipped: values.length - inserted.length });
}));

// ─── Face enrolment ─────────────────────────────────────────────────────────

router.put("/personnel/staff/:id/faces", ...route(ADMIN, async (req, res, scope) => {
  const s = await staffInScope(scope, Number(req.params.id));
  if (!s.photoConsentAt) throw new HttpError(400, "Сначала отметьте письменное согласие сотрудника на фото и распознавание лица");
  if (!s.isActive) throw new HttpError(400, "Сотрудник уволен");
  const samples = req.body?.descriptors;
  if (!Array.isArray(samples) || samples.length < 3 || samples.length > 10 || !samples.every(isDescriptor)) throw new HttpError(400, "Нужно от 3 до 10 снимков лица");
  if (!consistentSamples(samples)) throw new HttpError(400, "Снимки похожи на разных людей — повторите, чтобы в кадре был только сотрудник");
  // Someone else's face must not end up on this card.
  const others = (await db.select({ staffId: staffFacesTable.staffId, descriptor: staffFacesTable.descriptor }).from(staffFacesTable)).filter((f) => f.staffId !== s.id);
  const clash = bestMatch(samples[0], others);
  if (clash.staffId != null) {
    const [o] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, clash.staffId));
    throw new HttpError(409, `Это лицо уже зарегистрировано у сотрудника «${o?.name ?? clash.staffId}»`);
  }
  await db.transaction(async (tx) => {
    await tx.delete(staffFacesTable).where(eq(staffFacesTable.staffId, s.id));
    await tx.insert(staffFacesTable).values(samples.map((d: number[]) => ({ staffId: s.id, descriptor: d, createdByClerkId: scope.userId })));
  });
  await logAudit({ action: "update", entityType: "staff", entityId: s.id, clerkUserId: scope.userId, details: `Лицо зарегистрировано (${samples.length} снимков)` });
  res.json({ ok: true, samples: samples.length });
}));

router.delete("/personnel/staff/:id/faces", ...route(ADMIN, async (req, res, scope) => {
  const s = await staffInScope(scope, Number(req.params.id));
  await db.delete(staffFacesTable).where(eq(staffFacesTable.staffId, s.id));
  await logAudit({ action: "update", entityType: "staff", entityId: s.id, clerkUserId: scope.userId, details: "Лицо удалено" });
  res.status(204).end();
}));

async function matchFace(descriptor: unknown) {
  if (!isDescriptor(descriptor)) throw new HttpError(400, "Неверные данные лица");
  const enrolled = await db.select({ staffId: staffFacesTable.staffId, descriptor: staffFacesTable.descriptor }).from(staffFacesTable)
    .innerJoin(staffTable, eq(staffTable.id, staffFacesTable.staffId)).where(and(eq(staffTable.isActive, true), isNotNull(staffTable.photoConsentAt)));
  return bestMatch(descriptor, enrolled);
}

router.get("/personnel/kiosk/faces-enabled", ...route(KIOSK, async (_req, res) => {
  const [{ n }] = await db.select({ n: sql<number>`count(DISTINCT ${staffFacesTable.staffId})::int` }).from(staffFacesTable);
  res.json({ staff: n });
}));

/** Who is in front of the camera — no side effects; the kiosk then asks "is it you?". */
router.post("/personnel/kiosk/identify", ...route(KIOSK, async (req, res) => {
  const m = await matchFace(req.body?.descriptor);
  if (m.staffId == null) { res.json({ found: false, reason: m.reason }); return; }
  const [s] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, m.staffId));
  const [open] = await db.select({ id: attendanceTable.id }).from(attendanceTable).where(and(eq(attendanceTable.staffId, m.staffId), isNull(attendanceTable.checkOutAt)));
  // Shown on the kiosk as "similarity": 0.0 → 100 %, the 0.5 threshold → ~83 %.
  const percent = Math.max(0, Math.min(99, Math.round(100 * (1 - (m.distance / 1.2) ** 2))));
  res.json({ found: true, staffName: s.name, action: open ? "out" : "in", percent });
}));

// ─── Kiosk: check in / out by face or PIN, with a photo ─────────────────────

const failures = new Map<string, { n: number; until: number }>();
router.post("/personnel/kiosk", ...route(KIOSK, async (req, res, scope) => {
  const key = scope.userId;
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, "Слишком много неверных PIN. Подождите минуту.");
  const pin = String(req.body?.pin ?? "");
  let s: typeof staffTable.$inferSelect | undefined;
  let method = "kiosk";
  if (req.body?.descriptor) {
    // The server matches again: the kiosk's "it's you" is never trusted on its own.
    const m = await matchFace(req.body.descriptor);
    if (m.staffId == null) throw new HttpError(404, "Лицо не узнано — введите PIN");
    [s] = await db.select().from(staffTable).where(and(eq(staffTable.id, m.staffId), eq(staffTable.isActive, true)));
    method = "face";
  } else s = /^\d{4,6}$/.test(pin) ? (await db.select().from(staffTable).where(and(eq(staffTable.pinHash, pinHash(pin)), eq(staffTable.isActive, true))))[0] : undefined;
  if (!s && method === "face") throw new HttpError(404, "Лицо не узнано — введите PIN");
  if (!s) {
    const n = (f && f.until > Date.now() - 120_000 ? f.n : 0) + 1;
    failures.set(key, { n, until: n >= 5 ? Date.now() + 60_000 : Date.now() });
    throw new HttpError(404, "Неверный PIN");
  }
  failures.delete(key);
  const now = new Date();
  const [open] = await db.select().from(attendanceTable).where(and(eq(attendanceTable.staffId, s.id), isNull(attendanceTable.checkOutAt)));
  // A second tap within 2 minutes is almost always a mistake — ask before closing the shift.
  if (open && now.getTime() - open.checkInAt.getTime() < 120_000 && !req.body?.confirm) {
    res.json({ action: "confirm", staffName: s.name, message: `Вы отметили приход в ${toLocal(open.checkInAt).time}. Закрыть смену уже сейчас?` }); return;
  }
  const photo = await savePhoto(req.body?.photo);
  const today = toLocal(now).date;
  const [plan] = await db.select().from(staffSchedulesTable)
    .where(and(eq(staffSchedulesTable.staffId, s.id), inArray(staffSchedulesTable.date, [addDays(today, -1), today])))
    .orderBy(desc(staffSchedulesTable.date));
  const w = plan ? planWindow(plan.date, plan.startTime, plan.endTime) : null;
  const relevant = w && (w.end.getTime() + 4 * 3600_000 > now.getTime()) ? w : null;

  if (open) {
    await db.update(attendanceTable).set({ checkOutAt: now, checkOutPhoto: photo }).where(eq(attendanceTable.id, open.id));
    const workedMin = Math.round((now.getTime() - open.checkInAt.getTime()) / 60_000);
    const overtimeMin = relevant ? Math.max(0, Math.round((now.getTime() - relevant.end.getTime()) / 60_000)) : 0;
    res.json({ action: "out", staffName: s.name, at: now, since: open.checkInAt, workedMin, overtimeMin, earlyMin: relevant ? Math.max(0, Math.round((relevant.end.getTime() - now.getTime()) / 60_000)) : 0 });
  } else {
    const [row] = await db.insert(attendanceTable).values({ staffId: s.id, checkInAt: now, checkInPhoto: photo, method }).returning({ id: attendanceTable.id });
    const lateMin = relevant ? Math.max(0, Math.round((now.getTime() - relevant.start.getTime()) / 60_000)) : 0;
    res.json({ action: "in", id: row.id, staffName: s.name, at: now, plan: relevant && plan ? { startTime: plan.startTime, endTime: plan.endTime } : null, lateMin: lateMin > 5 ? lateMin : 0 });
  }
}));

router.get("/personnel/photo/:month/:file", ...route(VIEW, async (req, res) => {
  const f = await readStored("attendance", `${req.params.month}/${req.params.file}`);
  if (!f) throw new HttpError(404, "Нет фото");
  res.setHeader("Content-Type", f.mime); res.setHeader("Cache-Control", "private, max-age=86400"); res.end(f.buf);
}));

// ─── Attendance log and corrections ─────────────────────────────────────────

router.get("/personnel/attendance", ...route(VIEW, async (req, res, scope) => {
  const { from, to } = range(req);
  const staffId = req.query.staffId ? Number(req.query.staffId) : undefined;
  const { staff, presence } = await loadPeriod(scope, from, to, req.query.locationId, staffId);
  const name = new Map(staff.map((s) => [s.id, s.name]));
  const editors = [...new Set(presence.map((p) => p.editedByClerkId).filter(Boolean))] as string[];
  const ed = editors.length ? await db.select({ id: usersTable.clerkUserId, f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(inArray(usersTable.clerkUserId, editors)) : [];
  const edName = new Map(ed.map((u) => [u.id, [u.f, u.l].filter(Boolean).join(" ") || u.e]));
  res.json(presence.filter((p) => { const d = toLocal(p.checkInAt).date; return d >= from && d <= to; }).reverse().map((p) => ({
    id: p.id, staffId: p.staffId, staffName: name.get(p.staffId), checkInAt: p.checkInAt, checkOutAt: p.checkOutAt, method: p.method, note: p.note,
    checkInPhoto: photoUrl(p.checkInPhoto), checkOutPhoto: photoUrl(p.checkOutPhoto), editedBy: p.editedByClerkId ? edName.get(p.editedByClerkId) ?? null : null,
    minutes: p.checkOutAt ? Math.round((p.checkOutAt.getTime() - p.checkInAt.getTime()) / 60_000) : null,
  })));
}));

function times(body: Record<string, unknown>) {
  const inAt = typeof body.checkInAt === "string" ? new Date(body.checkInAt) : null;
  const outAt = body.checkOutAt ? new Date(String(body.checkOutAt)) : null;
  if (!inAt || Number.isNaN(inAt.getTime()) || (outAt && Number.isNaN(outAt.getTime()))) throw new HttpError(400, "Неверное время");
  if (outAt && outAt <= inAt) throw new HttpError(400, "Уход должен быть позже прихода");
  if (outAt && outAt.getTime() - inAt.getTime() > 24 * 3600_000) throw new HttpError(400, "Смена не может быть длиннее суток");
  if (inAt.getTime() > Date.now() + 5 * 60_000 || (outAt && outAt.getTime() > Date.now() + 5 * 60_000)) throw new HttpError(400, "Время не может быть в будущем");
  return { inAt, outAt };
}
async function noOverlap(staffId: number, inAt: Date, outAt: Date | null, exceptId?: number) {
  const end = outAt ?? new Date(8.64e15);
  const [o] = await db.select({ id: attendanceTable.id }).from(attendanceTable).where(and(
    eq(attendanceTable.staffId, staffId), exceptId ? sql`${attendanceTable.id} <> ${exceptId}` : undefined,
    lt(attendanceTable.checkInAt, end), or(isNull(attendanceTable.checkOutAt), sql`${attendanceTable.checkOutAt} > ${inAt}`),
  ));
  if (o) throw new HttpError(409, "Пересекается с другой отметкой этого сотрудника");
}

router.post("/personnel/attendance", ...route(ADMIN, async (req, res, scope) => {
  const s = await staffInScope(scope, Number(req.body?.staffId));
  const { inAt, outAt } = times(req.body ?? {});
  const note = String(req.body?.note ?? "").trim();
  if (!note) throw new HttpError(400, "Укажите причину ручной отметки");
  await noOverlap(s.id, inAt, outAt);
  const [row] = await db.insert(attendanceTable).values({ staffId: s.id, checkInAt: inAt, checkOutAt: outAt, method: "manual", note, editedByClerkId: scope.userId }).returning({ id: attendanceTable.id });
  await logAudit({ action: "create", entityType: "attendance", entityId: row.id, clerkUserId: scope.userId, details: JSON.stringify({ staffId: s.id, checkInAt: inAt, checkOutAt: outAt, note }) });
  res.status(201).json(row);
}));

router.patch("/personnel/attendance/:id", ...route(ADMIN, async (req, res, scope) => {
  const [a] = await db.select().from(attendanceTable).where(eq(attendanceTable.id, Number(req.params.id)));
  if (!a) throw new HttpError(404, "Отметка не найдена");
  await staffInScope(scope, a.staffId);
  const { inAt, outAt } = times({ checkInAt: req.body?.checkInAt ?? a.checkInAt.toISOString(), checkOutAt: req.body?.checkOutAt === undefined ? a.checkOutAt?.toISOString() : req.body.checkOutAt });
  const note = String(req.body?.note ?? "").trim();
  if (!note) throw new HttpError(400, "Укажите причину исправления");
  await noOverlap(a.staffId, inAt, outAt, a.id);
  await db.update(attendanceTable).set({ checkInAt: inAt, checkOutAt: outAt, note, editedByClerkId: scope.userId }).where(eq(attendanceTable.id, a.id));
  await logAudit({ action: "update", entityType: "attendance", entityId: a.id, clerkUserId: scope.userId, details: JSON.stringify({ before: { checkInAt: a.checkInAt, checkOutAt: a.checkOutAt }, after: { checkInAt: inAt, checkOutAt: outAt }, note }) });
  res.json({ ok: true });
}));

router.delete("/personnel/attendance/:id", ...route(ADMIN, async (req, res, scope) => {
  const [a] = await db.select().from(attendanceTable).where(eq(attendanceTable.id, Number(req.params.id)));
  if (!a) throw new HttpError(404, "Отметка не найдена");
  await staffInScope(scope, a.staffId);
  await db.delete(attendanceTable).where(eq(attendanceTable.id, a.id));
  await logAudit({ action: "delete", entityType: "attendance", entityId: a.id, clerkUserId: scope.userId, details: JSON.stringify({ staffId: a.staffId, checkInAt: a.checkInAt, checkOutAt: a.checkOutAt }) });
  res.status(204).end();
}));

// ─── Timesheet ──────────────────────────────────────────────────────────────

router.get("/personnel/timesheet", ...route(VIEW, async (req, res, scope) => {
  const { from, to } = range(req);
  const { staff, plans, presence } = await loadPeriod(scope, from, to, req.query.locationId);
  const rates = new Map(staff.map((s) => [s.id, { hourlyRate: s.hourlyRate == null ? null : Number(s.hourlyRate), shiftRate: s.shiftRate == null ? null : Number(s.shiftRate) }]));
  const rows = summarize(staff.map((s) => s.id), plans as PlanRow[], presence as PresenceRow[], rates, { now: new Date() });
  const byId = new Map(staff.map((s) => [s.id, s]));
  res.json(rows.filter((r) => byId.get(r.staffId)!.isActive || r.plannedShifts || r.workedMin)
    .map(({ plans: _p, ...r }) => { const s = byId.get(r.staffId)!; return { ...r, name: s.name, position: s.position, department: s.department, ...rates.get(s.id) }; }));
}));

export default router;
