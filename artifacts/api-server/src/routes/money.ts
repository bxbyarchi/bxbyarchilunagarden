import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, moneyRequestsTable, moneyRequestEventsTable, staffTable, usersTable, counterpartiesTable, MONEY_KINDS, PAY_METHODS, EXPENSE_CATEGORIES, type EstimateLine, type ReportLine } from "@workspace/db";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope, type WarehouseScope } from "../lib/warehouseScope";
import { logger } from "../lib/logger";
import { logAudit } from "../lib/auditLogger";
import { notifyUsers, notifyStaff } from "../lib/telegramBot";
import { saveDataUrl, readStored, FileError } from "../lib/files";
import { isDate, addDays } from "../lib/timesheet";
import { toLocal } from "../lib/ai/helpers";
import { allowedActions, estimateTotal, spentTotal, settlementOf, isReportOverdue, APPROVERS, CASHIERS, OPEN_STATUSES, REPORT_DAYS, type Action, type Kind, type Status } from "../lib/moneyMath";

const router: IRouter = Router();
const DEPARTMENTS = ["kitchen", "bar", "pastry", "hall", "admin", "tech", "other"];
const KIND_RU: Record<string, string> = { advance: "под отчёт", payment: "оплата по счёту", reimbursement: "компенсация расходов" };
const FILE_RE = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|pdf)$/;

export type ReqLike = { body?: any; params?: any; query?: any };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export type Ctx = WarehouseScope & { myStaffId: number | null; seesAll: boolean };
function route(fn: (req: Request, res: Response, ctx: Ctx) => Promise<void>) {
  return [requireAuth(), async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const scope = await getWarehouseScope(req);
      if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
      const [me] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.userClerkId, scope.userId));
      await fn(req, res, { ...scope, myStaffId: me?.id ?? null, seesAll: APPROVERS.includes(scope.role) || CASHIERS.includes(scope.role) });
    } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      if (e instanceof FileError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
  }];
}
const visible = (c: Ctx): SQL | undefined => c.seesAll ? undefined
  : or(eq(moneyRequestsTable.requesterClerkId, c.userId), c.myStaffId ? eq(moneyRequestsTable.staffId, c.myStaffId) : sql`false`);
type Row = typeof moneyRequestsTable.$inferSelect;
const actor = (r: Row, c: Ctx) => ({ role: c.role, isRequester: r.requesterClerkId === c.userId, isHolder: !!c.myStaffId && r.staffId === c.myStaffId });
const money = (v: string | null) => (v == null ? null : Number(v));
const fmt = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} сом`;

async function load(id: number, c: Ctx) {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Запрос не найден");
  const [r] = await db.select().from(moneyRequestsTable).where(and(eq(moneyRequestsTable.id, id), visible(c)));
  if (!r) throw new HttpError(404, "Запрос не найден");
  return r;
}
async function event(id: number, author: string | null, kind: "comment" | "status" | "edit", text: string) {
  await db.insert(moneyRequestEventsTable).values({ requestId: id, authorClerkId: author, kind, text });
}
async function names(ids: (string | null)[]) {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  if (!list.length) return new Map<string, string>();
  const u = await db.select({ id: usersTable.clerkUserId, f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(inArray(usersTable.clerkUserId, list));
  return new Map(u.map((x) => [x.id, [x.f, x.l].filter(Boolean).join(" ") || x.e]));
}
async function holderAccount(staffId: number | null) {
  if (!staffId) return null;
  const [s] = await db.select({ u: staffTable.userClerkId }).from(staffTable).where(eq(staffTable.id, staffId));
  return s?.u ?? null;
}
const tell = (ids: (string | null)[], text: string, except?: string) => { void notifyUsers(ids.filter((x) => x && x !== except), text).catch((err) => logger.warn({ err }, "money notify failed")); };
const tellRoles = (roles: string[], text: string) => { void notifyStaff(text, roles).catch((err) => logger.warn({ err }, "money notify failed")); };

function files(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 20 || v.some((f) => typeof f !== "string" || !FILE_RE.test(f))) throw new HttpError(400, "Неверные вложения");
  return v as string[];
}
function estimate(v: unknown): EstimateLine[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 100) throw new HttpError(400, "Неверная смета");
  return v.map((l) => {
    const name = String(l?.name ?? "").trim(), qty = Number(l?.qty), price = Number(l?.price);
    if (!name || !(qty > 0) || !(price >= 0)) throw new HttpError(400, "В смете у каждой строки нужны название, количество и цена");
    return { name, qty, unit: String(l?.unit ?? "шт").trim() || "шт", price };
  });
}
function report(v: unknown): ReportLine[] {
  if (!Array.isArray(v) || !v.length || v.length > 100) throw new HttpError(400, "Добавьте хотя бы одну строку отчёта");
  return v.map((l) => {
    const name = String(l?.name ?? "").trim(), amount = Number(l?.amount);
    if (!name || !(amount > 0)) throw new HttpError(400, "В отчёте у каждой строки нужны название и сумма");
    const file = l?.file ? String(l.file) : null;
    if (file && !FILE_RE.test(file)) throw new HttpError(400, "Неверный файл чека");
    return { name, amount: Math.round(amount * 100) / 100, file };
  });
}

// ─── Files (invoices, receipts) ─────────────────────────────────────────────

router.post("/money-requests/files", ...route(async (req, res) => {
  const rel = await saveDataUrl("money", req.body?.data, { allowed: ["jpeg", "png", "pdf"], maxBytes: 4_000_000 });
  res.status(201).json({ file: rel, url: `/api/money-requests/file/${rel}` });
}));
router.get("/money-requests/file/:month/:file", ...route(async (req, res, c) => {
  const rel = `${req.params.month}/${req.params.file}`;
  // Only people who can see a request that references the file may open it.
  const [owner] = await db.select({ id: moneyRequestsTable.id }).from(moneyRequestsTable).where(and(visible(c),
    or(sql`${moneyRequestsTable.files} ? ${rel}`, sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${moneyRequestsTable.report}) x WHERE x->>'file' = ${rel})`))).limit(1);
  const f = owner ? await readStored("money", rel) : null;
  if (!f) throw new HttpError(404, "Файл не найден");
  res.setHeader("Content-Type", f.mime); res.setHeader("Cache-Control", "private, max-age=86400"); res.end(f.buf);
}));

