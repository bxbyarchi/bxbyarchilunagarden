import { pgTable, serial, text, timestamp, integer, numeric, boolean, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locationsTable } from "./locations";
import { itemsTable } from "./items";

/**
 * Технологическая карта: блюдо/напиток (kind = "dish") или полуфабрикат
 * (kind = "semi"), который сам может входить в другие тех-карты.
 * Выход (outputQty + outputUnit) — вес/объём/штук готового продукта на одну
 * порцию (для полуфабриката — на одну закладку).
 */
export const techCardsTable = pgTable("tech_cards", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("dish"),
  // Подразделение-производитель: Бар / Кухня / Кондитерская.
  departmentId: integer("department_id").references(() => locationsTable.id, { onDelete: "set null" }),
  category: text("category"),
  outputQty: numeric("output_qty", { precision: 12, scale: 3 }).notNull(),
  outputUnit: text("output_unit").notNull().default("г"),
  salePrice: numeric("sale_price", { precision: 12, scale: 2 }),
  technology: text("technology"),
  // Полуфабрикат на складе: позиция, на которую приходуется результат акта
  // производства. Создаётся автоматически при первом производстве.
  outputItemId: integer("output_item_id").references(() => itemsTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  kindCheck: check("tech_cards_kind_ck", sql`${t.kind} in ('dish', 'semi')`),
  departmentIdx: index("tech_cards_department_idx").on(t.departmentId),
}));

/**
 * Строка тех-карты: либо складская позиция (itemId), либо полуфабрикат
 * (semiCardId) — ровно одно из двух. Количество — брутто, в единице `unit`
 * (г/кг/мл/л/шт), совместимой с единицей позиции/выхода полуфабриката.
 * Потери: холодная обработка (брутто → нетто) и тепловая (нетто → выход).
 */
export const techCardIngredientsTable = pgTable("tech_card_ingredients", {
  id: serial("id").primaryKey(),
  techCardId: integer("tech_card_id").notNull().references(() => techCardsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => itemsTable.id, { onDelete: "restrict" }),
  semiCardId: integer("semi_card_id").references(() => techCardsTable.id, { onDelete: "restrict" }),
  grossQty: numeric("gross_qty", { precision: 12, scale: 4 }).notNull(),
  unit: text("unit").notNull(),
  coldLossPct: numeric("cold_loss_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  hotLossPct: numeric("hot_loss_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => ({
  sourceCheck: check("tech_card_ingredients_source_ck", sql`(${t.itemId} is null) <> (${t.semiCardId} is null)`),
  cardIdx: index("tech_card_ingredients_card_idx").on(t.techCardId),
}));

export type TechCard = typeof techCardsTable.$inferSelect;
export type TechCardIngredient = typeof techCardIngredientsTable.$inferSelect;
