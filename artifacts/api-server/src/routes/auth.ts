import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db } from "@workspace/db";
import { usersTable, locationsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { hashPassword, verifyPassword, validatePassword, normalizeLogin } from "../lib/passwords";
import { createSession, destroySession, destroyAllSessionsForUser, newAccountId } from "../lib/session";
import { loginLimiter } from "../middlewares/security";
import { logAudit } from "../lib/auditLogger";

const router: IRouter = Router();

// Compared against when the login doesn't exist, so a wrong login and a wrong
// password take the same time and can't be told apart.
const DUMMY_HASH_PROMISE = hashPassword("dummy-password-for-timing");

async function countUsers(): Promise<number> {
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(usersTable);
  return Number(count);
}

/** Public: tells the frontend whether the first administrator still has to be created. */
router.get("/auth/status", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ needsSetup: (await countUsers()) === 0 });
});

/** Public, one-time: creates the very first account (super_admin). Refused once any user exists. */
router.post("/auth/setup", loginLimiter, async (req: Request, res: Response) => {
  const { login, password, firstName, lastName } = req.body as Record<string, unknown>;
  const normalized = normalizeLogin(login);
  if (!normalized) { res.status(400).json({ error: "Укажите логин (без пробелов, от 2 символов)" }); return; }
  const pwdError = validatePassword(password);
  if (pwdError) { res.status(400).json({ error: pwdError }); return; }

  const passwordHash = await hashPassword(password as string);
  // The count check and insert run in one transaction under an advisory lock,
  // so two simultaneous setup requests can't both create an admin.
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4242001)`);
    const [{ count }] = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(usersTable);
    if (Number(count) > 0) return null;
    const [user] = await tx.insert(usersTable).values({
      clerkUserId: newAccountId(),
      email: normalized,
      passwordHash,
      role: "super_admin",
      firstName: typeof firstName === "string" && firstName.trim() ? firstName.trim() : null,
      lastName: typeof lastName === "string" && lastName.trim() ? lastName.trim() : null,
    }).returning();
    return user;
  });
  if (!created) { res.status(409).json({ error: "Система уже настроена. Войдите под своим логином." }); return; }

  await createSession(req, res, created.id);
  await logAudit({ action: "create", entityType: "user", entityId: created.id, clerkUserId: created.clerkUserId, details: "Первичная настройка: создан администратор" });
  res.status(201).json({ ok: true });
});

/** Public: login + password → session cookie. */
router.post("/auth/login", loginLimiter, async (req: Request, res: Response) => {
  const { login, password } = req.body as Record<string, unknown>;
  const normalized = normalizeLogin(login);
  if (!normalized || typeof password !== "string" || !password) { res.status(400).json({ error: "Введите логин и пароль" }); return; }

  const user = await db.query.usersTable.findFirst({ where: sql`lower(${usersTable.email}) = ${normalized}` });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));
  if (!user || !ok || !user.passwordHash) { res.status(401).json({ error: "Неверный логин или пароль" }); return; }
  if (!user.isActive) { res.status(403).json({ error: "Учётная запись отключена. Обратитесь к администратору." }); return; }

  await createSession(req, res, user.id);
  res.json({ ok: true });
});

router.post("/auth/logout", requireAuth(), async (req: Request, res: Response) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

/** Change own password. Signs out every other session of this account. */
router.post("/auth/change-password", requireAuth(), loginLimiter, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as Record<string, unknown>;
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, req.auth!.userId!) });
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.passwordHash))) {
    res.status(400).json({ error: "Текущий пароль неверен" }); return;
  }
  const pwdError = validatePassword(newPassword);
  if (pwdError) { res.status(400).json({ error: pwdError }); return; }
  await db.update(usersTable).set({ passwordHash: await hashPassword(newPassword as string) }).where(eq(usersTable.id, user.id));
  await destroyAllSessionsForUser(user.id);
  await createSession(req, res, user.id);
  res.json({ ok: true });
});

/** Update own display name. */
router.patch("/auth/profile", requireAuth(), async (req: Request, res: Response) => {
  const { firstName, lastName } = req.body as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null);
  await db.update(usersTable).set({ firstName: clean(firstName), lastName: clean(lastName) }).where(eq(usersTable.clerkUserId, req.auth!.userId!));
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth(),async (req: Request, res: Response) => {
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, req.auth!.userId!) });
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  let locationName: string | null = null;
  if (user.locationId) {
    const location = await db.query.locationsTable.findFirst({ where: eq(locationsTable.id, user.locationId) });
    locationName = location?.name ?? null;
  }

  res.json({
    clerkUserId: user.clerkUserId,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    telegramChatId: user.telegramChatId ?? null,
    locationId: user.locationId ?? null,
    locationName,
  });
});

export default router;