// ─── List / summary ─────────────────────────────────────────────────────────

const cols = {
  id: moneyRequestsTable.id, kind: moneyRequestsTable.kind, status: moneyRequestsTable.status, title: moneyRequestsTable.title,
  amountRequested: moneyRequestsTable.amountRequested, amountApproved: moneyRequestsTable.amountApproved, amountIssued: moneyRequestsTable.amountIssued,
  amountSpent: moneyRequestsTable.amountSpent, settlement: moneyRequestsTable.settlement, neededBy: moneyRequestsTable.neededBy, reportDueAt: moneyRequestsTable.reportDueAt,
  department: moneyRequestsTable.department, requesterClerkId: moneyRequestsTable.requesterClerkId, staffId: moneyRequestsTable.staffId, staffName: staffTable.name,
  counterpartyName: counterpartiesTable.name, createdAt: moneyRequestsTable.createdAt, closedAt: moneyRequestsTable.closedAt,
  requesterName: sql<string>`coalesce(NULLIF(concat_ws(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), ${usersTable.email})`,
};

export async function listMoney(c: Ctx, req: ReqLike = {}) {
  const conds: (SQL | undefined)[] = [visible(c)];
  const view = String(req.query.view ?? "mine");
  if (view === "mine") conds.push(or(eq(moneyRequestsTable.requesterClerkId, c.userId), c.myStaffId ? eq(moneyRequestsTable.staffId, c.myStaffId) : sql`false`));
  else if (view === "approve") conds.push(eq(moneyRequestsTable.status, "pending"));
  else if (view === "accounting") conds.push(inArray(moneyRequestsTable.status, ["approved", "reported"]));
  else if (view === "advances") conds.push(eq(moneyRequestsTable.kind, "advance"), eq(moneyRequestsTable.status, "issued"));
  const status = String(req.query.status ?? "open");
  if (view === "mine" || view === "all") {
    if (status === "open") conds.push(inArray(moneyRequestsTable.status, OPEN_STATUSES));
    else if (status === "closed") conds.push(eq(moneyRequestsTable.status, "closed"));
    else if (status === "rejected") conds.push(inArray(moneyRequestsTable.status, ["rejected", "cancelled"]));
  }
  if (req.query.kind && MONEY_KINDS.includes(req.query.kind as never)) conds.push(eq(moneyRequestsTable.kind, String(req.query.kind)));
  const rows = await db.select(cols).from(moneyRequestsTable)
    .leftJoin(staffTable, eq(staffTable.id, moneyRequestsTable.staffId))
    .leftJoin(counterpartiesTable, eq(counterpartiesTable.id, moneyRequestsTable.counterpartyId))
    .leftJoin(usersTable, eq(usersTable.clerkUserId, moneyRequestsTable.requesterClerkId))
    .where(and(...conds.filter(Boolean) as SQL[])).orderBy(desc(moneyRequestsTable.createdAt)).limit(300);
  const today = toLocal(new Date()).date;
  return (rows.map((r) => ({ ...r, amountRequested: Number(r.amountRequested), amountApproved: money(r.amountApproved), amountIssued: money(r.amountIssued), amountSpent: money(r.amountSpent), settlement: money(r.settlement), reportOverdue: isReportOverdue(r, today) })));
}
router.get("/money-requests", ...route(async (req, res, c) => { res.status(200).json(await listMoney(c, req)); }));

