import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, sessionsTable, usersTable } from "@workspace/db";
import { and, eq, gt, lt } from "drizzle-orm";

export const SESSION_COOKIE = "lg_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Stable opaque account id stored in usersTable.clerkUserId. */
export function newAccountId(): string {
  return `u_${randomUUID()}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function createSession(req: Request, res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessionsTable).values({
    id: hashToken(token),
    userId,
    expiresAt,
    userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
  });
  // Opportunistic cleanup of expired sessions.
  void db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date())).catch(() => undefined);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax: the cookie is not sent on cross-site POST/PATCH/DELETE or fetch — that is what blocks CSRF.
    sameSite: "lax",
    // The restaurant's local server usually runs on plain http inside the LAN;
    // behind HTTPS (req.secure, with TRUST_PROXY set) the cookie is marked Secure.
    secure: req.secure,
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db.delete(sessionsTable).where(eq(sessionsTable.id, hashToken(token)));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function destroyAllSessionsForUser(userId: number): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
}

/** Resolves the session cookie and sets req.auth.userId (the account's opaque
 * id) — the same shape requireAuth() and every route already read. */
export function sessionMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    try {
      const [row] = await db
        .select({ sessionId: sessionsTable.id, accountId: usersTable.clerkUserId, isActive: usersTable.isActive })
        .from(sessionsTable)
        .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
        .where(and(eq(sessionsTable.id, hashToken(token)), gt(sessionsTable.expiresAt, new Date())))
        .limit(1);
      if (row?.isActive) req.auth = { userId: row.accountId, sessionId: row.sessionId };
    } catch (err) {
      req.log?.warn({ err }, "session lookup failed");
    }
    next();
  };
}
