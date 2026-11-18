/**
 * WhatsApp Business (Cloud API) and Instagram messages through Meta's official APIs.
 * Meta calls our webhook; we answer with the AI agent and send replies back.
 *
 * Settings (environment, never in the database or the chat):
 *   META_APP_SECRET           — App secret: checks that webhooks really come from Meta
 *   META_VERIFY_TOKEN         — any string; the same is entered in Meta when connecting the webhook
 *   WHATSAPP_TOKEN            — permanent system-user token with whatsapp_business_messaging
 *   WHATSAPP_PHONE_NUMBER_ID  — id of the WhatsApp number (not the number itself)
 *   INSTAGRAM_TOKEN           — Instagram API (Instagram Login) token with instagram_business_manage_messages
 *   INSTAGRAM_ACCOUNT_ID      — the restaurant's Instagram professional account id
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const GRAPH_VERSION = "v21.0";
const fbBase = () => (process.env.META_GRAPH_BASE || "https://graph.facebook.com").replace(/\/$/, "");
const igBase = () => (process.env.META_INSTAGRAM_BASE || "https://graph.instagram.com").replace(/\/$/, "");

export const whatsappReady = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
export const instagramReady = () => !!(process.env.INSTAGRAM_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID);

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface Incoming {
  channel: "whatsapp" | "instagram";
  /** WhatsApp: the guest's number (wa_id); Instagram: the guest's IG-scoped id. */
  from: string;
  name: string | null;
  messageId: string;
  text: string;
  /** Instagram: a message the restaurant itself sent (from the Instagram app) — logged as staff. */
  echo: boolean;
}

/** Placeholder text for what the agent can't read yet — it then answers politely or calls a manager. */
function describe(type: string): string {
  return ({
    image: "[Гость прислал фото]", audio: "[Гость прислал голосовое сообщение]", voice: "[Гость прислал голосовое сообщение]", video: "[Гость прислал видео]",
    document: "[Гость прислал файл]", sticker: "[Гость прислал стикер]", location: "[Гость прислал геолокацию]", contacts: "[Гость прислал контакт]",
  } as Record<string, string>)[type] ?? `[Гость прислал сообщение типа «${type}», без текста]`;
}

type WaValue = { metadata?: { phone_number_id?: string }; contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: { from: string; id: string; type: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }; image?: { caption?: string } }[] };
type IgEvent = { sender?: { id?: string }; recipient?: { id?: string }; message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: { type?: string }[]; is_deleted?: boolean } };

/** Turn a webhook body into messages. Status updates, reactions, read receipts etc. are skipped. */
export function parseWebhook(body: unknown, ownIgId = process.env.INSTAGRAM_ACCOUNT_ID): Incoming[] {
  const b = body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: WaValue }[]; messaging?: IgEvent[] }[] };
  const out: Incoming[] = [];
  if (b?.object === "whatsapp_business_account") {
    for (const e of b.entry ?? []) for (const ch of e.changes ?? []) {
      if (ch.field !== "messages") continue;
      const v = ch.value ?? {};
      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        const text = m.type === "text" ? m.text?.body ?? ""
          : m.type === "button" ? m.button?.text ?? ""
          : m.type === "interactive" ? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ""
          : m.type === "image" && m.image?.caption ? `${describe("image")} ${m.image.caption}` : describe(m.type);
        if (text.trim()) out.push({ channel: "whatsapp", from: m.from, name, messageId: m.id, text, echo: false });
      }
    }
  }
  if (b?.object === "instagram") {
    for (const e of b.entry ?? []) for (const ev of e.messaging ?? []) {
      const msg = ev.message;
      if (!msg?.mid || msg.is_deleted) continue;
      const echo = !!msg.is_echo || (!!ownIgId && ev.sender?.id === ownIgId);
      const guest = echo ? ev.recipient?.id : ev.sender?.id;
      if (!guest) continue;
      const text = msg.text ?? (msg.attachments?.length ? describe(msg.attachments[0].type ?? "file") : "");
      if (text.trim()) out.push({ channel: "instagram", from: guest, name: null, messageId: msg.mid, text, echo });
    }
  }
  return out;
}