export async function moneySummary(c: Ctx, req: ReqLike = {}) {
  const count = async (w: SQL | undefined) => (await db.select({ n: sql<number>`count(*)::int`, s: sql<string>`coalesce(sum(coalesce(${moneyRequestsTable.amountIssued}, ${moneyRequestsTable.amountApproved}, ${moneyRequestsTable.amountRequested})), 0)` }).from(moneyRequestsTable).where(and(visible(c), w)))[0];
  const mine = or(eq(moneyRequestsTable.requesterClerkId, c.userId), c.myStaffId ? eq(moneyRequestsTable.staffId, c.myStaffId) : sql`false`);
  const today = toLocal(new Date()).date;
  const [toApprove, toPay, toCheck, advances, myOpen, myReport] = await Promise.all([
    APPROVERS.includes(c.role) ? count(eq(moneyRequestsTable.status, "pending")) : null,
    CASHIERS.includes(c.role) ? count(eq(moneyRequestsTable.status, "approved")) : null,
    CASHIERS.includes(c.role) ? count(eq(moneyRequestsTable.status, "reported")) : null,
    c.seesAll ? count(and(eq(moneyRequestsTable.kind, "advance"), eq(moneyRequestsTable.status, "issued"))) : null,
    count(and(mine, inArray(moneyRequestsTable.status, OPEN_STATUSES))),
    c.myStaffId ? count(and(eq(moneyRequestsTable.staffId, c.myStaffId), eq(moneyRequestsTable.kind, "advance"), eq(moneyRequestsTable.status, "issued"))) : null,
  ]);
  const [overdue] = c.seesAll ? await db.select({ n: sql<number>`count(*)::int` }).from(moneyRequestsTable).where(and(eq(moneyRequestsTable.kind, "advance"), eq(moneyRequestsTable.status, "issued"), sql`${moneyRequestsTable.reportDueAt} < ${today}`)) : [null];
  const n = (x: { n: number; s: string } | null) => (x ? { count: x.n, sum: Number(x.s) } : null);
  return ({
    role: c.role, isApprover: APPROVERS.includes(c.role), isCashier: CASHIERS.includes(c.role), seesAll: c.seesAll, hasStaffCard: !!c.myStaffId,
    toApprove: n(toApprove), toPay: n(toPay), toCheck: n(toCheck), advances: n(advances), advancesOverdue: overdue?.n ?? null, myOpen: n(myOpen), myToReport: n(myReport),
  });
}
router.get("/money-requests/summary", ...route(async (req, res, c) => { res.status(200).json(await moneySummary(c, req)); }));

router.get("/money-requests/options", ...route(async (_req, res, c) => {
  const staff = await db.select({ id: staffTable.id, name: staffTable.name, position: staffTable.position, department: staffTable.department }).from(staffTable).where(eq(staffTable.isActive, true)).orderBy(staffTable.name);
  const cps = await db.select({ id: counterpartiesTable.id, name: counterpartiesTable.name, category: counterpartiesTable.category }).from(counterpartiesTable).where(eq(counterpartiesTable.isActive, true)).orderBy(counterpartiesTable.name);
  res.json({ staff, counterparties: cps, myStaffId: c.myStaffId });
}));

