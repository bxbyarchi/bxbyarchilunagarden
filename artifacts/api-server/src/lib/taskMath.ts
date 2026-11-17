/** Pure task-manager rules: transitions, overdue, recurrence, efficiency. */

export type TaskStatus = "new" | "in_progress" | "review" | "done" | "cancelled";
export type Repeat = "daily" | "weekly" | "monthly";
export type Actor = { isAdmin: boolean; isCreator: boolean; isAssignee: boolean };

export const OPEN: TaskStatus[] = ["new", "in_progress", "review"];

/**
 * Who may move a task where:
 *  - assignee: new → in_progress → review (or done when no review is needed);
 *  - creator/admin: everything, incl. accept (review → done), return (review → in_progress), cancel, reopen.
 */
export function canTransition(from: TaskStatus, to: TaskStatus, who: Actor, needsReview: boolean): boolean {
  if (from === to) return false;
  const boss = who.isAdmin || who.isCreator;
  if (boss) return true;
  if (!who.isAssignee) return false;
  if (from === "new" && to === "in_progress") return true;
  if ((from === "new" || from === "in_progress") && to === (needsReview ? "review" : "done")) return true;
  if (from === "review" && to === "in_progress") return true; // took it back to fix something
  return false;
}

export function isOverdue(t: { status: string; dueAt: Date | null }, now: Date): boolean {
  return !!t.dueAt && OPEN.includes(t.status as TaskStatus) && t.dueAt < now;
}

/** When the assignee finished — the review wait is not their delay. */
export const finishedAt = (t: { submittedAt: Date | null; completedAt: Date | null }) => t.submittedAt ?? t.completedAt;

const TZ_MS = 6 * 3600_000; // Asia/Bishkek, no DST
/** Next due date for a recurring task, never in the past relative to `now`. */
export function nextDue(due: Date, repeat: Repeat, now: Date): Date {
  let d = new Date(due);
  const step = () => {
    if (repeat === "daily") d = new Date(d.getTime() + 86400_000);
    else if (repeat === "weekly") d = new Date(d.getTime() + 7 * 86400_000);
    else {
      // Same local day next month; 31st → last day of a shorter month.
      const l = new Date(d.getTime() + TZ_MS);
      const day = l.getUTCDate();
      const n = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, 1, l.getUTCHours(), l.getUTCMinutes()));
      const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
      n.setUTCDate(Math.min(day, last));
      d = new Date(n.getTime() - TZ_MS);
    }
  };
  step();
  for (let i = 0; i < 400 && d < now; i++) step();
  return d;
}

export interface EffTask {
  assigneeStaffId: number | null; status: string; dueAt: Date | null;
  submittedAt: Date | null; completedAt: Date | null; returnedCount: number;
}
export interface Efficiency {
  staffId: number; total: number; done: number; open: number; cancelled: number;
  onTime: number; late: number; overdueOpen: number; returned: number;
  avgDelayHours: number | null;
  /** % of deadline tasks finished on time, counting still-open overdue ones as misses; null when nothing is due yet. */
  score: number | null;
}

export function efficiency(tasks: EffTask[], now: Date): Efficiency[] {
  const by = new Map<number, EffTask[]>();
  for (const t of tasks) if (t.assigneeStaffId != null) by.set(t.assigneeStaffId, [...(by.get(t.assigneeStaffId) ?? []), t]);
  return [...by.entries()].map(([staffId, list]) => {
    const e: Efficiency = { staffId, total: list.length, done: 0, open: 0, cancelled: 0, onTime: 0, late: 0, overdueOpen: 0, returned: 0, avgDelayHours: null, score: null };
    let delay = 0;
    for (const t of list) {
      e.returned += t.returnedCount;
      if (t.status === "cancelled") { e.cancelled++; continue; }
      const fin = finishedAt(t);
      if (t.status === "done" || (t.status === "review" && fin)) {
        if (t.status === "done") e.done++; else e.open++;
        if (t.dueAt && fin) {
          if (fin <= t.dueAt) e.onTime++;
          else { e.late++; delay += fin.getTime() - t.dueAt.getTime(); }
        }
        continue;
      }
      e.open++;
      if (isOverdue(t, now)) e.overdueOpen++;
    }
    const counted = e.onTime + e.late + e.overdueOpen;
    e.score = counted ? Math.round((e.onTime / counted) * 100) : null;
    e.avgDelayHours = e.late ? Math.round((delay / e.late / 3600_000) * 10) / 10 : null;
    return e;
  });
}
