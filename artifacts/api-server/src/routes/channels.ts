import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/requireAuth";
import { getWarehouseScope } from "../lib/warehouseScope";
import { logger } from "../lib/logger";
import { parseWebhook, verifySignature, whatsappReady, instagramReady } from "../lib/channels/meta";
import { processIncoming, lastInbound } from "../lib/channels/inbox";

const router: IRouter = Router();

/** Meta checks the webhook once when it is connected: echo the challenge if the token matches. */
router.get("/channels/meta/webhook", (req: Request, res: Response) => {
  const token = process.env.META_VERIFY_TOKEN;
  if (token && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === token) { res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? "")); return; }
  res.sendStatus(403);
});

// Messages are handled one after another so a guest's quick messages stay in order.
let chain: Promise<unknown> = Promise.resolve();

router.post("/channels/meta/webhook", (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  // Only Meta knows the app secret: anything unsigned is someone else.
  if (!verifySignature(raw, req.header("x-hub-signature-256"), process.env.META_APP_SECRET)) { res.sendStatus(401); return; }
  let body: unknown;
  try { body = JSON.parse(raw.toString("utf8")); } catch { res.sendStatus(400); return; }
  // Answer Meta right away (it retries slow webhooks); the AI replies in the background.
  res.sendStatus(200);
  const events = parseWebhook(body);
  for (const ev of events) {
    chain = chain.then(() => processIncoming(ev)).catch((err) => logger.error({ err, channel: ev.channel }, "incoming message failed"));
  }
});

router.get("/channels/status", requireAuth(), async (req: Request, res: Response) => {
  const scope = await getWarehouseScope(req);
  if (!scope || !["super_admin", "location_admin", "manager"].includes(scope.role)) { res.status(403).json({ error: "Нет доступа" }); return; }
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.json({
    webhookUrl: `${base}/api/channels/meta/webhook`, httpsOk: base.startsWith("https://"),
    verifyTokenSet: !!process.env.META_VERIFY_TOKEN, appSecretSet: !!process.env.META_APP_SECRET,
    whatsapp: { ready: whatsappReady(), lastMessageAt: await lastInbound("whatsapp") },
    instagram: { ready: instagramReady(), lastMessageAt: await lastInbound("instagram") },
  });
});

export default router;
