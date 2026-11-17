import { describe, it, expect } from "vitest";
import { canTransition, isOverdue, nextDue, efficiency, type EffTask } from "../lib/taskMath";

const at = (s: string) => new Date(`${s}:00+06:00`);
const assignee = { isAdmin: false, isCreator: false, isAssignee: true };
const creator = { isAdmin: false, isCreator: true, isAssignee: false };
const stranger = { isAdmin: false, isCreator: false, isAssignee: false };

describe("task transitions", () => {
  it("assignee works the task but cannot accept it", () => {
    expect(canTransition("new", "in_progress", assignee, true)).toBe(true);
    expect(canTransition("in_progress", "review", assignee, true)).toBe(true);
    expect(canTransition("in_progress", "done", assignee, true)).toBe(false);
    expect(canTransition("in_progress", "done", assignee, false)).toBe(true);
    expect(canTransition("review", "done", assignee, true)).toBe(false);
    expect(canTransition("new", "cancelled", assignee, true)).toBe(false);
  });
  it("creator accepts, returns, cancels; strangers do nothing", () => {
    expect(canTransition("review", "done", creator, true)).toBe(true);
    expect(canTransition("review", "in_progress", creator, true)).toBe(true);
    expect(canTransition("new", "cancelled", creator, true)).toBe(true);
    expect(canTransition("done", "in_progress", creator, true)).toBe(true);
    expect(canTransition("new", "in_progress", stranger, true)).toBe(false);
  });
});

describe("overdue and recurrence", () => {
  it("only open tasks are overdue", () => {
    const now = at("2026-11-17T12:00");
    expect(isOverdue({ status: "in_progress", dueAt: at("2026-11-17T10:00") }, now)).toBe(true);
    expect(isOverdue({ status: "done", dueAt: at("2026-11-17T10:00") }, now)).toBe(false);
    expect(isOverdue({ status: "new", dueAt: null }, now)).toBe(false);
  });
  it("moves the due date forward and skips missed periods", () => {
    const now = at("2026-11-17T08:00");
    expect(nextDue(at("2026-11-17T10:00"), "daily", now).toISOString()).toBe(at("2026-11-18T10:00").toISOString());
    expect(nextDue(at("2026-11-10T10:00"), "daily", now).toISOString()).toBe(at("2026-11-17T10:00").toISOString());
    expect(nextDue(at("2026-11-17T10:00"), "weekly", now).toISOString()).toBe(at("2026-11-24T10:00").toISOString());
    expect(nextDue(at("2026-01-31T09:00"), "monthly", at("2026-01-31T10:00")).toISOString()).toBe(at("2026-02-28T09:00").toISOString());
    expect(nextDue(at("2026-12-15T23:30"), "monthly", now).toISOString()).toBe(at("2027-01-15T23:30").toISOString());
  });
});

describe("efficiency", () => {
  it("scores on-time share, counting open overdue tasks as misses", () => {
    const now = at("2026-11-17T12:00");
    const t = (o: Partial<EffTask>): EffTask => ({ assigneeStaffId: 1, status: "done", dueAt: null, submittedAt: null, completedAt: null, returnedCount: 0, ...o });
    const [e] = efficiency([
      t({ dueAt: at("2026-11-10T18:00"), submittedAt: at("2026-11-10T17:00"), completedAt: at("2026-11-11T09:00") }), // on time (review wait not counted)
      t({ dueAt: at("2026-11-11T18:00"), completedAt: at("2026-11-11T21:00"), returnedCount: 1 }), // late 3h
      t({ status: "in_progress", dueAt: at("2026-11-16T18:00") }), // overdue open
      t({ status: "new", dueAt: at("2026-11-20T18:00") }), // not due yet
      t({ completedAt: at("2026-11-12T10:00") }), // no deadline
      t({ status: "cancelled", dueAt: at("2026-11-01T10:00") }),
    ], now);
    expect(e).toMatchObject({ total: 6, done: 3, open: 2, cancelled: 1, onTime: 1, late: 1, overdueOpen: 1, returned: 1, avgDelayHours: 3, score: 33 });
  });
});