export interface SendResult { ok: boolean; externalId: string | null; error: string | null }

function metaError(status: number, body: { error?: { message?: string; code?: number; error_subcode?: number } } | null): string {
  const code = body?.error?.code;
  // 131047: more than 24 h since the guest's last message — WhatsApp only allows approved templates then.
  if (code === 131047 || /24 hour|re-engagement/i.test(body?.error?.message ?? "")) return "Прошло больше 24 часов с последнего сообщения гостя — WhatsApp не даёт написать первым без шаблона. Позвоните гостю или дождитесь его сообщения.";
  if (code === 190 || status === 401) return "Токен Meta недействителен или истёк — обновите его в настройках сервера";
  if (code === 10 || code === 200) return "Нет разрешения на отправку — проверьте права приложения Meta";
  if (code === 551 || /not available|outside of allowed window/i.test(body?.error?.message ?? "")) return "Instagram не даёт ответить: прошло больше 7 дней или гость ограничил сообщения";
  return `Meta: ${body?.error?.message ?? `HTTP ${status}`}`.slice(0, 300);
}

async function post(url: string, token: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}

/** WhatsApp allows 4096 characters per text message. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendWhatsApp(to: string, text: string): Promise<SendResult> {
  if (!whatsappReady()) return { ok: false, externalId: null, error: "WhatsApp не подключён (нет WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)" };
  let last: string | null = null;
  try {
    for (const part of splitText(text, 4000)) {
      const r = await post(`${fbBase()}/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, process.env.WHATSAPP_TOKEN!,
        { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: part, preview_url: false } });
      if (r.status >= 300) return { ok: false, externalId: last, error: metaError(r.status, r.body as never) };
      last = ((r.body?.messages as { id?: string }[] | undefined)?.[0]?.id) ?? last;
    }
    return { ok: true, externalId: last, error: null };
  } catch { return { ok: false, externalId: last, error: "Нет связи с WhatsApp (Meta) — проверьте интернет на сервере" }; }
}

/** Blue ticks in WhatsApp — the guest sees the message was read. Best effort. */
export async function markWhatsAppRead(messageId: string) {
  if (!whatsappReady()) return;
  await post(`${fbBase()}/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, process.env.WHATSAPP_TOKEN!, { messaging_product: "whatsapp", status: "read", message_id: messageId }).catch(() => undefined);
}

export async function sendInstagram(recipientId: string, text: string): Promise<SendResult> {
  if (!instagramReady()) return { ok: false, externalId: null, error: "Instagram не подключён (нет INSTAGRAM_TOKEN / INSTAGRAM_ACCOUNT_ID)" };
  let last: string | null = null;
  try {
    for (const part of splitText(text, 990)) {
      const r = await post(`${igBase()}/${GRAPH_VERSION}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, process.env.INSTAGRAM_TOKEN!, { recipient: { id: recipientId }, message: { text: part } });
      if (r.status >= 300) return { ok: false, externalId: last, error: metaError(r.status, r.body as never) };
      last = (r.body?.message_id as string | undefined) ?? last;
    }
    return { ok: true, externalId: last, error: null };
  } catch { return { ok: false, externalId: last, error: "Нет связи с Instagram (Meta) — проверьте интернет на сервере" }; }
}

/** Instagram doesn't send names in webhooks — look the guest up once (best effort). */
export async function instagramName(igsid: string): Promise<string | null> {
  if (!instagramReady()) return null;
  try {
    const r = await fetch(`${igBase()}/${GRAPH_VERSION}/${igsid}?fields=name,username&access_token=${encodeURIComponent(process.env.INSTAGRAM_TOKEN!)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { name?: string; username?: string };
    return j.name || (j.username ? `@${j.username}` : null);
  } catch { return null; }
}

export async function sendToChannel(channel: string, to: string, text: string): Promise<SendResult> {
  if (channel === "whatsapp") return sendWhatsApp(to, text);
  if (channel === "instagram") return sendInstagram(to, text);
  return { ok: true, externalId: null, error: null }; // test chat: nothing to deliver
}
