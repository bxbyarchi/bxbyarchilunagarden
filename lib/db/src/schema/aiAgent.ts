import { pgTable, serial, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, check, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { guestsTable } from "./guests";

/**
 * Диалог ИИ-агента с гостем в одном канале. externalId — идентификатор
 * собеседника в канале (номер WhatsApp, id Instagram, номер звонящего);
 * для тестового чата в CRM — случайный.
 * status: ai — отвечает агент; human — диалог перехвачен менеджером; closed.
 */
export const aiConversationsTable = pgTable("ai_conversations", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),             // test | whatsapp | instagram | phone
  externalId: text("external_id").notNull(),
  guestId: integer("guest_id").references(() => guestsTable.id, { onDelete: "set null" }),
  contactName: text("contact_name"),              // имя из профиля канала
  status: text("status").notNull().default("ai"),
  needsAttention: boolean("needs_attention").notNull().default(false),
  attentionReason: text("attention_reason"),
  attentionKind: text("attention_kind"),          // complaint | large_event | human_request | error | other
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  channelExternalUnique: uniqueIndex("ai_conversations_channel_external_uq").on(t.channel, t.externalId),
  statusCheck: check("ai_conversations_status_ck", sql`${t.status} in ('ai', 'human', 'closed')`),
  lastIdx: index("ai_conversations_last_idx").on(t.lastMessageAt),
}));

/**
 * Сообщение диалога. role: guest | ai | staff | note (служебная пометка).
 * actions — что агент сделал за этот ответ (вызовы инструментов с итогом),
 * error — что пошло не так (ошибка API, отказ модели, сбой инструмента).
 */
export const aiMessagesTable = pgTable("ai_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => aiConversationsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  text: text("text").notNull(),
  actions: jsonb("actions").$type<Array<{ tool: string; input: unknown; ok: boolean; result: string }>>(),
  error: text("error"),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
  authorClerkId: text("author_clerk_id"),         // для staff
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roleCheck: check("ai_messages_role_ck", sql`${t.role} in ('guest', 'ai', 'staff', 'note')`),
  convIdx: index("ai_messages_conv_idx").on(t.conversationId, t.createdAt),
  errorIdx: index("ai_messages_error_idx").on(t.createdAt).where(sql`${t.error} IS NOT NULL`),
}));

/** Настройки агента (одна строка). */
export const aiSettingsTable = pgTable("ai_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  model: text("model").notNull().default("claude-opus-5-5"),
  restaurantInfo: text("restaurant_info"),        // адрес, часы, парковка, телефон, как добраться
  tone: text("tone"),                             // как общаться
  depositRules: text("deposit_rules"),            // пояснение для гостей (возврат, сроки оплаты)
  // Предоплата считается сервером, не ИИ: от depositMinParty гостей — depositPerGuest сом за гостя.
  depositMinParty: integer("deposit_min_party"),
  depositPerGuest: numeric("deposit_per_guest", { precision: 12, scale: 2 }),
  paymentDetails: text("payment_details"),        // куда переводить предоплату
  knowledge: text("knowledge"),                   // база знаний: акции, банкеты, правила, FAQ
  maxPartyForAi: integer("max_party_for_ai").notNull().default(12), // больше — передать менеджеру
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AiConversation = typeof aiConversationsTable.$inferSelect;
export type AiMessage = typeof aiMessagesTable.$inferSelect;
export type AiSettings = typeof aiSettingsTable.$inferSelect;
