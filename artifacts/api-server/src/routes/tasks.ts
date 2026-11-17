import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, tasksTable, taskEventsTable, staffTable, usersTable, TASK_PRIORITIES, TASK_REPEATS, type ChecklistItem } from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope, type WarehouseScope } from "../lib/warehouseScope";
import { logger } from "../lib/logger";
import { notifyUsers } from "../lib/telegramBot";
import { canTransition, isOverdue, nextDue, efficiency, OPEN, type TaskStatus, type Repeat } from "../lib/taskMath";
import { isDate } from "../lib/timesheet";
import { localDateTime } from "../lib/ai/helpers";

const router: IRouter = Router();
// Managers see and manage every task; everybody else sees what they set or got.
export const TASK_ADMIN = ["super_admin", "warehouse_chief", "location_admin", "manager"];
const DEPARTMENTS = ["kitchen", "bar", "pastry", "hall", "admin", "tech", "other"];
const STATUS_RU: Record<string, string> = { new: "Новая", in_progress: "В работе", review: "На проверке", done: "Выполнена", cancelled: "Отменена" };

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
type Ctx = WarehouseScope & { isAdmin: boolean; myStaffId: number | null };
function route(fn: (req: Request, res: Response, ctx: Ctx) => Promise<void>) {
  return [requireAuth(), async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const scope = await getWarehouseScope(req);
      if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
      const [me] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.userClerkId, scope.userId));
      await fn(req, res, { ...scope, isAdmin: TASK_ADMIN.includes(scope.role), myStaffId: me?.id ?? null });
    } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  }];
}

const visible = (c: Ctx): SQL | undefined => c.isAdmin ? undefined
  : or(eq(tasksTable.creatorClerkId, c.userId), c.myStaffId ? eq(tasksTable.assigneeStaffId, c.myStaffId) : sql`false`);
const who = (t: typeof tasksTable.$inferSelect, c: Ctx) => ({ isAdmin: c.isAdmin, isCreator: t.creatorClerkId === c.userId, isAssignee: !!c.myStaffId && t.assigneeStaffId === c.myStaffId });

