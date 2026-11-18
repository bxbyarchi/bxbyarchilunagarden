import { pgTable, serial, text, timestamp, boolean, integer, numeric, date, uniqueIndex, real } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { locationsTable } from "./locations";

export const staffTable = pgTable("staff", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  position: text("position"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  // kitchen | bar | pastry | hall | admin | tech | other
  department: text("department"),
  // Linked CRM account (usersTable.clerkUserId) — for tasks, money requests, own timesheet.
  userClerkId: text("user_clerk_id"),
  hourlyRate: numeric("hourly_rate", { precision: 12, scale: 2 }),
  shiftRate: numeric("shift_rate", { precision: 12, scale: 2 }),
  // PIN for the check-in kiosk, stored hashed; unique among staff.
  pinHash: text("pin_hash"),
  hireDate: date("hire_date"),
  notes: text("notes"),
  // When the employee agreed in writing to photo check-in (and later face recognition).
  photoConsentAt: timestamp("photo_consent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pinUnique: uniqueIndex("staff_pin_hash_uq").on(t.pinHash).where(sql`${t.pinHash} IS NOT NULL`),
}));

/** Planned shift: one per employee per day; end ≤ start means it ends next day. */
export const staffSchedulesTable = pgTable("staff_schedules", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  note: text("note"),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  staffDay: uniqueIndex("staff_schedules_staff_date_uq").on(t.staffId, t.date),
}));

/** Actual presence: check-in / check-out with photos from the kiosk, or manual. */
export const attendanceTable = pgTable("attendance", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  checkInAt: timestamp("check_in_at", { withTimezone: true }).notNull(),
  checkOutAt: timestamp("check_out_at", { withTimezone: true }),
  checkInPhoto: text("check_in_photo"),
  checkOutPhoto: text("check_out_photo"),
  // kiosk | manual
  method: text("method").notNull().default("kiosk"),
  note: text("note"),
  editedByClerkId: text("edited_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneOpen: uniqueIndex("attendance_one_open_uq").on(t.staffId).where(sql`${t.checkOutAt} IS NULL`),
}));

export const insertStaffSchema = createInsertSchema(staffTable).omit({ id: true, createdAt: true });
export type InsertStaff = z.infer<typeof insertStaffSchema>;
export type Staff = typeof staffTable.$inferSelect;

/**
 * Face "fingerprints" (128 numbers from face-api) for kiosk recognition. Only with the employee's
 * written consent (staff.photoConsentAt); removing consent deletes them.
 */
export const staffFacesTable = pgTable("staff_faces", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  descriptor: real("descriptor").array().notNull(),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
