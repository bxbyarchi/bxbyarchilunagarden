import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../lib/requireAuth";
import { db, aiConversationsTable, aiMessagesTable, aiSettingsTable, guestsTable, bookingsTable, usersTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull, sql, type SQL } from "drizzle-orm";
import { getWarehouseScope } from "../lib/warehouseScope";
import { logAudit } from "../lib/auditLogger";
import { handleGuestMessage, findOrCreateConversation, getSettings, conversationsTail } from "../lib/ai/agent";
import { deliverStaffReply } from "../lib/channels/inbox";
import { GUEST_MODELS, DEFAULT_GUEST_MODEL, CLAUDE_MODELS, availableModels, hasAnthropic, hasOpenRouter } from "../lib/llm/catalog";

const router: IRouter = Router();
const VIEW_ROLES = ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"];
const ADMIN_ROLES = ["super_admin", "location_admin", "manager"];

function requireRoles(roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const scope = await getWarehouseScope(req);
    if (!scope) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!roles.includes(scope.role)) { res.status(403).json({ error: "Нет доступа к ИИ-агенту" }); return; }
    next();
  };
}
const view = [requireAuth(), requireRoles(VIEW_ROLES)];
const admin = [requireAuth(), requireRoles(ADMIN_ROLES)];
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  };
}
async function conv(id: number) {
  const c = await db.query.aiConversationsTable.findFirst({ where: eq(aiConversationsTable.id, id) });
  if (!c) throw new HttpError(404, "Диалог не найден");
  return c;
}

// ─── Conversations ──────────────────────────────────────────────────────────

router.get("/ai/conversations", ...view, handle(async (req, res) => {
  const filter = String(req.query.filter ?? "all");
  const conds: SQL[] = [];
  if (filter === "attention") conds.push(eq(aiConversationsTable.needsAttention, true));
  if (filter === "human") conds.push(eq(aiConversationsTable.status, "human"));
  if (filter === "errors") conds.push(sql`EXISTS (SELECT 1 FROM ${aiMessagesTable} m WHERE m.conversation_id = ${aiConversationsTable.id} AND m.error IS NOT NULL)`);
  if (req.query.channel) conds.push(eq(aiConversationsTable.channel, String(req.query.channel)));
  const last = sql<string | null>`(SELECT m.text FROM ${aiMessagesTable} m WHERE m.conversation_id = ${aiConversationsTable.id} ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
  const lastRole = sql<string | null>`(SELECT m.role FROM ${aiMessagesTable} m WHERE m.conversation_id = ${aiConversationsTable.id} ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
  const stats = sql<string>`(SELECT json_build_object('messages', COUNT(*), 'errors', COUNT(m.error), 'cost', COALESCE(SUM(m.cost_usd), 0)) FROM ${aiMessagesTable} m WHERE m.conversation_id = ${aiConversationsTable.id})`;
  const rows = await db.select({
    id: aiConversationsTable.id, channel: aiConversationsTable.channel, externalId: aiConversationsTable.externalId, contactName: aiConversationsTable.contactName,
    status: aiConversationsTable.status, needsAttention: aiConversationsTable.needsAttention, attentionKind: aiConversationsTable.attentionKind,
    attentionReason: aiConversationsTable.attentionReason, lastMessageAt: aiConversationsTable.lastMessageAt,
    guestId: guestsTable.id, guestName: guestsTable.name, guestPhone: guestsTable.phone, last, lastRole, stats,
  }).from(aiConversationsTable).leftJoin(guestsTable, eq(aiConversationsTable.guestId, guestsTable.id))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(aiConversationsTable.lastMessageAt)).limit(300);
  res.json(rows.map((r) => ({ ...r, stats: typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats })));
}));

router.get("/ai/conversations/:id", ...view, handle(async (req, res) => {
  const c = await conv(Number(req.params.id));
  const messages = await conversationsTail(c.id);
  const authors = await db.select({ id: usersTable.clerkUserId, first: usersTable.firstName, last: usersTable.lastName }).from(usersTable);
  const nameOf = new Map(authors.map((a) => [a.id, [a.first, a.last].filter(Boolean).join(" ")]));
  const guest = c.guestId ? await db.query.guestsTable.findFirst({ where: eq(guestsTable.id, c.guestId) }) : null;
  const bookings = guest ? await db.select().from(bookingsTable).where(eq(bookingsTable.guestId, guest.id)).orderBy(desc(bookingsTable.startsAt)).limit(10) : [];
  res.json({
    ...c, guest, bookings,
    messages: messages.map((m) => ({ ...m, costUsd: m.costUsd == null ? null : Number(m.costUsd), authorName: m.authorClerkId ? nameOf.get(m.authorClerkId) ?? null : null })),
  });
}));

