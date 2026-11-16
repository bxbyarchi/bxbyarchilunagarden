import { pgTable, serial, text, timestamp, integer, boolean, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Роли контрагента — их может быть несколько (поставщик и одновременно клиент). */
export const COUNTERPARTY_ROLES = ["supplier", "client", "service", "specialist"] as const;
export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];

/**
 * Контрагент: компания или человек — поставщик продуктов, клиент (банкеты,
 * корпоративы), подрядчик-услуга (вывоз мусора, химчистка) или специалист
 * (электрик, сантехник). Категория — свободная («Мясо», «Электрик»), для поиска.
 */
export const counterpartiesTable = pgTable("counterparties", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("company"),
  roles: text("roles").array().notNull().default(sql`ARRAY[]::text[]`),
  name: text("name").notNull(),
  category: text("category"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  phone2: text("phone2"),
  email: text("email"),
  telegram: text("telegram"),
  address: text("address"),
  taxId: text("tax_id"),            // ИНН
  bankDetails: text("bank_details"),
  paymentTerms: text("payment_terms"), // «предоплата», «отсрочка 7 дней»
  rating: integer("rating"),        // 1–5, внутренняя оценка
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  kindCheck: check("counterparties_kind_ck", sql`${t.kind} in ('company', 'person')`),
  ratingCheck: check("counterparties_rating_ck", sql`${t.rating} is null or ${t.rating} between 1 and 5`),
  nameIdx: index("counterparties_name_idx").on(sql`lower(${t.name})`),
  rolesIdx: index("counterparties_roles_idx").using("gin", t.roles),
}));

export type Counterparty = typeof counterpartiesTable.$inferSelect;
