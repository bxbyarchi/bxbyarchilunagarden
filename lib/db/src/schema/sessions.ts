import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Login sessions. `id` is the SHA-256 of the random cookie token — the raw
 * token only ever lives in the browser cookie, so a DB leak can't be replayed. */
export const sessionsTable = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
}, (table) => ({
  userIdx: index("sessions_user_idx").on(table.userId),
}));

export type Session = typeof sessionsTable.$inferSelect;
