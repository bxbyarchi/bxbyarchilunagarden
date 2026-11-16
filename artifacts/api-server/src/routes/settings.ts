import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { db } from "@workspace/db";
import { appSettingsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sensitiveActionLimiter } from "../middlewares/security";
import { hashPassword, validatePassword, normalizeLogin } from "../lib/passwords";
import { newAccountId, destroyAllSessionsForUser } from "../lib/session";
import { logAudit } from "../lib/auditLogger";

const router: IRouter = Router();

/** Never send password hashes to the client. */
function publicUser<T extends { passwordHash?: string | null }>(u: T): Omit<T, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

const ALL_ROLES = ["super_admin", "warehouse_chief", "manager", "accountant", "warehouse", "location_admin", "cashier"];

async function getOrCreateSettings() {
  let settings = await db.query.appSettingsTable.findFirst();
  if (!settings) {
    [settings] = await db.insert(appSettingsTable).values({}).returning();
  }
  return settings!;
}

async function requireSuperAdmin(req: Request, res: Response): Promise<boolean> {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, clerkUserId) });
  if (!user || user.role !== "super_admin") { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

/**
 * Delegated user management: super_admin manages anyone; location_admin may
 * only manage cashier accounts at their own location — a lighter, scoped
 * stand-in for a real invite flow.
 */
async function requireUserManager(req: Request, res: Response): Promise<{ id: number; role: string; locationId: number | null } | null> {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkUserId, clerkUserId) });
  if (!user || (user.role !== "super_admin" && user.role !== "location_admin")) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return user;
}

// ─── Org settings ───────────────────────────────────────────────────────────

router.get("/settings", requireAuth(), async (_req: Request, res: Response) => {
  const settings = await getOrCreateSettings();
  res.json(settings);
});

router.put("/settings", requireAuth(), async (req: Request, res: Response) => {
  if (!(await requireSuperAdmin(req, res))) return;
  const { orgName, currency, timezone } = req.body as { orgName?: string; currency?: string; timezone?: string };
  const settings = await getOrCreateSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      ...(orgName !== undefined ? { orgName } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    })
    .where(eq(appSettingsTable.id, settings.id))
    .returning();
  res.json(updated);
});

// ─── User management ─────────────────────────────────────────────────────────

router.get("/admin/users", requireAuth(), async (req: Request, res: Response) => {
  const manager = await requireUserManager(req, res);
  if (!manager) return;
  const users = manager.role === "super_admin"
    ? await db.query.usersTable.findMany({ orderBy: (u, { asc }) => [asc(u.createdAt)] })
    : await db.query.usersTable.findMany({
        where: and(eq(usersTable.role, "cashier"), eq(usersTable.locationId, manager.locationId ?? -1)),
        orderBy: (u, { asc }) => [asc(u.createdAt)],
      });
  res.json(users.map(publicUser));
});

