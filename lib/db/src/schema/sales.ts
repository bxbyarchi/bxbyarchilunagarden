import { pgTable, serial, integer, text, numeric, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";
import { registersTable } from "./registers";
import { productsTable } from "./products";
import { itemsTable } from "./items";
import { locationsTable } from "./locations";

export const paymentMethods = ["cash", "card"] as const;
export const saleStatus = ["completed", "returned", "partially_returned"] as const;

export const salesTable = pgTable("sales", {
  id: serial("id").primaryKey(),
  shiftId: integer("shift_id").notNull().references(() => shiftsTable.id),
  registerId: integer("register_id").notNull().references(() => registersTable.id),
  subtotalAmount: numeric("subtotal_amount", { precision: 12, scale: 2 }).notNull(),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  discountReason: text("discount_reason"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull().default("cash"),
  status: text("status").notNull().default("completed"),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSaleSchema = createInsertSchema(salesTable).omit({ id: true, createdAt: true });
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type Sale = typeof salesTable.$inferSelect;

export const saleItemsTable = pgTable("sale_items", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull().references(() => salesTable.id),
  productId: integer("product_id").references(() => productsTable.id),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
  pricePerUnit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
  totalPrice: numeric("total_price", { precision: 12, scale: 2 }).notNull(),
  returnedQuantity: numeric("returned_quantity", { precision: 12, scale: 3 }).notNull().default("0"),
});

export type SaleItem = typeof saleItemsTable.$inferSelect;

export const returnsTable = pgTable("returns", {
  id: serial("id").primaryKey(),
  saleItemId: integer("sale_item_id").notNull().references(() => saleItemsTable.id),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  // Смена, в которой оформлен возврат (может отличаться от смены продажи).
  shiftId: integer("shift_id").references(() => shiftsTable.id),
  restocked: boolean("restocked").notNull().default(false),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Return = typeof returnsTable.$inferSelect;

/**
 * Складские движения по продажам: что списано за позицию чека (qty > 0) и что
 * возвращено на склад при возврате (qty < 0). Количество — в единице позиции
 * склада, unitCost — её цена на момент движения (для фактической себестоимости).
 */
export const saleStockMovementsTable = pgTable("sale_stock_movements", {
  id: serial("id").primaryKey(),
  saleItemId: integer("sale_item_id").notNull().references(() => saleItemsTable.id),
  returnId: integer("return_id").references(() => returnsTable.id),
  itemId: integer("item_id").notNull().references(() => itemsTable.id),
  locationId: integer("location_id").notNull().references(() => locationsTable.id),
  qty: numeric("qty", { precision: 12, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 12, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  saleItemIdx: index("sale_stock_movements_sale_item_idx").on(t.saleItemId),
  itemDateIdx: index("sale_stock_movements_item_date_idx").on(t.itemId, t.createdAt),
}));

export type SaleStockMovement = typeof saleStockMovementsTable.$inferSelect;
