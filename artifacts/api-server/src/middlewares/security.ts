import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

const isProduction = process.env.NODE_ENV === "production";

// Vite's local dev server. Never used in production — allowedOrigins below
// only includes these when NODE_ENV !== "production".
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function parseAllowedOrigins(): string[] {
  const fromEnv = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return isProduction ? fromEnv : [...fromEnv, ...DEV_ORIGINS];
}

const allowedOrigins = parseAllowedOrigins();

/** True when the Origin header names this same server (same host:port). */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * api-server serves the built frontend itself (see app.ts). Browsers DO send
 * an Origin header on same-origin module scripts, stylesheets loaded with
 * crossorigin, and every POST/PATCH/DELETE — so same-origin must be allowed
 * automatically: the restaurant's local server is reached at whatever LAN
 * address it has (http://192.168.1.10:3000), which no allowlist can predict.
 * Extra cross-origin callers: local Vite dev + CORS_ALLOWED_ORIGINS.
 * Any other origin simply gets no CORS headers (the browser blocks the read);
 * it is not turned into a 500, and session cookies (SameSite=Lax) are never
 * sent cross-site anyway.
 */
export const corsMiddleware = cors((req, callback) => {
  const origin = req.headers.origin;
  const allowed = !origin || isSameOrigin(origin, req.headers.host) || allowedOrigins.includes(origin);
  callback(null, { origin: allowed, credentials: true });
});

export const helmetMiddleware = helmet({
  // api-server also serves the built SPA from this same origin. A strict
  // default CSP needs per-asset hashes/nonces for Vite's hashed bundle and
  // inline styles from UI libraries — worth doing properly rather
  // than shipping a CSP that either breaks the app or is too loose to help.
  // Tracked for a follow-up pass; every other helmet protection (HSTS,
  // nosniff, frameguard, referrer-policy, etc.) is on by default here.
  contentSecurityPolicy: false,
});

/** Prefer the authenticated user as the rate-limit key once known — several
 * cashier tablets at the same venue share one public IP (NAT), and keying
 * by IP alone would let one tablet's burst traffic throttle every other
 * tablet at that location. Falls back to IP for anonymous requests, where a
 * per-account key doesn't exist yet. */
function keyByUserThenIp(req: Request): string {
  const auth = (req as Request & { auth?: { userId?: string } }).auth;
  if (auth?.userId) return auth.userId;
  // ipKeyGenerator normalizes IPv6 addresses to a /64 prefix — a raw address
  // would let one client cycle through its subnet to dodge the limit.
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
}

/** Baseline limiter for all /api traffic. Generous on purpose: this exists to
 * catch runaway clients/bugs and basic abuse, not to throttle normal kassa
 * traffic from 40-45 tablets. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserThenIp,
  message: { error: "Слишком много запросов. Попробуйте через минуту." },
});

/** Strict limiter for privilege-granting writes: minting/deleting user
 * accounts, changing roles, seeding demo data. These are rare, admin-only
 * actions — nobody legitimate needs to hit them dozens of times a minute.
 * (Password login has its own limiter, loginLimiter below.) Keyed by IP: an attacker attempting
 * this doesn't have a legitimate userId yet to key on, and the legitimate
 * callers here are a handful of admins, never a shared venue tablet IP. */
export const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток. Попробуйте позже." },
});

/** Brute-force guard for password login / first-run setup / password change.
 * Keyed by IP + submitted login, so one person mistyping on a shared kassa
 * tablet doesn't lock out colleagues on the same device, while guessing many
 * passwords for one account from one device is capped. Successful logins
 * don't count. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const ip = req.ip ? ipKeyGenerator(req.ip) : "unknown";
    const login = typeof req.body?.login === "string" ? req.body.login.trim().toLowerCase().slice(0, 100) : "";
    return `${ip}|${login}`;
  },
  message: { error: "Слишком много попыток входа. Попробуйте через 15 минут." },
});
