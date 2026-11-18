/** What happens to a WhatsApp / Instagram message after Meta delivers it to us. */
import { db, aiMessagesTable, aiConversationsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { findOrCreateConversation, handleGuestMessage } from "../ai/agent";
import { notifyStaff } from "../telegramBot";
import { logger } from "../logger";
import { instagramName, markWhatsAppRead, sendToChannel, type Incoming } from "./meta";

const MANAGERS = ["super_admin", "location_admin", "manager"];
const CH: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram" };

export async function processIncoming(ev: Incoming): Promise<"replied" | "staff-echo" | "own-echo" | "human" | "off" | "duplicate" | "failed"> {
  const conv = await findOrCreateConversation(ev.channel, ev.from, ev.name);
  if (!conv.contactName && ev.channel === "instagram") {
    const name = await instagramName(ev.from);
    if (name) await db.update(aiConversationsTable).set({ contactName: name }).where(eq(aiConversationsTable.id, conv.id));
  }
  const who = conv.contactName ?? ev.name ?? ev.from;

  if (ev.echo) {
    // Our own reply coming back from Instagram, or a manager answering from the Instagram app.
    const [mine] = await db.select({ id: aiMessagesTable.id }).from(aiMessagesTable).where(and(eq(aiMessagesTable.conversationId, conv.id), eq(aiMessagesTable.externalId, ev.messageId)));
    if (mine) return "own-echo";
    // Long replies are sent in parts (each with its own id): a part of a recent AI/staff message is ours too.
    const recent = await db.select({ text: aiMessagesTable.text, role: aiMessagesTable.role, at: aiMessagesTable.createdAt }).from(aiMessagesTable)
      .where(eq(aiMessagesTable.conversationId, conv.id)).orderBy(desc(aiMessagesTable.createdAt)).limit(5);
    const echoText = ev.text.trim();
    if (echoText && recent.some((m) => (m.role === "ai" || m.role === "staff") && Date.now() - m.at.getTime() < 10 * 60_000 && m.text.includes(echoText))) return "own-echo";
    await db.insert(aiMessagesTable).values({ conversationId: conv.id, role: "staff", text: ev.text, externalId: ev.messageId }).onConflictDoNothing();
    await db.insert(aiMessagesTable).values({ conversationId: conv.id, role: "note", text: "Менеджер ответил из приложения Instagram — ИИ не вмешивается в этот диалог" });
    await db.update(aiConversationsTable).set({ status: "human", lastMessageAt: new Date() }).where(eq(aiConversationsTable.id, conv.id));
    return "staff-echo";
  }

  if (ev.channel === "whatsapp") void markWhatsAppRead(ev.messageId);
  const r = await handleGuestMessage(conv.id, ev.text, { externalId: ev.messageId });
  if (r.handledBy === "duplicate") return "duplicate";
  if (r.handledBy === "human") {
    await notifyStaff(`💬 ${CH[ev.channel]}: ${who} написал(а) в диалоге, который ведёт менеджер:\n${ev.text.slice(0, 300)}\nОтветьте в CRM → «ИИ-агент».`, MANAGERS);
    return "human";
  }
  if (r.handledBy === "off" || !r.reply) {
    await notifyStaff(`💬 ${CH[ev.channel]}: новое сообщение от ${who} — ИИ-агент выключен, ответьте в CRM → «ИИ-агент»:\n${ev.text.slice(0, 300)}`, MANAGERS);
    return "off";
  }
  const sent = await sendToChannel(ev.channel, ev.from, r.reply);
  if (r.messageId) await db.update(aiMessagesTable).set({ externalId: sent.externalId, deliveryError: sent.error }).where(eq(aiMessagesTable.id, r.messageId));
  if (!sent.ok) {
    logger.warn({ channel: ev.channel, error: sent.error }, "channel delivery failed");
    await db.update(aiConversationsTable).set({ needsAttention: true, attentionKind: "error", attentionReason: `Ответ ИИ не доставлен: ${sent.error}` }).where(eq(aiConversationsTable.id, conv.id));
    await notifyStaff(`⚠️ ${CH[ev.channel]}: ответ ИИ гостю ${who} не доставлен — ${sent.error}`, MANAGERS);
    return "failed";
  }
  return "replied";
}

/** Manager's reply from the CRM goes out to the guest's messenger. */
export async function deliverStaffReply(conversationId: number, text: string, authorClerkId: string | null) {
  const conv = await db.query.aiConversationsTable.findFirst({ where: eq(aiConversationsTable.id, conversationId) });
  if (!conv) throw new Error("conversation not found");
  const sent = await sendToChannel(conv.channel, conv.externalId, text);
  const [m] = await db.insert(aiMessagesTable).values({ conversationId, role: "staff", text, authorClerkId, externalId: sent.externalId, deliveryError: sent.error }).returning({ id: aiMessagesTable.id });
  await db.update(aiConversationsTable).set({ status: "human", lastMessageAt: new Date() }).where(eq(aiConversationsTable.id, conversationId));
  return { messageId: m.id, delivered: sent.ok, error: sent.error };
}

export async function lastInbound(channel: string) {
  const [m] = await db.select({ at: aiMessagesTable.createdAt }).from(aiMessagesTable)
    .innerJoin(aiConversationsTable, eq(aiConversationsTable.id, aiMessagesTable.conversationId))
    .where(and(eq(aiConversationsTable.channel, channel), eq(aiMessagesTable.role, "guest"))).orderBy(desc(aiMessagesTable.createdAt)).limit(1);
  return m?.at ?? null;
}