/** Create a local account (login + temporary password). */
router.post("/admin/users", requireAuth(), sensitiveActionLimiter, async (req: Request, res: Response) => {
  const manager = await requireUserManager(req, res);
  if (!manager) return;

  const { firstName, lastName, email, password, role, locationId } = req.body as {
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    role?: string;
    locationId?: number | null;
  };

  const login = normalizeLogin(email);
  if (!login) { res.status(400).json({ error: "Укажите логин (без пробелов, от 2 символов)" }); return; }
  const pwdError = validatePassword(password);
  if (pwdError) { res.status(400).json({ error: pwdError }); return; }

  let assignedRole: string;
  let assignedLocationId: number | null;
  if (manager.role === "super_admin") {
    assignedRole = role && ALL_ROLES.includes(role) ? role : "warehouse";
    assignedLocationId = locationId ?? null;
  } else {
    // location_admin may only mint cashier accounts, scoped to their own location.
    if (role && role !== "cashier") { res.status(403).json({ error: "Вы можете создавать только кассиров" }); return; }
    assignedRole = "cashier";
    assignedLocationId = manager.locationId;
    if (!assignedLocationId) { res.status(400).json({ error: "Вам не назначена площадка" }); return; }
  }

  try {
    const [dbUser] = await db.insert(usersTable).values({
      clerkUserId: newAccountId(),
      email: login,
      passwordHash: await hashPassword(password!),
      role: assignedRole,
      locationId: assignedLocationId,
      firstName: firstName?.trim() || null,
      lastName: lastName?.trim() || null,
    }).onConflictDoNothing().returning();
    if (!dbUser) { res.status(409).json({ error: `Логин «${login}» уже занят` }); return; }
    await logAudit({ action: "create", entityType: "user", entityId: dbUser.id, clerkUserId: req.auth?.userId, details: `Логин ${login}, роль ${assignedRole}` });
    res.status(201).json(publicUser(dbUser));
  } catch (err) {
    logger.error({ err }, "Failed to create user");
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

/** Reset another user's password (admin sets a new temporary one). Signs that user out everywhere. */
router.post("/admin/users/:id/password", requireAuth(), sensitiveActionLimiter, async (req: Request, res: Response) => {
  const manager = await requireUserManager(req, res);
  if (!manager) return;
  const id = Number(req.params.id);
  const target = await db.query.usersTable.findFirst({ where: eq(usersTable.id, id) });
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  if (manager.role !== "super_admin" && (target.role !== "cashier" || target.locationId !== manager.locationId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const { password } = req.body as { password?: string };
  const pwdError = validatePassword(password);
  if (pwdError) { res.status(400).json({ error: pwdError }); return; }
  await db.update(usersTable).set({ passwordHash: await hashPassword(password!) }).where(eq(usersTable.id, id));
  await destroyAllSessionsForUser(id);
  await logAudit({ action: "update", entityType: "user", entityId: id, clerkUserId: req.auth?.userId, details: "Сброс пароля" });
  res.json({ success: true });
});

/** Change user role */
router.patch("/admin/users/:id/role", requireAuth(), sensitiveActionLimiter, async (req: Request, res: Response) => {
  const manager = await requireUserManager(req, res);
  if (!manager) return;
  const id = Number(req.params.id);
  const { role } = req.body as { role?: string };
  if (!role || !ALL_ROLES.includes(role)) { res.status(400).json({ error: "Invalid role" }); return; }

  if (manager.role !== "super_admin") {
    const target = await db.query.usersTable.findFirst({ where: eq(usersTable.id, id) });
    if (!target || target.role !== "cashier" || target.locationId !== manager.locationId) { res.status(403).json({ error: "Forbidden" }); return; }
    if (role !== "cashier") { res.status(403).json({ error: "Вы можете назначать только роль кассира" }); return; }
  }

  const [updated] = await db
    .update(usersTable)
    .set({ role })
    .where(eq(usersTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json(publicUser(updated));
});

/** Delete user (their sessions cascade). */
router.delete("/admin/users/:id", requireAuth(), sensitiveActionLimiter, async (req: Request, res: Response) => {
  const manager = await requireUserManager(req, res);
  if (!manager) return;

  const requestingClerkId = req.auth?.userId;
  const id = Number(req.params.id);

  const target = await db.query.usersTable.findFirst({ where: eq(usersTable.id, id) });
  if (!target) { res.status(404).json({ error: "User not found" }); return; }

  // Prevent self-deletion
  if (target.clerkUserId === requestingClerkId) {
    res.status(400).json({ error: "Нельзя удалить свой собственный аккаунт" });
    return;
  }

  if (manager.role !== "super_admin" && (target.role !== "cashier" || target.locationId !== manager.locationId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ success: true });
});

// ─── Telegram (per-user chat ID link) ────────────────────────────────────────

router.patch("/admin/users/me/telegram", requireAuth(), async (req: Request, res: Response) => {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { telegramChatId } = req.body as { telegramChatId?: string };
  const [updated] = await db
    .update(usersTable)
    .set({ telegramChatId: telegramChatId || null })
    .where(eq(usersTable.clerkUserId, clerkUserId))
    .returning();
  res.json(updated ? publicUser(updated) : null);
});

router.get("/admin/telegram/status", requireAuth(), async (_req: Request, res: Response) => {
  const botConnected = !!process.env["TELEGRAM_BOT_TOKEN"];
  const adminChatConfigured = !!process.env["TELEGRAM_ADMIN_CHAT_ID"];
  res.json({ botConnected, adminChatConfigured });
});

export default router;
