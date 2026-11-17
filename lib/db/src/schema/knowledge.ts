import { pgTable, serial, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { staffTable } from "./staff";

export const KB_CATEGORIES = ["general", "crm", "kitchen", "bar", "pastry", "hall", "admin", "tech", "safety"] as const;

/** Knowledge base article: rules, instructions, recipes explained, CRM how-tos. Body is Markdown. */
export const kbArticlesTable = pgTable("kb_articles", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  category: text("category").notNull().default("general"),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  // draft | published
  status: text("status").notNull().default("published"),
  pinned: boolean("pinned").notNull().default(false),
  // Bumped when the text changes, so people re-confirm they have read the new version.
  version: integer("version").notNull().default(1),
  techCardId: integer("tech_card_id"),
  authorClerkId: text("author_clerk_id"),
  updatedByClerkId: text("updated_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  catIdx: index("kb_articles_category_idx").on(t.category, t.status),
}));

/** "I have read this" — per account and article version. */
export const kbReadsTable = pgTable("kb_reads", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => kbArticlesTable.id, { onDelete: "cascade" }),
  userClerkId: text("user_clerk_id").notNull(),
  version: integer("version").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("kb_reads_article_user_uq").on(t.articleId, t.userClerkId),
}));

export type QuizQuestion = { q: string; options: string[]; correct: number };

/** A course = ordered articles to read + a test. */
export const trainingCoursesTable = pgTable("training_courses", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  department: text("department"),
  articleIds: integer("article_ids").array().notNull().default(sql`ARRAY[]::integer[]`),
  quiz: jsonb("quiz").$type<QuizQuestion[]>().notNull().default([]),
  passPercent: integer("pass_percent").notNull().default(80),
  isActive: boolean("is_active").notNull().default(true),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingAssignmentsTable = pgTable("training_assignments", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => trainingCoursesTable.id, { onDelete: "cascade" }),
  staffId: integer("staff_id").notNull().references(() => staffTable.id, { onDelete: "cascade" }),
  assignedByClerkId: text("assigned_by_clerk_id"),
  dueDate: date("due_date"),
  // assigned | passed | failed
  status: text("status").notNull().default("assigned"),
  bestScore: integer("best_score"),
  attempts: integer("attempts").notNull().default(0),
  lastAnswers: jsonb("last_answers").$type<number[]>(),
  passedAt: timestamp("passed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("training_assignments_course_staff_uq").on(t.courseId, t.staffId),
  staffIdx: index("training_assignments_staff_idx").on(t.staffId),
}));