async function load(id: number, c: Ctx) {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Задача не найдена");
  const [t] = await db.select().from(tasksTable).where(and(eq(tasksTable.id, id), visible(c)));
  if (!t) throw new HttpError(404, "Задача не найдена");
  return t;
}
async function event(taskId: number, author: string | null, kind: "comment" | "status" | "edit", text: string) {
  await db.insert(taskEventsTable).values({ taskId, authorClerkId: author, kind, text });
}
async function userName(clerkId: string | null) {
  if (!clerkId) return "Система";
  const [u] = await db.select({ f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(eq(usersTable.clerkUserId, clerkId));
  return u ? [u.f, u.l].filter(Boolean).join(" ") || u.e : "—";
}
async function assigneeAccount(staffId: number | null) {
  if (!staffId) return null;
  const [s] = await db.select({ u: staffTable.userClerkId }).from(staffTable).where(eq(staffTable.id, staffId));
  return s?.u ?? null;
}
const fmtDue = (d: Date | null) => (d ? d.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "без срока");
function notify(ids: (string | null)[], text: string, except?: string) {
  void notifyUsers(ids.filter((x) => x && x !== except), text).catch((err) => logger.warn({ err }, "task notify failed"));
}

function parseBody(b: Record<string, unknown>, partial: boolean) {
  const v: Partial<typeof tasksTable.$inferInsert> = {};
  if (!partial || b.title !== undefined) { const t = String(b.title ?? "").trim(); if (!t) throw new HttpError(400, "Укажите, что нужно сделать"); if (t.length > 200) throw new HttpError(400, "Слишком длинное название"); v.title = t; }
  if (b.description !== undefined) v.description = b.description ? String(b.description).trim() : null;
  if (b.priority !== undefined) { if (!TASK_PRIORITIES.includes(b.priority as never)) throw new HttpError(400, "Неверный приоритет"); v.priority = b.priority as string; }
  if (b.department !== undefined) { if (b.department && !DEPARTMENTS.includes(String(b.department))) throw new HttpError(400, "Неизвестный отдел"); v.department = (b.department as string) || null; }
  if (b.zone !== undefined) v.zone = b.zone ? String(b.zone).trim() : null;
  if (b.dueAt !== undefined) {
    if (b.dueAt === null || b.dueAt === "") v.dueAt = null;
    else { const d = new Date(String(b.dueAt)); if (Number.isNaN(d.getTime())) throw new HttpError(400, "Неверный срок"); v.dueAt = d; }
  }
  if (b.needsReview !== undefined) v.needsReview = !!b.needsReview;
  if (b.repeat !== undefined) { if (b.repeat && !TASK_REPEATS.includes(b.repeat as never)) throw new HttpError(400, "Неверный повтор"); v.repeat = (b.repeat as string) || null; }
  if (b.checklist !== undefined) {
    if (!Array.isArray(b.checklist) || b.checklist.length > 50) throw new HttpError(400, "Неверный чек-лист");
    v.checklist = (b.checklist as ChecklistItem[]).map((i) => ({ text: String(i?.text ?? "").trim(), done: !!i?.done })).filter((i) => i.text);
  }
  if (b.assigneeStaffId !== undefined) v.assigneeStaffId = b.assigneeStaffId ? Number(b.assigneeStaffId) : null;
  if (v.repeat && v.dueAt === null) throw new HttpError(400, "Для повторяющейся задачи нужен срок");
  return v;
}
async function checkAssignee(id: number | null | undefined) {
  if (!id) return;
  const [s] = await db.select({ isActive: staffTable.isActive }).from(staffTable).where(eq(staffTable.id, id));
  if (!s?.isActive) throw new HttpError(400, "Исполнитель не найден или уволен");
}

// ─── List ───────────────────────────────────────────────────────────────────

const listCols = {
  id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, priority: tasksTable.priority, dueAt: tasksTable.dueAt,
  department: tasksTable.department, zone: tasksTable.zone, repeat: tasksTable.repeat, needsReview: tasksTable.needsReview,
  assigneeStaffId: tasksTable.assigneeStaffId, assigneeName: staffTable.name, creatorClerkId: tasksTable.creatorClerkId,
  creatorName: sql<string>`coalesce(NULLIF(concat_ws(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), ${usersTable.email})`,
  checklist: tasksTable.checklist, completedAt: tasksTable.completedAt, submittedAt: tasksTable.submittedAt, createdAt: tasksTable.createdAt, updatedAt: tasksTable.updatedAt,
  comments: sql<number>`(SELECT count(*)::int FROM ${taskEventsTable} e WHERE e.task_id = ${tasksTable.id} AND e.kind = 'comment')`,
};

router.get("/tasks", ...route(async (req, res, c) => {
  const conds: (SQL | undefined)[] = [visible(c)];
  const view = String(req.query.view ?? "mine");
  if (view === "mine") conds.push(c.myStaffId ? eq(tasksTable.assigneeStaffId, c.myStaffId) : sql`false`);
  else if (view === "created") conds.push(eq(tasksTable.creatorClerkId, c.userId));
  else if (view === "review") conds.push(eq(tasksTable.status, "review"), c.isAdmin ? undefined : eq(tasksTable.creatorClerkId, c.userId));
  const status = String(req.query.status ?? "open");
  if (status === "open") conds.push(inArray(tasksTable.status, OPEN));
  else if (status === "overdue") conds.push(inArray(tasksTable.status, OPEN), lt(tasksTable.dueAt, new Date()));
  else if (status === "done") conds.push(eq(tasksTable.status, "done"));
  else if (status === "cancelled") conds.push(eq(tasksTable.status, "cancelled"));
  if (req.query.assigneeStaffId) conds.push(req.query.assigneeStaffId === "none" ? isNull(tasksTable.assigneeStaffId) : eq(tasksTable.assigneeStaffId, Number(req.query.assigneeStaffId)));
  if (req.query.department) conds.push(eq(tasksTable.department, String(req.query.department)));
  if (req.query.q) conds.push(ilike(tasksTable.title, `%${String(req.query.q).replace(/[%_]/g, "")}%`));
  const done = status === "done" || status === "cancelled";
  const rows = await db.select(listCols).from(tasksTable)
    .leftJoin(staffTable, eq(staffTable.id, tasksTable.assigneeStaffId))
    .leftJoin(usersTable, eq(usersTable.clerkUserId, tasksTable.creatorClerkId))
    .where(and(...conds.filter(Boolean) as SQL[]))
    .orderBy(...(done ? [desc(tasksTable.completedAt), desc(tasksTable.updatedAt)] : [sql`${tasksTable.dueAt} IS NULL`, asc(tasksTable.dueAt), desc(tasksTable.createdAt)]))
    .limit(done ? 200 : 500);
  const now = new Date();
  res.json(rows.map((r) => ({ ...r, overdue: isOverdue(r, now) })));
}));

router.get("/tasks/summary", ...route(async (_req, res, c) => {
  const now = new Date();
  const mine = c.myStaffId ? await db.select({ status: tasksTable.status, dueAt: tasksTable.dueAt }).from(tasksTable)
    .where(and(eq(tasksTable.assigneeStaffId, c.myStaffId), inArray(tasksTable.status, OPEN))) : [];
  const [rev] = await db.select({ n: sql<number>`count(*)::int` }).from(tasksTable)
    .where(and(eq(tasksTable.status, "review"), c.isAdmin ? undefined : eq(tasksTable.creatorClerkId, c.userId)));
  res.json({ hasStaffCard: !!c.myStaffId, myOpen: mine.filter((t) => t.status !== "review").length, myOverdue: mine.filter((t) => isOverdue(t, now)).length, toReview: rev.n, isAdmin: c.isAdmin });
}));

router.get("/tasks/assignees", ...route(async (_req, res) => {
  res.json(await db.select({ id: staffTable.id, name: staffTable.name, position: staffTable.position, department: staffTable.department, hasAccount: sql<boolean>`${staffTable.userClerkId} IS NOT NULL` })
    .from(staffTable).where(eq(staffTable.isActive, true)).orderBy(staffTable.name));
}));

// ─── Efficiency ─────────────────────────────────────────────────────────────

router.get("/tasks/efficiency", ...route(async (req, res, c) => {
  if (!c.isAdmin) throw new HttpError(403, "Нет доступа");
  const from = req.query.from, to = req.query.to;
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, "Укажите период");
  const start = localDateTime(from, "00:00")!, end = new Date(localDateTime(to, "00:00")!.getTime() + 86400_000);
  // A task belongs to the period of its deadline; tasks without one — to the period they were set in.
  const rows = await db.select().from(tasksTable).where(and(sql`${tasksTable.assigneeStaffId} IS NOT NULL`, or(
    and(gte(tasksTable.dueAt, start), lt(tasksTable.dueAt, end)),
    and(isNull(tasksTable.dueAt), gte(tasksTable.createdAt, start), lt(tasksTable.createdAt, end)),
  )));
  const eff = efficiency(rows, new Date());
  const staff = eff.length ? await db.select({ id: staffTable.id, name: staffTable.name, position: staffTable.position, department: staffTable.department }).from(staffTable).where(inArray(staffTable.id, eff.map((e) => e.staffId))) : [];
  const byId = new Map(staff.map((s) => [s.id, s]));
  res.json(eff.map((e) => ({ ...e, ...byId.get(e.staffId) })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.total - a.total));
}));

// ─── One task ───────────────────────────────────────────────────────────────

async function detail(id: number, c: Ctx) {
  const t = await load(id, c);
  const ev = await db.select().from(taskEventsTable).where(eq(taskEventsTable.taskId, id)).orderBy(asc(taskEventsTable.createdAt), asc(taskEventsTable.id));
  const ids = [...new Set([t.creatorClerkId, ...ev.map((e) => e.authorClerkId)].filter(Boolean))] as string[];
  const users = await db.select({ id: usersTable.clerkUserId, f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(inArray(usersTable.clerkUserId, ids));
  const nm = new Map(users.map((u) => [u.id, [u.f, u.l].filter(Boolean).join(" ") || u.e]));
  const [a] = t.assigneeStaffId ? await db.select({ name: staffTable.name, position: staffTable.position }).from(staffTable).where(eq(staffTable.id, t.assigneeStaffId)) : [];
  const w = who(t, c);
  const allowed = (["new", "in_progress", "review", "done", "cancelled"] as TaskStatus[]).filter((s) => canTransition(t.status as TaskStatus, s, w, t.needsReview));
  return {
    ...t, overdue: isOverdue(t, new Date()), assigneeName: a?.name ?? null, assigneePosition: a?.position ?? null, creatorName: nm.get(t.creatorClerkId) ?? "—",
    events: ev.map((e) => ({ id: e.id, kind: e.kind, text: e.text, createdAt: e.createdAt, authorName: e.authorClerkId ? nm.get(e.authorClerkId) ?? "—" : "Система" })),
    can: { edit: w.isAdmin || w.isCreator, checklist: w.isAdmin || w.isCreator || w.isAssignee, transitions: allowed },
    me: w,
  };
}

router.get("/tasks/:id", ...route(async (req, res, c) => { res.json(await detail(Number(req.params.id), c)); }));

router.post("/tasks", ...route(async (req, res, c) => {
  const v = parseBody(req.body ?? {}, false);
  await checkAssignee(v.assigneeStaffId);
  if (v.repeat && !v.dueAt) throw new HttpError(400, "Для повторяющейся задачи нужен срок");
  const [t] = await db.insert(tasksTable).values({ ...v, title: v.title!, creatorClerkId: c.userId }).returning();
  await event(t.id, c.userId, "status", "Задача поставлена");
  const acc = await assigneeAccount(t.assigneeStaffId);
  notify([acc], `📋 Новая задача от ${await userName(c.userId)}:\n${t.title}\nСрок: ${fmtDue(t.dueAt)}${t.priority === "urgent" ? "\n❗ Срочно" : ""}`, c.userId);
  res.status(201).json({ id: t.id });
}));

router.patch("/tasks/:id", ...route(async (req, res, c) => {
  const t = await load(Number(req.params.id), c);
  const w = who(t, c);
  const body = req.body ?? {};
  // The assignee may only tick checklist items, not rewrite them.
  if (!w.isAdmin && !w.isCreator) {
    if (!w.isAssignee || Object.keys(body).some((k) => k !== "checklist")) throw new HttpError(403, "Менять задачу может только постановщик");
    const next = Array.isArray(body.checklist) ? body.checklist as ChecklistItem[] : [];
    if (next.length !== t.checklist.length || next.some((i, k) => String(i?.text ?? "").trim() !== t.checklist[k].text)) throw new HttpError(403, "Исполнитель может только отмечать пункты");
  }
  const v = parseBody(body, true);
  if (v.assigneeStaffId !== undefined && v.assigneeStaffId !== t.assigneeStaffId) await checkAssignee(v.assigneeStaffId);
  if ((v.repeat ?? t.repeat) && (v.dueAt === null || (v.dueAt === undefined && !t.dueAt))) throw new HttpError(400, "Для повторяющейся задачи нужен срок");
  await db.update(tasksTable).set({ ...v, ...(v.dueAt !== undefined ? { overdueNotifiedAt: null } : {}) }).where(eq(tasksTable.id, t.id));
  const changes: string[] = [];
  if (v.title !== undefined && v.title !== t.title) changes.push("название");
  if (v.description !== undefined && v.description !== t.description) changes.push("описание");
  if (v.dueAt !== undefined && (v.dueAt?.getTime() ?? null) !== (t.dueAt?.getTime() ?? null)) changes.push(`срок → ${fmtDue(v.dueAt)}`);
  if (v.priority !== undefined && v.priority !== t.priority) changes.push("приоритет");
  if (v.assigneeStaffId !== undefined && v.assigneeStaffId !== t.assigneeStaffId) {
    const [s] = v.assigneeStaffId ? await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, v.assigneeStaffId)) : [];
    changes.push(`исполнитель → ${s?.name ?? "не назначен"}`);
    notify([await assigneeAccount(v.assigneeStaffId)], `📋 Вам передали задачу:\n${v.title ?? t.title}\nСрок: ${fmtDue(v.dueAt !== undefined ? v.dueAt : t.dueAt)}`, c.userId);
  }
  if (v.checklist) {
    const doneNow = v.checklist.filter((i) => i.done).length, doneBefore = t.checklist.filter((i) => i.done).length;
    if (v.checklist.length !== t.checklist.length || v.checklist.some((i, k) => i.text !== t.checklist[k]?.text)) changes.push("чек-лист");
    else if (doneNow !== doneBefore) changes.push(`чек-лист ${doneNow}/${v.checklist.length}`);
  }
  for (const k of ["zone", "department", "repeat", "needsReview"] as const) if (v[k] !== undefined && v[k] !== t[k]) changes.push(({ zone: "зона", department: "отдел", repeat: "повтор", needsReview: "проверка" })[k]);
  if (changes.length) await event(t.id, c.userId, "edit", `Изменено: ${changes.join(", ")}`);
  res.json(await detail(t.id, c));
}));

router.post("/tasks/:id/status", ...route(async (req, res, c) => {
  const t = await load(Number(req.params.id), c);
  const to = String(req.body?.to ?? "") as TaskStatus;
  const comment = String(req.body?.comment ?? "").trim();
  const from = t.status as TaskStatus;
  if (!canTransition(from, to, who(t, c), t.needsReview)) throw new HttpError(403, `Нельзя перевести задачу из «${STATUS_RU[from]}» в «${STATUS_RU[to] ?? to}»`);
  const w = who(t, c);
  // A boss sending work back must say why; an assignee taking their own task back need not.
  const bossReturn = from === "review" && to === "in_progress" && (w.isAdmin || w.isCreator) && !w.isAssignee;
  if (bossReturn && !comment) throw new HttpError(400, "Напишите, что нужно исправить");
  if (to === "cancelled" && !comment) throw new HttpError(400, "Укажите причину отмены");
  const now = new Date();
  const set: Partial<typeof tasksTable.$inferInsert> = { status: to };
  if (to === "in_progress" && !t.startedAt) set.startedAt = now;
  if (to === "review") set.submittedAt = now;
  if (to === "done") { set.completedAt = now; if (!t.submittedAt) set.submittedAt = now; }
  if (to === "in_progress" && from === "review") { set.submittedAt = null; if (bossReturn) set.returnedCount = t.returnedCount + 1; }
  if ((from === "done" || from === "cancelled") && OPEN.includes(to)) { set.completedAt = null; set.submittedAt = to === "review" ? now : null; }
  await db.update(tasksTable).set(set).where(eq(tasksTable.id, t.id));
  const label = from === "review" && to === "done" ? "Принято" : from === "review" && to === "in_progress" ? "Возвращено на доработку" : `Статус: ${STATUS_RU[to]}`;
  await event(t.id, c.userId, "status", comment ? `${label} — ${comment}` : label);

  const acc = await assigneeAccount(t.assigneeStaffId);
  const actor = await userName(c.userId);
  if (to === "review") notify([t.creatorClerkId], `✅ Задача выполнена, проверьте:\n${t.title}\nИсполнитель: ${actor}`, c.userId);
  else if (to === "done") notify([t.creatorClerkId, acc], `✔️ Задача закрыта: ${t.title}`, c.userId);
  else if (from === "review" && to === "in_progress") notify([acc], `↩️ Задачу вернули на доработку:\n${t.title}${comment ? `\n${comment}` : ""}`, c.userId);
  else if (to === "cancelled") notify([acc], `✖️ Задача отменена: ${t.title}${comment ? `\n${comment}` : ""}`, c.userId);

  // Recurring: closing one copy sets the next one up.
  if (to === "done" && t.repeat && t.dueAt) {
    const [exists] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.parentTaskId, t.parentTaskId ?? t.id), inArray(tasksTable.status, OPEN), ne(tasksTable.id, t.id)));
    if (!exists) {
      const due = nextDue(t.dueAt, t.repeat as Repeat, now);
      const [n] = await db.insert(tasksTable).values({
        title: t.title, description: t.description, priority: t.priority, creatorClerkId: t.creatorClerkId, assigneeStaffId: t.assigneeStaffId, department: t.department,
        zone: t.zone, dueAt: due, needsReview: t.needsReview, checklist: t.checklist.map((i) => ({ ...i, done: false })), repeat: t.repeat, parentTaskId: t.parentTaskId ?? t.id,
      }).returning({ id: tasksTable.id });
      await event(n.id, null, "status", `Повторяющаяся задача, создана после выполнения №${t.id}`);
    }
  }
  res.json(await detail(t.id, c));
}));

