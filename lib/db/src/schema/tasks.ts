import { pgTable, serial, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { staffTable } from "./staff";

export const TASK_STATUSES = ["new", "in_progress", "review", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TASK_REPEATS = ["daily", "weekly", "monthly"] as const;

export type ChecklistItem = { text: string; done: boolean };

/**
 * A task set by one person for another. The assignee is a staff card (so people
 * without a CRM account — a cook, a cleaner — can get tasks too); the creator is
 * always a CRM account.
 */
export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("new"),
  priority: text("priority").notNull().default("normal"),
  creatorClerkId: text("creator_clerk_id").notNull(),
  assigneeStaffId: integer("assignee_staff_id").references(() => staffTable.id, { onDelete: "set null" }),
  // kitchen | bar | pastry | hall | admin | tech | other — same keys as staff.department
  department: text("department"),
  // Where in the restaurant (free text now; the 3D model will pick from these).
  zone: text("zone"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  // The creator checks the result before it counts as done.
  needsReview: boolean("needs_review").notNull().default(true),
  checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
  // daily | weekly | monthly — when done, the next copy is created automatically.
  repeat: text("repeat"),
  parentTaskId: integer("parent_task_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  returnedCount: integer("returned_count").notNull().default(0),
  overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  assigneeIdx: index("tasks_assignee_idx").on(t.assigneeStaffId, t.status),
  creatorIdx: index("tasks_creator_idx").on(t.creatorClerkId),
  dueIdx: index("tasks_due_idx").on(t.status, t.dueAt),
}));

/** Comments and the status history of a task. */
export const taskEventsTable = pgTable("task_events", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  authorClerkId: text("author_clerk_id"),
  // comment | status | edit
  kind: text("kind").notNull().default("comment"),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  taskIdx: index("task_events_task_idx").on(t.taskId),
}));
