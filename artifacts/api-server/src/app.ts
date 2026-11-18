import express, { type Express, type Request, type Response, type NextFunction } from "express";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { startTaskReminders } from "./routes/tasks";
import { registerTeamBot } from "./lib/teamBot";
import { startAttendanceAlerts } from "./lib/attendanceAlerts";
import { startTelegramOutbox } from "./lib/telegramBot";
import { startBackupWatch } from "./lib/backups";
import { logger } from "./lib/logger";
import { initTelegramBot } from "./lib/telegramBot";
import { sessionMiddleware } from "./lib/session";
import { corsMiddleware, helmetMiddleware, apiLimiter } from "./middlewares/security";

const app: Express = express();

// Behind a reverse proxy (nginx with HTTPS) set TRUST_PROXY=1 so req.secure /
// req.ip reflect the real client — needed for Secure cookies and rate limits.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(helmetMiddleware);
app.use(corsMiddleware);
// Check-in photos from the kiosk are larger than the default 100 KB body limit.
app.use("/api/personnel/kiosk", express.json({ limit: "2mb" }));
// Invoices and receipt photos (up to 4 MB as base64).
app.use("/api/money-requests/files", express.json({ limit: "6mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Local login sessions (cookie) → req.auth.userId. Runs before the limiter
// (which keys by user once known) and before the router.
app.use("/api", sessionMiddleware());
app.use("/api", apiLimiter);

app.use("/api", router);

// Team features (tasks, money) register before the warehouse handlers.
const telegramWebhook = initTelegramBot(registerTeamBot);
// Telegram reminders about overdue tasks (no-op sends when the bot is off).
if (process.env.NODE_ENV !== "test") { startTaskReminders(); startAttendanceAlerts(); startTelegramOutbox(); startBackupWatch(); }
if (telegramWebhook) {
  app.use("/api", telegramWebhook);
}

// The Vite build is emitted to artifacts/m-sklad/dist/public. The API build
// runs from artifacts/api-server/dist, so resolve the sibling artifact path
// from the compiled server directory at runtime.
const frontendDist = path.resolve(import.meta.dirname, "../../m-sklad/dist/public");
app.use(express.static(frontendDist));

// SPA fallback: let the client router handle routes, while preserving API paths.
app.get("/{*splat}", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api")) {
    return next();
  }
  res.sendFile(path.join(frontendDist, "index.html"));
});

// Global error handler — last middleware. Without this, an unhandled
// exception anywhere (auth middleware misconfiguration, a DB error, a bug in
// a route) falls through to Express's default handler, which renders an HTML
// page instead of the JSON every other error response on this API uses, and
// — in development — includes a full filesystem stack trace in the response
// body. Every /api/* response stays JSON; the stack trace still goes to logs.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log?.error({ err }, "unhandled error") ?? logger.error({ err }, "unhandled error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

export default app;
