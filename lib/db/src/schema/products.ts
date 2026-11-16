import { pgTable, serial, integer, text, numeric, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { housesTable } from "./houses";
import { techCardsTable } from "./techCards";
import { itemsTable } from "./items";
import { locationsTable } from "./locations";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  houseId: integer("house_id").notNull().references(() => housesTable.id),
  category: text("category").notNull(),
  name: text("name").notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  // Что списывать со склада при продаже: блюдо по тех-карте, либо готовый
  // товар (позиция склада, itemQty в её единице за 1 продажу), либо ничего.
  techCardId: integer("tech_card_id").references(() => techCardsTable.id, { onDelete: "set null" }),
  itemId: integer("item_id").references(() => itemsTable.id, { onDelete: "set null" }),
  itemQty: numeric("item_qty", { precision: 12, scale: 4 }).notNull().default("1"),
  // Склад списания; по умолчанию — подразделение тех-карты, иначе площадка точки продаж.
  writeOffLocationId: integer("write_off_location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  barcode: text("barcode"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  houseNameUnique: uniqueIndex("products_house_name_uq").on(table.houseId, table.name),
  barcodeIdx: index("products_barcode_idx").on(table.barcode),
}));

export const insertProductSchema = createInsertSchema(productsTable).omit({ id: true, createdAt: true });
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
