import { pgTable, serial, text, timestamp, integer, numeric, boolean, date, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Гость ресторана (клиентская база для броней и ИИ-агента). Телефон хранится
 * нормализованным (только цифры, с кодом страны) — по нему гость находится из
 * любого канала: звонок, WhatsApp, бронь у администратора.
 */
export const guestsTable = pgTable("guests", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),                 // нормализованный: 996555123456
  whatsapp: text("whatsapp"),
  instagram: text("instagram"),         // @username
  telegram: text("telegram"),
  email: text("email"),
  birthday: date("birthday"),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  notes: text("notes"),                 // аллергии, любимый стол, предпочтения
  source: text("source"),               // откуда пришёл: whatsapp, instagram, phone, walk_in, other
  isVip: boolean("is_vip").notNull().default(false),
  isBlacklisted: boolean("is_blacklisted").notNull().default(false),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  phoneUnique: uniqueIndex("guests_phone_uq").on(t.phone).where(sql`${t.phone} IS NOT NULL`),
  nameIdx: index("guests_name_idx").on(sql`lower(${t.name})`),
}));

/** Столы зала (для броней). */
export const diningTablesTable = pgTable("dining_tables", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),         // «5», «VIP-1», «Веранда 3»
  zone: text("zone"),                   // Зал, Веранда, VIP
  seats: integer("seats").notNull().default(4),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => ({
  nameUnique: uniqueIndex("dining_tables_name_uq").on(sql`lower(${t.name})`),
  seatsCheck: check("dining_tables_seats_ck", sql`${t.seats} between 1 and 100`),
}));

export const BOOKING_STATUSES = ["new", "confirmed", "seated", "completed", "cancelled", "no_show"] as const;
export const DEPOSIT_STATUSES = ["none", "requested", "paid", "refunded"] as const;

/**
 * Бронь. Столы — массив (большая компания может занять несколько столов).
 * Предоплата: сумма + статус + способ; «paid» ставит администратор (QR/перевод)
 * или кассир при визите (наличные).
 */
export const bookingsTable = pgTable("bookings", {
  id: serial("id").primaryKey(),
  guestId: integer("guest_id").notNull().references(() => guestsTable.id, { onDelete: "restrict" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  durationMin: integer("duration_min").notNull().default(120),
  partySize: integer("party_size").notNull(),
  tableIds: integer("table_ids").array().notNull().default(sql`ARRAY[]::integer[]`),
  status: text("status").notNull().default("new"),
  occasion: text("occasion"),           // день рождения, деловая встреча…
  comment: text("comment"),
  depositAmount: numeric("deposit_amount", { precision: 12, scale: 2 }),
  depositStatus: text("deposit_status").notNull().default("none"),
  depositMethod: text("deposit_method"), // qr, transfer, cash
  depositPaidAt: timestamp("deposit_paid_at", { withTimezone: true }),
  channel: text("channel"),             // откуда бронь: phone, whatsapp, instagram, walk_in, ai, crm
  createdBy: text("created_by"),        // clerk id сотрудника или "ai"
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  statusCheck: check("bookings_status_ck", sql`${t.status} in ('new','confirmed','seated','completed','cancelled','no_show')`),
  depositCheck: check("bookings_deposit_ck", sql`${t.depositStatus} in ('none','requested','paid','refunded')`),
  partyCheck: check("bookings_party_ck", sql`${t.partySize} between 1 and 500`),
  durationCheck: check("bookings_duration_ck", sql`${t.durationMin} between 15 and 1440`),
  startsIdx: index("bookings_starts_idx").on(t.startsAt),
  guestIdx: index("bookings_guest_idx").on(t.guestId),
}));

export type Guest = typeof guestsTable.$inferSelect;
export type DiningTable = typeof diningTablesTable.$inferSelect;
export type Booking = typeof bookingsTable.$inferSelect;