/** Who holds unreported advances right now. */
router.get("/money-requests/advances", ...route(async (_req, res, c) => {
  if (!c.seesAll) throw new HttpError(403, "Нет доступа");
  const today = toLocal(new Date()).date;
  const rows = await db.select({ staffId: moneyRequestsTable.staffId, name: staffTable.name, position: staffTable.position, amount: moneyRequestsTable.amountIssued, reportDueAt: moneyRequestsTable.reportDueAt, issuedAt: moneyRequestsTable.issuedAt })
    .from(moneyRequestsTable).leftJoin(staffTable, eq(staffTable.id, moneyRequestsTable.staffId))
    .where(and(eq(moneyRequestsTable.kind, "advance"), inArray(moneyRequestsTable.status, ["issued", "reported"])));
  const by = new Map<string, { staffId: number | null; name: string; position: string | null; total: number; count: number; overdue: number; oldest: Date | null }>();
  for (const r of rows) {
    const k = String(r.staffId);
    const e = by.get(k) ?? { staffId: r.staffId, name: r.name ?? "Без сотрудника", position: r.position, total: 0, count: 0, overdue: 0, oldest: null };
    e.total += Number(r.amount ?? 0); e.count++;
    if (r.reportDueAt && r.reportDueAt < today) e.overdue++;
    if (r.issuedAt && (!e.oldest || r.issuedAt < e.oldest)) e.oldest = r.issuedAt;
    by.set(k, e);
  }
  res.json([...by.values()].sort((a, b) => b.total - a.total));
}));

// ─── One request ────────────────────────────────────────────────────────────

export async function detail(id: number, c: Ctx) {
  const r = await load(id, c);
  const ev = await db.select().from(moneyRequestEventsTable).where(eq(moneyRequestEventsTable.requestId, id)).orderBy(asc(moneyRequestEventsTable.createdAt), asc(moneyRequestEventsTable.id));
  const nm = await names([r.requesterClerkId, r.approvedByClerkId, r.issuedByClerkId, r.closedByClerkId, ...ev.map((e) => e.authorClerkId)]);
  const [s] = r.staffId ? await db.select({ name: staffTable.name, position: staffTable.position }).from(staffTable).where(eq(staffTable.id, r.staffId)) : [];
  const [cp] = r.counterpartyId ? await db.select({ name: counterpartiesTable.name, phone: counterpartiesTable.phone }).from(counterpartiesTable).where(eq(counterpartiesTable.id, r.counterpartyId)) : [];
  const a = actor(r, c);
  const fileUrl = (f: string) => `/api/money-requests/file/${f}`;
  return {
    ...r, amountRequested: Number(r.amountRequested), amountApproved: money(r.amountApproved), amountIssued: money(r.amountIssued), amountSpent: money(r.amountSpent), settlement: money(r.settlement),
    files: r.files.map((f) => ({ file: f, url: fileUrl(f) })), report: r.report.map((l) => ({ ...l, url: l.file ? fileUrl(l.file) : null })),
    staffName: s?.name ?? null, staffPosition: s?.position ?? null, counterpartyName: cp?.name ?? null, counterpartyPhone: cp?.phone ?? null,
    requesterName: nm.get(r.requesterClerkId) ?? "—", approvedByName: r.approvedByClerkId ? nm.get(r.approvedByClerkId) ?? null : null,
    issuedByName: r.issuedByClerkId ? nm.get(r.issuedByClerkId) ?? null : null, closedByName: r.closedByClerkId ? nm.get(r.closedByClerkId) ?? null : null,
    reportOverdue: isReportOverdue(r, toLocal(new Date()).date),
    events: ev.map((e) => ({ id: e.id, kind: e.kind, text: e.text, createdAt: e.createdAt, authorName: e.authorClerkId ? nm.get(e.authorClerkId) ?? "—" : "Система" })),
    actions: allowedActions(r.kind as Kind, r.status as Status, a), canEdit: r.status === "pending" && a.isRequester,
  };
}
router.get("/money-requests/:id", ...route(async (req, res, c) => { res.json(await detail(Number(req.params.id), c)); }));