router.post("/tasks/:id/comments", ...route(async (req, res, c) => {
  const t = await load(Number(req.params.id), c);
  const text = String(req.body?.text ?? "").trim();
  if (!text) throw new HttpError(400, "Пустой комментарий");
  if (text.length > 2000) throw new HttpError(400, "Слишком длинный комментарий");
  await event(t.id, c.userId, "comment", text);
  notify([t.creatorClerkId, await assigneeAccount(t.assigneeStaffId)], `💬 ${await userName(c.userId)} — «${t.title}»:\n${text}`, c.userId);
  res.json(await detail(t.id, c));
}));

// ─── Overdue reminders (Telegram) ───────────────────────────────────────────

export async function remindOverdue(now = new Date()): Promise<number> {
  const rows = await db.select().from(tasksTable).where(and(inArray(tasksTable.status, ["new", "in_progress"]), lt(tasksTable.dueAt, now), isNull(tasksTable.overdueNotifiedAt)));
  for (const t of rows) {
    await db.update(tasksTable).set({ overdueNotifiedAt: now }).where(eq(tasksTable.id, t.id));
    notify([await assigneeAccount(t.assigneeStaffId), t.creatorClerkId], `⏰ Просрочена задача: ${t.title}\nСрок был: ${fmtDue(t.dueAt)}`);
  }
  return rows.length;
}
let timer: NodeJS.Timeout | null = null;
export function startTaskReminders() {
  if (timer) return;
  timer = setInterval(() => { remindOverdue().catch((err) => logger.error({ err }, "remindOverdue failed")); }, 10 * 60_000);
  timer.unref();
}

export default router;
