import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db, advisorChatsTable, advisorMessagesTable, usersTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { ask, chatMessages, AdvisorError, DAILY_LIMIT } from "../lib/advisor/advisor";

const router: IRouter = Router();

async function me(req: Request) {
  const u = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, req.auth!.userId!) });
  if (!u) throw new AdvisorError(401, "Unauthorized");
  return u;
}
async function myChat(req: Request, clerkId: string) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AdvisorError(404, "Чат не найден");
  const [c] = await db.select().from(advisorChatsTable).where(and(eq(advisorChatsTable.id, id), eq(advisorChatsTable.userClerkId, clerkId)));
  if (!c) throw new AdvisorError(404, "Чат не найден");
  return c;
}
const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof AdvisorError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
};
const shape = (m: typeof advisorMessagesTable.$inferSelect) => ({ id: m.id, role: m.role, text: m.text, actions: m.actions, error: m.error, costUsd: m.costUsd == null ? null : Number(m.costUsd), createdAt: m.createdAt });

// Every chat is private to its author — the advisor answers with that person's access rights.
router.get("/advisor/chats", requireAuth(), handle(async (req, res) => {
  const u = await me(req);
  const chats = await db.select({ id: advisorChatsTable.id, title: advisorChatsTable.title, updatedAt: advisorChatsTable.updatedAt })
    .from(advisorChatsTable).where(eq(advisorChatsTable.userClerkId, u.clerkUserId)).orderBy(desc(advisorChatsTable.updatedAt)).limit(100);
  const [{ used }] = await db.select({ used: sql<number>`count(*)::int` }).from(advisorMessagesTable)
    .innerJoin(advisorChatsTable, eq(advisorChatsTable.id, advisorMessagesTable.chatId))
    .where(and(eq(advisorChatsTable.userClerkId, u.clerkUserId), eq(advisorMessagesTable.role, "user"), gte(advisorMessagesTable.createdAt, new Date(Date.now() - 86400_000))));
  res.json({ chats, used, limit: DAILY_LIMIT, configured: !!process.env.ANTHROPIC_API_KEY });
}));

router.post("/advisor/chats", requireAuth(), handle(async (req, res) => {
  const u = await me(req);
  const [c] = await db.insert(advisorChatsTable).values({ userClerkId: u.clerkUserId }).returning();
  res.status(201).json(c);
}));

router.get("/advisor/chats/:id", requireAuth(), handle(async (req, res) => {
  const u = await me(req);
  const c = await myChat(req, u.clerkUserId);
  res.json({ ...c, messages: (await chatMessages(c.id)).map(shape) });
}));

router.delete("/advisor/chats/:id", requireAuth(), handle(async (req, res) => {
  const u = await me(req);
  const c = await myChat(req, u.clerkUserId);
  await db.delete(advisorChatsTable).where(eq(advisorChatsTable.id, c.id));
  res.status(204).end();
}));

router.post("/advisor/chats/:id/messages", requireAuth(), handle(async (req, res) => {
  const u = await me(req);
  const c = await myChat(req, u.clerkUserId);
  const text = String(req.body?.text ?? "").trim();
  if (!text) throw new AdvisorError(400, "Пустой вопрос");
  if (text.length > 4000) throw new AdvisorError(400, "Слишком длинный вопрос");
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
  const m = await ask(c.id, { clerkId: u.clerkUserId, name, role: u.role }, text, String(req.headers.cookie ?? ""));
  res.json(shape(m));
}));

export default router;