async function values(b: Record<string, unknown>, c: Ctx, partial: boolean) {
  const v: Partial<typeof moneyRequestsTable.$inferInsert> = {};
  if (!partial) {
    if (!MONEY_KINDS.includes(b.kind as never)) throw new HttpError(400, "Выберите тип запроса");
    v.kind = b.kind as string;
  }
  if (!partial || b.title !== undefined) { const t = String(b.title ?? "").trim(); if (!t) throw new HttpError(400, "Укажите, на что нужны деньги"); v.title = t.slice(0, 200); }
  if (b.purpose !== undefined) v.purpose = b.purpose ? String(b.purpose).trim() : null;
  if (b.department !== undefined) { if (b.department && !DEPARTMENTS.includes(String(b.department))) throw new HttpError(400, "Неизвестный отдел"); v.department = (b.department as string) || null; }
  if (b.expenseCategory !== undefined) { if (b.expenseCategory && !EXPENSE_CATEGORIES.includes(b.expenseCategory as never)) throw new HttpError(400, "Неизвестная статья расхода"); v.expenseCategory = (b.expenseCategory as string) || null; }
  if (b.neededBy !== undefined) { if (b.neededBy && !isDate(b.neededBy)) throw new HttpError(400, "Неверная дата"); v.neededBy = (b.neededBy as string) || null; }
  if (b.payMethod !== undefined) { if (b.payMethod && !PAY_METHODS.includes(b.payMethod as never)) throw new HttpError(400, "Неверный способ оплаты"); v.payMethod = (b.payMethod as string) || null; }
  if (b.files !== undefined) v.files = files(b.files);
  if (b.estimate !== undefined) v.estimate = estimate(b.estimate);
  if (b.staffId !== undefined) {
    const id = b.staffId ? Number(b.staffId) : null;
    if (id) { const [s] = await db.select({ a: staffTable.isActive }).from(staffTable).where(eq(staffTable.id, id)); if (!s?.a) throw new HttpError(400, "Сотрудник не найден"); }
    v.staffId = id;
  } else if (!partial) v.staffId = c.myStaffId;
  if (b.counterpartyId !== undefined) v.counterpartyId = b.counterpartyId ? Number(b.counterpartyId) : null;
  // The amount comes from the estimate when there is one, otherwise as entered.
  if (v.estimate?.length) v.amountRequested = String(estimateTotal(v.estimate));
  else if (v.kind === "reimbursement") { /* the amount is the sum of the receipts, below */ }
  else if (b.amount !== undefined || !partial) { const a = Number(b.amount); if (!(a > 0) || a > 100_000_000) throw new HttpError(400, "Укажите сумму или заполните смету"); v.amountRequested = String(Math.round(a * 100) / 100); }
  if (!partial && v.kind === "reimbursement") {
    v.report = report(b.report);
    v.amountSpent = String(spentTotal(v.report));
    v.amountRequested = v.amountSpent;
  }
  return v;
}

export async function createMoney(c: Ctx, req: ReqLike = {}) {
  const v = await values(req.body ?? {}, c, false);
  if (v.kind === "payment" && !v.counterpartyId && !v.purpose) throw new HttpError(400, "Укажите получателя платежа — контрагента или реквизиты в описании");
  if (v.kind !== "payment" && !v.staffId) throw new HttpError(400, "Выберите сотрудника, которому выдать деньги");
  const [r] = await db.insert(moneyRequestsTable).values({ ...v, kind: v.kind!, title: v.title!, amountRequested: v.amountRequested!, requesterClerkId: c.userId }).returning();
  await event(r.id, c.userId, "status", `Запрос создан: ${KIND_RU[r.kind]}, ${fmt(Number(r.amountRequested))}`);
  const who = (await names([c.userId])).get(c.userId);
  tellRoles(APPROVERS, `💰 Запрос денег №${r.id} (${KIND_RU[r.kind]}) на ${fmt(Number(r.amountRequested))}\n${r.title}\nОт: ${who}. Нужно согласовать.\nОткрыть: /m${r.id}`);
  return ({ id: r.id });
}
router.post("/money-requests", ...route(async (req, res, c) => { res.status(201).json(await createMoney(c, req)); }));

