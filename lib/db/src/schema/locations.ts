import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const locationsTable = pgTable("locations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  code: text("code").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  isVenue: boolean("is_venue").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLocationSchema = createInsertSchema(locationsTable).omit({ id: true, createdAt: true });
export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type Location = typeof locationsTable.$inferSelect;

// Restaurant departments, created on first launch. Storage-only departments
// keep their own stock; isVenue marks a point of sale (kassa/shifts).
export const DEFAULT_LOCATIONS = [
  { name: "Основной склад", code: "MAIN", isVenue: false },
  { name: "Бар", code: "BAR", isVenue: false },
  { name: "Кухня", code: "KITCHEN", isVenue: false },
  { name: "Кондитерская", code: "PASTRY", isVenue: false },
  { name: "Хозчасть", code: "HOUSEHOLD", isVenue: false },
  { name: "Инструменты", code: "TOOLS", isVenue: false },
  { name: "Стройматериалы", code: "BUILDING", isVenue: false },
  { name: "Зал ресторана", code: "HALL", isVenue: true },
] as const;

export const VENUE_LOCATION_CODES = DEFAULT_LOCATIONS.filter((l) => l.isVenue).map((l) => l.code);
