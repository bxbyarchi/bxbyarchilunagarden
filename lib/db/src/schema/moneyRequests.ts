import { pgTable, serial, text, timestamp, integer, numeric, jsonb, date, index } from "drizzle-orm/pg-core";
import { staffTable } from "./staff";
import { counterpartiesTable } from "./counterparties";

/** advance — под отчёт; payment — оплата по счёту поставщику/за услугу; reimbursement — вернуть потраченные свои. */
export const MONEY_KINDS = ["advance", "payment", "reimbursement"] as const;
/**
 * pending → approved → issued → reported → closed   (advance)
 * pending → approved → closed (paid)                 (payment, reimbursement)
 * rejected / cancelled — final.
 */
export const MONEY_STATUSES = ["pending", "approved", "issued", "reported", "closed", "rejected", "cancelled"] as const;
export const PAY_METHODS = ["cash", "transfer", "card"] as const;
/** Where the money goes in the P&L. "goods" = stock purchase: it reaches the P&L through the cost of sales, not here. */
export const EXPENSE_CATEGORIES = ["goods", "services", "repair", "household", "utilities", "rent", "marketing", "salary", "taxes", "other"] as const;

export type EstimateLine = { name: string; qty: number; unit: string; price: number };
export type ReportLine = { name: string; amount: number; file: string | null };

export const moneyRequestsTable = pgTable("money_requests", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  title: text("title").notNull(),
  purpose: text("purpose"),
  requesterClerkId: text("requester_clerk_id").notNull(),
  // Who gets the money / owes the report (advance, reimbursement).
  staffId: integer("staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  // Who is paid (payment).
  counterpartyId: integer("counterparty_id").references(() => counterpartiesTable.id, { onDelete: "set null" }),
  department: text("department"),
  expenseCategory: text("expense_category"),
  estimate: jsonb("estimate").$type<EstimateLine[]>().notNull().default([]),
  amountRequested: numeric("amount_requested", { precision: 12, scale: 2 }).notNull(),
  amountApproved: numeric("amount_approved", { precision: 12, scale: 2 }),
  amountIssued: numeric("amount_issued", { precision: 12, scale: 2 }),
  payMethod: text("pay_method"),
  neededBy: date("needed_by"),
  // Invoice / supporting documents attached with the request.
  files: jsonb("files").$type<string[]>().notNull().default([]),
  // Advance report (and the receipts of a reimbursement).
  report: jsonb("report").$type<ReportLine[]>().notNull().default([]),
  amountSpent: numeric("amount_spent", { precision: 12, scale: 2 }),
  // >0 returned to the till by the employee, <0 paid out to them for overspending.
  settlement: numeric("settlement", { precision: 12, scale: 2 }),
  reportDueAt: date("report_due_at"),
  approvedByClerkId: text("approved_by_clerk_id"),
  issuedByClerkId: text("issued_by_clerk_id"),
  closedByClerkId: text("closed_by_clerk_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  statusIdx: index("money_requests_status_idx").on(t.status),
  requesterIdx: index("money_requests_requester_idx").on(t.requesterClerkId),
  staffIdx: index("money_requests_staff_idx").on(t.staffId, t.status),
}));

export const moneyRequestEventsTable = pgTable("money_request_events", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => moneyRequestsTable.id, { onDelete: "cascade" }),
  authorClerkId: text("author_clerk_id"),
  kind: text("kind").notNull().default("comment"),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reqIdx: index("money_request_events_req_idx").on(t.requestId),
}));
