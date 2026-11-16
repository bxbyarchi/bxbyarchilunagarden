import { pgTable, serial, text, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { locationsTable } from "./locations";

// Accounts are local (no external auth provider): login + scrypt password hash,
// sessions live in sessionsTable. `clerkUserId` keeps its historical name: it is
// the stable opaque account id ("u_<uuid>") that every route and the audit log
// key off — renaming it is a separate, purely cosmetic migration.
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  // Login. Historically an email; for restaurant staff any name works ("povar1").
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  isActive: boolean("is_active").notNull().default(true),
  role: text("role").notNull().default("warehouse"),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  firstName: text("first_name"),
  lastName: text("last_name"),
  telegramChatId: text("telegram_chat_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  loginUnique: uniqueIndex("users_login_lower_uq").on(sql`lower(${table.email})`),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true, passwordHash: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
