import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, kbArticlesTable, kbReadsTable, trainingCoursesTable, trainingAssignmentsTable, staffTable, usersTable, KB_CATEGORIES } from "@workspace/db";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { logAudit } from "../lib/auditLogger";
import { logger } from "../lib/logger";
import { notifyUsers } from "../lib/telegramBot";
import { validateQuiz, grade, publicQuiz, type Question } from "../lib/trainingMath";
import { STARTER_ARTICLES, STARTER_COURSE } from "../lib/knowledge/starter";
import { isDate } from "../lib/timesheet";

const router: IRouter = Router();
export const KB_EDITORS = ["super_admin", "warehouse_chief", "location_admin", "manager"];
const DEPARTMENTS = ["kitchen", "bar", "pastry", "hall", "admin", "tech", "other"];

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
type Me = { clerkId: string; role: string; editor: boolean; staffId: number | null; name: string };
function route(fn: (req: Request, res: Response, me: Me) => Promise<void>) {
  return [requireAuth(), async (req: Request, res: Response) => {
    try {
      const u = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, req.auth!.userId!) });
      if (!u) { res.status(401).json({ error: "Unauthorized" }); return; }
      const [s] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.userClerkId, u.clerkUserId));
      await fn(req, res, { clerkId: u.clerkUserId, role: u.role, editor: KB_EDITORS.includes(u.role), staffId: s?.id ?? null, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email });
    } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      if (e instanceof Error && /^(Вопрос|Неверный тест|Ответьте)/.test(e.message)) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
  }];
}
const editorOnly = (me: Me) => { if (!me.editor) throw new HttpError(403, "Редактировать могут управляющие"); };
const idOf = (req: Request) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Не найдено"); return id; };
const excerpt = (body: string) => body.replace(/[#*`|>-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);

// ─── Articles ───────────────────────────────────────────────────────────────

router.get("/kb/articles", ...route(async (req, res, me) => {
  const conds: (SQL | undefined)[] = [me.editor ? undefined : eq(kbArticlesTable.status, "published")];
  if (req.query.category) conds.push(eq(kbArticlesTable.category, String(req.query.category)));
  const q = String(req.query.search ?? "").trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    conds.push(or(ilike(kbArticlesTable.title, like), ilike(kbArticlesTable.body, like), sql`${q} = ANY(${kbArticlesTable.tags})`,
      sql`to_tsvector('russian', ${kbArticlesTable.title} || ' ' || ${kbArticlesTable.body}) @@ plainto_tsquery('russian', ${q})`));
  }
  const rows = await db.select({
    id: kbArticlesTable.id, title: kbArticlesTable.title, body: kbArticlesTable.body, category: kbArticlesTable.category, tags: kbArticlesTable.tags, status: kbArticlesTable.status,
    pinned: kbArticlesTable.pinned, version: kbArticlesTable.version, updatedAt: kbArticlesTable.updatedAt, readVersion: kbReadsTable.version,
  }).from(kbArticlesTable)
    .leftJoin(kbReadsTable, and(eq(kbReadsTable.articleId, kbArticlesTable.id), eq(kbReadsTable.userClerkId, me.clerkId)))
    .where(and(...conds.filter(Boolean) as SQL[]))
    .orderBy(desc(kbArticlesTable.pinned), asc(kbArticlesTable.category), asc(kbArticlesTable.title)).limit(300);
  const full = req.query.full === "1";
  res.json(rows.map(({ body, readVersion, ...r }) => ({ ...r, ...(full ? { body } : { excerpt: excerpt(body) }), readByMe: readVersion === r.version, updatedSinceRead: readVersion != null && readVersion !== r.version })));
}));

router.get("/kb/articles/:id", ...route(async (req, res, me) => {
  const [a] = await db.select().from(kbArticlesTable).where(and(eq(kbArticlesTable.id, idOf(req)), me.editor ? undefined : eq(kbArticlesTable.status, "published")));
  if (!a) throw new HttpError(404, "Статья не найдена");
  const [r] = await db.select().from(kbReadsTable).where(and(eq(kbReadsTable.articleId, a.id), eq(kbReadsTable.userClerkId, me.clerkId)));
  let readers = null;
  if (me.editor) {
    const users = await db.select({ id: usersTable.clerkUserId, f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(eq(usersTable.isActive, true));
    const reads = await db.select().from(kbReadsTable).where(eq(kbReadsTable.articleId, a.id));
    const by = new Map(reads.map((x) => [x.userClerkId, x]));
    readers = users.map((u) => ({ name: [u.f, u.l].filter(Boolean).join(" ") || u.e, readAt: by.get(u.id)?.version === a.version ? by.get(u.id)!.readAt : null, oldVersion: !!by.get(u.id) && by.get(u.id)!.version !== a.version }))
      .sort((x, y) => Number(!!y.readAt) - Number(!!x.readAt) || x.name.localeCompare(y.name));
  }
  const [author] = a.updatedByClerkId ? await db.select({ f: usersTable.firstName, l: usersTable.lastName, e: usersTable.email }).from(usersTable).where(eq(usersTable.clerkUserId, a.updatedByClerkId)) : [];
  res.json({ ...a, readByMe: r?.version === a.version, readAt: r?.readAt ?? null, updatedByName: author ? [author.f, author.l].filter(Boolean).join(" ") || author.e : null, readers, canEdit: me.editor });
}));

function articleValues(b: Record<string, unknown>, partial: boolean) {
  const v: Partial<typeof kbArticlesTable.$inferInsert> = {};
  if (!partial || b.title !== undefined) { const t = String(b.title ?? "").trim(); if (!t) throw new HttpError(400, "Укажите заголовок"); v.title = t.slice(0, 200); }
  if (b.body !== undefined) { const s = String(b.body ?? ""); if (s.length > 100_000) throw new HttpError(400, "Слишком длинная статья"); v.body = s; }
  if (b.category !== undefined) { if (!KB_CATEGORIES.includes(b.category as never)) throw new HttpError(400, "Неизвестный раздел"); v.category = b.category as string; }
  if (b.tags !== undefined) v.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags ?? "").split(",")).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  if (b.status !== undefined) { if (!["draft", "published"].includes(String(b.status))) throw new HttpError(400, "Неверный статус"); v.status = b.status as string; }
  if (b.pinned !== undefined) v.pinned = !!b.pinned;
  if (b.techCardId !== undefined) v.techCardId = b.techCardId ? Number(b.techCardId) : null;
  return v;
}

router.post("/kb/articles", ...route(async (req, res, me) => {
  editorOnly(me);
  const v = articleValues(req.body ?? {}, false);
  const [a] = await db.insert(kbArticlesTable).values({ ...v, title: v.title!, authorClerkId: me.clerkId, updatedByClerkId: me.clerkId }).returning({ id: kbArticlesTable.id });
  await logAudit({ action: "create", entityType: "kb_article", entityId: a.id, clerkUserId: me.clerkId });
  res.status(201).json(a);
}));

router.patch("/kb/articles/:id", ...route(async (req, res, me) => {
  editorOnly(me);
  const [a] = await db.select().from(kbArticlesTable).where(eq(kbArticlesTable.id, idOf(req)));
  if (!a) throw new HttpError(404, "Статья не найдена");
  const v = articleValues(req.body ?? {}, true);
  // A real change of the text asks everyone to re-read; "minor" (typos) does not.
  const changed = (v.body !== undefined && v.body !== a.body) || (v.title !== undefined && v.title !== a.title);
  if (changed && !req.body?.minor) v.version = a.version + 1;
  await db.update(kbArticlesTable).set({ ...v, updatedByClerkId: me.clerkId, updatedAt: new Date() }).where(eq(kbArticlesTable.id, a.id));
  await logAudit({ action: "update", entityType: "kb_article", entityId: a.id, clerkUserId: me.clerkId, details: v.version ? `новая версия ${v.version}` : "правка" });
  res.json({ ok: true, version: v.version ?? a.version });
}));

router.delete("/kb/articles/:id", ...route(async (req, res, me) => {
  editorOnly(me);
  const id = idOf(req);
  await db.delete(kbArticlesTable).where(eq(kbArticlesTable.id, id));
  await logAudit({ action: "delete", entityType: "kb_article", entityId: id, clerkUserId: me.clerkId });
  res.status(204).end();
}));

router.post("/kb/articles/:id/read", ...route(async (req, res, me) => {
  const [a] = await db.select({ id: kbArticlesTable.id, version: kbArticlesTable.version }).from(kbArticlesTable).where(and(eq(kbArticlesTable.id, idOf(req)), eq(kbArticlesTable.status, "published")));
  if (!a) throw new HttpError(404, "Статья не найдена");
  await db.insert(kbReadsTable).values({ articleId: a.id, userClerkId: me.clerkId, version: a.version })
    .onConflictDoUpdate({ target: [kbReadsTable.articleId, kbReadsTable.userClerkId], set: { version: a.version, readAt: new Date() } });
  res.json({ ok: true });
}));

router.post("/kb/starter", ...route(async (_req, res, me) => {
  editorOnly(me);
  const existing = new Set((await db.select({ t: kbArticlesTable.title }).from(kbArticlesTable)).map((x) => x.t));
  const ids: number[] = [];
  for (const s of STARTER_ARTICLES) {
    if (existing.has(s.title)) { const [a] = await db.select({ id: kbArticlesTable.id }).from(kbArticlesTable).where(eq(kbArticlesTable.title, s.title)); ids.push(a.id); continue; }
    const [a] = await db.insert(kbArticlesTable).values({ ...s, pinned: !!s.pinned, authorClerkId: me.clerkId, updatedByClerkId: me.clerkId }).returning({ id: kbArticlesTable.id });
    ids.push(a.id);
  }
  let [course] = await db.select({ id: trainingCoursesTable.id }).from(trainingCoursesTable).where(eq(trainingCoursesTable.title, STARTER_COURSE.title));
  if (!course) [course] = await db.insert(trainingCoursesTable).values({ ...STARTER_COURSE, articleIds: ids, createdByClerkId: me.clerkId }).returning({ id: trainingCoursesTable.id });
  res.json({ articles: ids.length, courseId: course.id });
}));

// ─── Training ───────────────────────────────────────────────────────────────

async function readSet(clerkId: string, ids: number[]) {
  if (!ids.length) return new Set<number>();
  const rows = await db.select({ id: kbArticlesTable.id }).from(kbArticlesTable)
    .innerJoin(kbReadsTable, and(eq(kbReadsTable.articleId, kbArticlesTable.id), eq(kbReadsTable.userClerkId, clerkId), eq(kbReadsTable.version, kbArticlesTable.version)))
    .where(inArray(kbArticlesTable.id, ids));
  return new Set(rows.map((r) => r.id));
}
async function lessons(ids: number[]) {
  if (!ids.length) return [];
  const rows = await db.select({ id: kbArticlesTable.id, title: kbArticlesTable.title, status: kbArticlesTable.status }).from(kbArticlesTable).where(inArray(kbArticlesTable.id, ids));
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((x): x is NonNullable<typeof x> => !!x && x.status === "published");
}

router.get("/training/my", ...route(async (_req, res, me) => {
  if (!me.staffId) { res.json({ hasStaffCard: false, items: [] }); return; }
  const rows = await db.select({ a: trainingAssignmentsTable, c: trainingCoursesTable }).from(trainingAssignmentsTable)
    .innerJoin(trainingCoursesTable, eq(trainingCoursesTable.id, trainingAssignmentsTable.courseId))
    .where(eq(trainingAssignmentsTable.staffId, me.staffId)).orderBy(asc(trainingAssignmentsTable.status), desc(trainingAssignmentsTable.createdAt));
  const items = [];
  for (const { a, c } of rows) {
    const ls = await lessons(c.articleIds);
    const read = await readSet(me.clerkId, ls.map((l) => l.id));
    items.push({
      assignmentId: a.id, courseId: c.id, title: c.title, description: c.description, passPercent: c.passPercent, status: a.status, bestScore: a.bestScore, attempts: a.attempts,
      dueDate: a.dueDate, passedAt: a.passedAt, lessons: ls.map((l) => ({ id: l.id, title: l.title, read: read.has(l.id) })), quiz: publicQuiz(c.quiz), canTakeQuiz: ls.every((l) => read.has(l.id)),
    });
  }
  res.json({ hasStaffCard: true, items });
}));

router.post("/training/assignments/:id/attempt", ...route(async (req, res, me) => {
  const [row] = await db.select({ a: trainingAssignmentsTable, c: trainingCoursesTable }).from(trainingAssignmentsTable)
    .innerJoin(trainingCoursesTable, eq(trainingCoursesTable.id, trainingAssignmentsTable.courseId)).where(eq(trainingAssignmentsTable.id, idOf(req)));
  if (!row || row.a.staffId !== me.staffId) throw new HttpError(404, "Курс не найден");
  const ls = await lessons(row.c.articleIds);
  const read = await readSet(me.clerkId, ls.map((l) => l.id));
  if (!ls.every((l) => read.has(l.id))) throw new HttpError(400, "Сначала прочитайте все уроки курса");
  if (!row.c.quiz.length) throw new HttpError(400, "В курсе нет теста");
  const g = grade(row.c.quiz as Question[], req.body?.answers, row.c.passPercent);
  const passed = g.passed || row.a.status === "passed";
  await db.update(trainingAssignmentsTable).set({
    attempts: row.a.attempts + 1, bestScore: Math.max(row.a.bestScore ?? 0, g.score), lastAnswers: g.answers,
    status: passed ? "passed" : "failed", passedAt: row.a.passedAt ?? (g.passed ? new Date() : null),
  }).where(eq(trainingAssignmentsTable.id, row.a.id));
  if (g.passed && row.a.status !== "passed" && row.a.assignedByClerkId) void notifyUsers([row.a.assignedByClerkId], `🎓 ${me.name} прошёл(ла) курс «${row.c.title}» на ${g.score}%`).catch(() => {});
  res.json({ score: g.score, passed: g.passed, wrong: g.wrong, passPercent: row.c.passPercent });
}));

router.get("/training/courses", ...route(async (_req, res, me) => {
  const rows = await db.select().from(trainingCoursesTable).where(me.editor ? undefined : eq(trainingCoursesTable.isActive, true)).orderBy(desc(trainingCoursesTable.createdAt));
  const counts = await db.select({ courseId: trainingAssignmentsTable.courseId, total: sql<number>`count(*)::int`, passed: sql<number>`count(*) FILTER (WHERE ${trainingAssignmentsTable.status} = 'passed')::int` })
    .from(trainingAssignmentsTable).groupBy(trainingAssignmentsTable.courseId);
  const by = new Map(counts.map((c) => [c.courseId, c]));
  res.json(rows.map((c) => ({ ...c, quiz: me.editor ? c.quiz : publicQuiz(c.quiz), assigned: by.get(c.id)?.total ?? 0, passed: by.get(c.id)?.passed ?? 0 })));
}));

function courseValues(b: Record<string, unknown>, partial: boolean) {
  const v: Partial<typeof trainingCoursesTable.$inferInsert> = {};
  if (!partial || b.title !== undefined) { const t = String(b.title ?? "").trim(); if (!t) throw new HttpError(400, "Укажите название курса"); v.title = t.slice(0, 200); }
  if (b.description !== undefined) v.description = b.description ? String(b.description) : null;
  if (b.department !== undefined) { if (b.department && !DEPARTMENTS.includes(String(b.department))) throw new HttpError(400, "Неизвестный отдел"); v.department = (b.department as string) || null; }
  if (b.articleIds !== undefined) { if (!Array.isArray(b.articleIds) || b.articleIds.length > 50) throw new HttpError(400, "Неверный список уроков"); v.articleIds = [...new Set(b.articleIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]; }
  if (b.quiz !== undefined) v.quiz = validateQuiz(b.quiz);
  if (b.passPercent !== undefined) { const p = Number(b.passPercent); if (!(p >= 1 && p <= 100)) throw new HttpError(400, "Проходной балл — от 1 до 100%"); v.passPercent = Math.round(p); }
  if (b.isActive !== undefined) v.isActive = !!b.isActive;
  return v;
}
router.post("/training/courses", ...route(async (req, res, me) => {
  editorOnly(me);
  const v = courseValues(req.body ?? {}, false);
  const [c] = await db.insert(trainingCoursesTable).values({ ...v, title: v.title!, createdByClerkId: me.clerkId }).returning({ id: trainingCoursesTable.id });
  res.status(201).json(c);
}));
router.patch("/training/courses/:id", ...route(async (req, res, me) => {
  editorOnly(me);
  const v = courseValues(req.body ?? {}, true);
  const [c] = await db.update(trainingCoursesTable).set({ ...v, updatedAt: new Date() }).where(eq(trainingCoursesTable.id, idOf(req))).returning({ id: trainingCoursesTable.id });
  if (!c) throw new HttpError(404, "Курс не найден");
  res.json({ ok: true });
}));

router.post("/training/courses/:id/assign", ...route(async (req, res, me) => {
  editorOnly(me);
  const [c] = await db.select().from(trainingCoursesTable).where(eq(trainingCoursesTable.id, idOf(req)));
  if (!c) throw new HttpError(404, "Курс не найден");
  const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
  if (dueDate && !isDate(dueDate)) throw new HttpError(400, "Неверная дата");
  const conds: SQL[] = [eq(staffTable.isActive, true)];
  if (req.body?.all) { /* everyone active */ }
  else if (req.body?.department) conds.push(eq(staffTable.department, String(req.body.department)));
  else if (Array.isArray(req.body?.staffIds) && req.body.staffIds.length) conds.push(inArray(staffTable.id, req.body.staffIds.map(Number)));
  else throw new HttpError(400, "Выберите, кому назначить курс");
  const staff = await db.select({ id: staffTable.id, account: staffTable.userClerkId }).from(staffTable).where(and(...conds));
  if (!staff.length) throw new HttpError(400, "Нет подходящих сотрудников");
  const created = await db.insert(trainingAssignmentsTable).values(staff.map((s) => ({ courseId: c.id, staffId: s.id, assignedByClerkId: me.clerkId, dueDate })))
    .onConflictDoNothing().returning({ staffId: trainingAssignmentsTable.staffId });
  const newIds = new Set(created.map((x) => x.staffId));
  void notifyUsers(staff.filter((s) => newIds.has(s.id)).map((s) => s.account), `🎓 Вам назначено обучение: «${c.title}»${dueDate ? ` — пройти до ${dueDate.split("-").reverse().join(".")}` : ""}.\nОткройте CRM → «Обучение».`).catch((err) => logger.warn({ err }, "training notify failed"));
  res.json({ assigned: created.length, skipped: staff.length - created.length, noAccount: staff.filter((s) => newIds.has(s.id) && !s.account).length });
}));

router.get("/training/progress", ...route(async (_req, res, me) => {
  editorOnly(me);
  const rows = await db.select({
    id: trainingAssignmentsTable.id, staffId: staffTable.id, staffName: staffTable.name, department: staffTable.department, account: staffTable.userClerkId,
    courseId: trainingCoursesTable.id, course: trainingCoursesTable.title, articleIds: trainingCoursesTable.articleIds, status: trainingAssignmentsTable.status,
    bestScore: trainingAssignmentsTable.bestScore, attempts: trainingAssignmentsTable.attempts, dueDate: trainingAssignmentsTable.dueDate, passedAt: trainingAssignmentsTable.passedAt,
  }).from(trainingAssignmentsTable)
    .innerJoin(staffTable, eq(staffTable.id, trainingAssignmentsTable.staffId))
    .innerJoin(trainingCoursesTable, eq(trainingCoursesTable.id, trainingAssignmentsTable.courseId))
    .orderBy(asc(staffTable.name));
  const out = [];
  for (const r of rows) {
    const ls = await lessons(r.articleIds);
    const read = r.account ? await readSet(r.account, ls.map((l) => l.id)) : new Set<number>();
    const { articleIds: _a, account, ...rest } = r;
    out.push({ ...rest, hasAccount: !!account, lessonsRead: read.size, lessonsTotal: ls.length });
  }
  res.json(out);
}));

export default router;