/** New conversation in the CRM test chat (the agent behaves exactly as in a real channel). */
router.post("/ai/test-chat", ...view, handle(async (req, res) => {
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : "Тестовый гость";
  const c = await findOrCreateConversation("test", `test-${randomUUID()}`, name);
  res.status(201).json(c);
}));

/** Test chat only: write as the guest and get the agent's reply. */
router.post("/ai/conversations/:id/guest-message", ...view, handle(async (req, res) => {
  const c = await conv(Number(req.params.id));
  if (c.channel !== "test") throw new HttpError(400, "Писать от имени гостя можно только в тестовом чате");
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) throw new HttpError(400, "Пустое сообщение");
  res.json(await handleGuestMessage(c.id, text));
}));

/** A manager writes to the guest. Taking over stops the AI in this conversation. */
router.post("/ai/conversations/:id/staff-reply", ...view, handle(async (req, res) => {
  const c = await conv(Number(req.params.id));
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
  if (!text) throw new HttpError(400, "Пустое сообщение");
  // Goes out to the guest's WhatsApp / Instagram; a failure (e.g. WhatsApp's 24-hour window) is shown to the manager.
  const r = await deliverStaffReply(c.id, text, req.auth?.userId ?? null);
  res.json({ ok: true, delivered: r.delivered, error: r.error });
}));

router.post("/ai/conversations/:id/status", ...view, handle(async (req, res) => {
  const c = await conv(Number(req.params.id));
  const action = String(req.body?.action ?? "");
  const userId = req.auth?.userId ?? null;
  const note = (text: string) => db.insert(aiMessagesTable).values({ conversationId: c.id, role: "note", text, authorClerkId: userId });
  if (action === "takeover") { await db.update(aiConversationsTable).set({ status: "human" }).where(eq(aiConversationsTable.id, c.id)); await note("Менеджер взял диалог — ИИ не отвечает"); }
  else if (action === "release") { await db.update(aiConversationsTable).set({ status: "ai" }).where(eq(aiConversationsTable.id, c.id)); await note("Диалог возвращён ИИ"); }
  else if (action === "resolve") { await db.update(aiConversationsTable).set({ needsAttention: false }).where(eq(aiConversationsTable.id, c.id)); await note(`Вопрос решён${c.attentionReason ? `: ${c.attentionReason}` : ""}`); }
  else if (action === "close") { await db.update(aiConversationsTable).set({ status: "closed", needsAttention: false }).where(eq(aiConversationsTable.id, c.id)); await note("Диалог закрыт"); }
  else throw new HttpError(400, "Неизвестное действие");
  res.json({ ok: true });
}));

// ─── Stats ──────────────────────────────────────────────────────────────────

router.get("/ai/stats", ...view, handle(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const [m] = await db.select({
    guestMessages: sql<number>`COUNT(*) FILTER (WHERE ${aiMessagesTable.role} = 'guest')::int`,
    aiReplies: sql<number>`COUNT(*) FILTER (WHERE ${aiMessagesTable.role} = 'ai' AND ${aiMessagesTable.error} IS NULL)::int`,
    staffReplies: sql<number>`COUNT(*) FILTER (WHERE ${aiMessagesTable.role} = 'staff')::int`,
    errors: sql<number>`COUNT(${aiMessagesTable.error})::int`,
    cost: sql<string>`COALESCE(SUM(${aiMessagesTable.costUsd}), 0)`,
    conversations: sql<number>`COUNT(DISTINCT ${aiMessagesTable.conversationId})::int`,
  }).from(aiMessagesTable).where(gte(aiMessagesTable.createdAt, since));
  const [b] = await db.select({
    bookings: sql<number>`COUNT(*)::int`, guests: sql<number>`COALESCE(SUM(${bookingsTable.partySize}), 0)::int`,
    cancelled: sql<number>`COUNT(*) FILTER (WHERE ${bookingsTable.status} IN ('cancelled','no_show'))::int`,
  }).from(bookingsTable).where(and(eq(bookingsTable.createdBy, "ai"), gte(bookingsTable.createdAt, since)));
  const [att] = await db.select({ open: sql<number>`COUNT(*)::int` }).from(aiConversationsTable).where(eq(aiConversationsTable.needsAttention, true));
  const byChannel = await db.select({ channel: aiConversationsTable.channel, count: sql<number>`COUNT(*)::int` }).from(aiConversationsTable).where(gte(aiConversationsTable.lastMessageAt, since)).groupBy(aiConversationsTable.channel);
  res.json({ days, ...m, cost: Number(m.cost), aiBookings: b, needsAttention: att.open, byChannel });
}));