router.patch("/money-requests/:id", ...route(async (req, res, c) => {
  const r = await load(Number(req.params.id), c);
  if (r.status !== "pending" || r.requesterClerkId !== c.userId) throw new HttpError(403, "Изменить можно только свой запрос до согласования");
  const v = await values(req.body ?? {}, c, true);
  delete v.kind;
  if (r.kind === "reimbursement" && req.body?.report !== undefined) { v.report = report(req.body.report); v.amountSpent = String(spentTotal(v.report)); v.amountRequested = v.amountSpent; }
  await db.update(moneyRequestsTable).set(v).where(eq(moneyRequestsTable.id, r.id));
  await event(r.id, c.userId, "edit", v.amountRequested && v.amountRequested !== r.amountRequested ? `Запрос изменён, сумма ${fmt(Number(v.amountRequested))}` : "Запрос изменён");
  res.json(await detail(r.id, c));
}));

export async function moneyAction(c: Ctx, req: ReqLike = {}) {
  const r = await load(Number(req.params.id), c);
  const action = String(req.body?.action ?? "") as Action;
  const comment = String(req.body?.comment ?? "").trim();
  if (!allowedActions(r.kind as Kind, r.status as Status, actor(r, c)).includes(action)) throw new HttpError(403, "Это действие сейчас недоступно");
  const now = new Date();
  const holder = await holderAccount(r.staffId);
  const requested = Number(r.amountRequested);
  const amountArg = req.body?.amount == null || req.body.amount === "" ? null : Number(req.body.amount);
  if (amountArg != null && !(amountArg > 0)) throw new HttpError(400, "Неверная сумма");
  let set: Partial<typeof moneyRequestsTable.$inferInsert> = {};
  let text = "";

  switch (action) {
    case "approve": {
      const amt = amountArg ?? requested;
      set = { status: "approved", amountApproved: String(amt), approvedByClerkId: c.userId, approvedAt: now };
      text = amt !== requested ? `Согласовано на ${fmt(amt)} (запрошено ${fmt(requested)})` : `Согласовано: ${fmt(amt)}`;
      tell([r.requesterClerkId, holder], `✅ Запрос №${r.id} согласован: ${fmt(amt)}\n${r.title}\nОткрыть: /m${r.id}`, c.userId);
      tellRoles(CASHIERS, `💸 Запрос №${r.id} согласован — нужно ${r.kind === "advance" ? "выдать" : "оплатить"} ${fmt(amt)}\n${r.title}\nОткрыть: /m${r.id}`);
      break;
    }
    case "reject":
      if (!comment) throw new HttpError(400, "Укажите причину отказа");
      set = { status: "rejected", closedAt: now, closedByClerkId: c.userId }; text = "Отклонено";
      tell([r.requesterClerkId], `❌ Запрос №${r.id} отклонён: ${r.title}\n${comment}\nОткрыть: /m${r.id}`, c.userId);
      break;
    case "cancel":
      if (r.requesterClerkId !== c.userId && !comment) throw new HttpError(400, "Укажите причину отмены");
      set = { status: "cancelled", closedAt: now, closedByClerkId: c.userId }; text = "Отменено";
      tell([r.requesterClerkId], `✖️ Запрос №${r.id} отменён: ${r.title}\nОткрыть: /m${r.id}`, c.userId);
      break;
    case "issue":
    case "pay": {
      const amt = amountArg ?? Number(r.amountApproved ?? requested);
      const method = String(req.body?.payMethod ?? r.payMethod ?? "cash");
      if (!PAY_METHODS.includes(method as never)) throw new HttpError(400, "Неверный способ оплаты");
      const docs = req.body?.files !== undefined ? [...r.files, ...files(req.body.files)] : r.files;
      const methodRu = ({ cash: "наличными", transfer: "переводом", card: "картой" } as Record<string, string>)[method];
      if (action === "issue") {
        set = { status: "issued", amountIssued: String(amt), payMethod: method, issuedByClerkId: c.userId, issuedAt: now, reportDueAt: addDays(toLocal(now).date, REPORT_DAYS), files: docs };
        text = `Выдано под отчёт ${fmt(amt)} ${methodRu}`;
        tell([holder, r.requesterClerkId], `💵 Вам выдано под отчёт ${fmt(amt)} (запрос №${r.id}: ${r.title}).\nОтчитайтесь чеками в течение ${REPORT_DAYS} дней.\nОткрыть: /m${r.id}`, c.userId);
      } else {
        set = { status: "closed", amountIssued: String(amt), payMethod: method, issuedByClerkId: c.userId, issuedAt: now, closedByClerkId: c.userId, closedAt: now, files: docs };
        text = r.kind === "payment" ? `Оплачено ${fmt(amt)} ${methodRu}` : `Компенсация выплачена: ${fmt(amt)} ${methodRu}`;
        tell([r.requesterClerkId, holder], `✔️ Запрос №${r.id} оплачен: ${fmt(amt)}\n${r.title}\nОткрыть: /m${r.id}`, c.userId);
      }
      break;
    }
    case "report": {
      const lines = report(req.body?.report);
      const spent = spentTotal(lines);
      set = { status: "reported", report: lines, amountSpent: String(spent), reportedAt: now };
      const diff = settlementOf(Number(r.amountIssued ?? 0), spent);
      text = `Отчёт сдан: потрачено ${fmt(spent)} из ${fmt(Number(r.amountIssued ?? 0))}${diff > 0 ? `, вернуть ${fmt(diff)}` : diff < 0 ? `, перерасход ${fmt(-diff)}` : ""}`;
      tellRoles(CASHIERS, `🧾 Отчёт по запросу №${r.id} сдан — проверьте чеки\n${r.title}: потрачено ${fmt(spent)}\nОткрыть: /m${r.id}`);
      break;
    }
    case "return_report":
      if (!comment) throw new HttpError(400, "Напишите, что не так с отчётом");
      set = { status: "issued", reportedAt: null }; text = "Отчёт возвращён на доработку";
      tell([holder, r.requesterClerkId], `↩️ Отчёт по запросу №${r.id} вернули: ${comment}\nОткрыть: /m${r.id}`, c.userId);
      break;
    case "close": {
      const diff = settlementOf(Number(r.amountIssued ?? 0), Number(r.amountSpent ?? 0));
      set = { status: "closed", settlement: String(diff), closedByClerkId: c.userId, closedAt: now };
      text = diff > 0 ? `Отчёт принят, остаток ${fmt(diff)} возвращён в кассу` : diff < 0 ? `Отчёт принят, перерасход ${fmt(-diff)} выплачен сотруднику` : "Отчёт принят, расчёт закрыт";
      tell([holder, r.requesterClerkId], `✔️ Отчёт по запросу №${r.id} принят. ${text}.\nОткрыть: /m${r.id}`, c.userId);
      break;
    }
  }
  await db.update(moneyRequestsTable).set(set).where(eq(moneyRequestsTable.id, r.id));
  await event(r.id, c.userId, "status", comment ? `${text} — ${comment}` : text);
  await logAudit({ action, entityType: "money_request", entityId: r.id, clerkUserId: c.userId, details: text });
  return (await detail(r.id, c));
}
router.post("/money-requests/:id/action", ...route(async (req, res, c) => { res.status(200).json(await moneyAction(c, req)); }));