router.get("/ai/errors", ...view, handle(async (_req, res) => {
  const rows = await db.select({ id: aiMessagesTable.id, conversationId: aiMessagesTable.conversationId, error: aiMessagesTable.error, createdAt: aiMessagesTable.createdAt, channel: aiConversationsTable.channel, contactName: aiConversationsTable.contactName })
    .from(aiMessagesTable).innerJoin(aiConversationsTable, eq(aiMessagesTable.conversationId, aiConversationsTable.id))
    .where(isNotNull(aiMessagesTable.error)).orderBy(desc(aiMessagesTable.createdAt)).limit(200);
  res.json(rows);
}));

// ─── Settings ───────────────────────────────────────────────────────────────

router.get("/ai/settings", ...view, handle(async (_req, res) => {
  const s = await getSettings();
  res.json({
    ...s, model: GUEST_MODELS.includes(s.model) ? s.model : DEFAULT_GUEST_MODEL, depositPerGuest: s.depositPerGuest == null ? null : Number(s.depositPerGuest),
    models: GUEST_MODELS, modelLabels: Object.fromEntries(CLAUDE_MODELS.map((m) => [m.id, m.label])),
    advisorModels: await availableModels(), apiKeyConfigured: hasAnthropic(), openRouterConfigured: hasOpenRouter(),
  });
}));

router.put("/ai/settings", ...admin, handle(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const txt = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);
  const values: Partial<typeof aiSettingsTable.$inferInsert> = {};
  if (b.enabled !== undefined) values.enabled = b.enabled !== false;
  if (b.model !== undefined) { if (!GUEST_MODELS.includes(String(b.model))) throw new HttpError(400, "Для гостей доступны только сильные модели (Opus или Sonnet)"); values.model = String(b.model); }
  if (b.advisorModel !== undefined) {
    const m = String(b.advisorModel);
    if (m !== "auto" && !(await availableModels()).some((x) => x.id === m)) throw new HttpError(400, "Модель недоступна — проверьте ключи");
    values.advisorModel = m;
  }
  if (b.digestHour !== undefined) { const h = b.digestHour === null || b.digestHour === "" ? null : Math.round(Number(b.digestHour)); if (h !== null && !(h >= 0 && h <= 23)) throw new HttpError(400, "Час от 0 до 23"); values.digestHour = h; }
  for (const k of ["restaurantInfo", "tone", "depositRules", "paymentDetails"] as const) if (b[k] !== undefined) values[k] = txt(b[k], 4000);
  if (b.knowledge !== undefined) values.knowledge = txt(b.knowledge, 30000);
  if (b.maxPartyForAi !== undefined) { const n = Math.round(Number(b.maxPartyForAi)); if (!(n >= 1 && n <= 500)) throw new HttpError(400, "Число гостей от 1 до 500"); values.maxPartyForAi = n; }
  if (b.depositMinParty !== undefined) values.depositMinParty = b.depositMinParty === null || b.depositMinParty === "" ? null : Math.max(1, Math.round(Number(b.depositMinParty)));
  if (b.depositPerGuest !== undefined) { const v = b.depositPerGuest === null || b.depositPerGuest === "" ? null : Number(b.depositPerGuest); if (v !== null && !(v >= 0)) throw new HttpError(400, "Неверная сумма"); values.depositPerGuest = v == null ? null : String(v); }
  const s = await getSettings();
  const [row] = await db.update(aiSettingsTable).set(values).where(eq(aiSettingsTable.id, s.id)).returning();
  await logAudit({ action: "update", entityType: "ai-settings", entityId: row.id, clerkUserId: req.auth?.userId });
  res.json(row);
}));

export default router;