export async function commentMoney(c: Ctx, req: ReqLike = {}) {
  const r = await load(Number(req.params.id), c);
  const text = String(req.body?.text ?? "").trim();
  if (!text || text.length > 2000) throw new HttpError(400, "Пустой или слишком длинный комментарий");
  await event(r.id, c.userId, "comment", text);
  const who = (await names([c.userId])).get(c.userId);
  tell([r.requesterClerkId, await holderAccount(r.staffId), r.approvedByClerkId, r.issuedByClerkId], `💬 ${who} — запрос №${r.id}:\n${text}\nОткрыть: /m${r.id}`, c.userId);
  return (await detail(r.id, c));
}
router.post("/money-requests/:id/comments", ...route(async (req, res, c) => { res.status(200).json(await commentMoney(c, req)); }));

/** Managers and accounting may re-file a request under another P&L line at any time. */
router.post("/money-requests/:id/category", ...route(async (req, res, c) => {
  if (!APPROVERS.includes(c.role) && !CASHIERS.includes(c.role)) throw new HttpError(403, "Нет доступа");
  const r = await load(Number(req.params.id), c);
  const cat = String(req.body?.expenseCategory ?? "");
  if (!EXPENSE_CATEGORIES.includes(cat as never)) throw new HttpError(400, "Неизвестная статья расхода");
  await db.update(moneyRequestsTable).set({ expenseCategory: cat }).where(eq(moneyRequestsTable.id, r.id));
  await event(r.id, c.userId, "edit", "Изменена статья расхода");
  res.json(await detail(r.id, c));
}));

export default router;
