/**
 * Pure timesheet math: planned shifts (schedule) vs. actual presence (attendance).
 * All dates/times are in restaurant time (Asia/Bishkek, UTC+6, no DST).
 */
import { localDateTime, toLocal } from "./ai/helpers";

export interface PlanRow { id: number; staffId: number; date: string; startTime: string; endTime: string }
export interface PresenceRow { id: number; staffId: number; checkInAt: Date; checkOutAt: Date | null }
export interface Rates { hourlyRate: number | null; shiftRate: number | null }

export interface TimesheetOptions {
  now: Date;
  /** Minutes of lateness that are forgiven. */
  graceMin?: number;
  /** An open check-in older than this is "forgotten": not counted, flagged. */
  maxShiftHours?: number;
  /** Overtime smaller than this per shift is ignored (changing clothes, handover). */
  overtimeMinMin?: number;
}

export interface PlanResult {
  planId: number; date: string; start: Date; end: Date;
  attendanceIds: number[]; workedMin: number; lateMin: number; earlyLeaveMin: number; overtimeMin: number;
  status: "upcoming" | "missing" | "in_progress" | "done" | "absent";
}

export interface StaffSummary {
  staffId: number;
  plannedShifts: number; plannedMin: number;
  workedDays: number; workedMin: number;
  lateCount: number; lateMin: number; earlyLeaveMin: number;
  overtimeMin: number; absences: number; unplannedShifts: number; forgottenCheckouts: number;
  pay: number;
  plans: PlanResult[];
}

/** Planned shift window; an end at or before the start means it ends the next day. */
export function planWindow(date: string, startTime: string, endTime: string): { start: Date; end: Date } | null {
  const start = localDateTime(date, startTime);
  let end = localDateTime(date, endTime);
  if (!start || !end) return null;
  if (end <= start) end = new Date(end.getTime() + 24 * 3600_000);
  return { start, end };
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** Effective end of a presence row; null when it is a forgotten check-out. */
function effectiveEnd(p: PresenceRow, now: Date, maxShiftMs: number): Date | null {
  if (p.checkOutAt) return p.checkOutAt;
  return now.getTime() - p.checkInAt.getTime() <= maxShiftMs ? now : null;
}

export function summarize(staffIds: number[], plans: PlanRow[], presence: PresenceRow[], rates: Map<number, Rates>, opts: TimesheetOptions): StaffSummary[] {
  const grace = opts.graceMin ?? 5;
  const maxShiftMs = (opts.maxShiftHours ?? 16) * 3600_000;
  const otMin = opts.overtimeMinMin ?? 15;
  const now = opts.now;

  return staffIds.map((staffId) => {
    const myPlans = plans.filter((p) => p.staffId === staffId)
      .map((p) => ({ p, w: planWindow(p.date, p.startTime, p.endTime) }))
      .filter((x): x is { p: PlanRow; w: { start: Date; end: Date } } => !!x.w)
      .sort((a, b) => a.w.start.getTime() - b.w.start.getTime());
    const mine = presence.filter((a) => a.staffId === staffId).sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());

    // Attach each presence to the plan it overlaps most (or whose start is within 4h of the check-in).
    const byPlan = new Map<number, PresenceRow[]>();
    const unplanned: PresenceRow[] = [];
    for (const a of mine) {
      const end = effectiveEnd(a, now, maxShiftMs) ?? a.checkInAt;
      let best: { id: number; score: number } | null = null;
      for (const { p, w } of myPlans) {
        const overlap = Math.min(end.getTime(), w.end.getTime()) - Math.max(a.checkInAt.getTime(), w.start.getTime());
        const near = Math.abs(a.checkInAt.getTime() - w.start.getTime()) <= 4 * 3600_000;
        const score = overlap > 0 ? overlap : near ? 0 : -1;
        if (score >= 0 && (!best || score > best.score)) best = { id: p.id, score };
      }
      if (best) byPlan.set(best.id, [...(byPlan.get(best.id) ?? []), a]);
      else unplanned.push(a);
    }

    const r: StaffSummary = {
      staffId, plannedShifts: myPlans.length, plannedMin: 0, workedDays: 0, workedMin: 0, lateCount: 0, lateMin: 0, earlyLeaveMin: 0,
      overtimeMin: 0, absences: 0, unplannedShifts: 0, forgottenCheckouts: 0, pay: 0, plans: [],
    };
    const days = new Set<string>();
    const worked = (a: PresenceRow) => {
      const end = effectiveEnd(a, now, maxShiftMs);
      if (!end) { r.forgottenCheckouts++; return 0; }
      days.add(toLocal(a.checkInAt).date);
      return minutes(end.getTime() - a.checkInAt.getTime());
    };

    for (const { p, w } of myPlans) {
      const planned = minutes(w.end.getTime() - w.start.getTime());
      r.plannedMin += planned;
      const att = byPlan.get(p.id) ?? [];
      const res: PlanResult = { planId: p.id, date: p.date, start: w.start, end: w.end, attendanceIds: att.map((a) => a.id), workedMin: 0, lateMin: 0, earlyLeaveMin: 0, overtimeMin: 0, status: "upcoming" };
      if (!att.length) {
        res.status = w.end <= now ? "absent" : w.start <= now ? "missing" : "upcoming";
        if (res.status === "absent") r.absences++;
      } else {
        res.workedMin = att.reduce((s, a) => s + worked(a), 0);
        const first = att[0].checkInAt;
        const late = minutes(first.getTime() - w.start.getTime());
        if (late > grace) { res.lateMin = late; r.lateCount++; r.lateMin += late; }
        const last = att[att.length - 1];
        const open = !last.checkOutAt;
        res.status = open ? "in_progress" : "done";
        if (!open) res.earlyLeaveMin = minutes(w.end.getTime() - last.checkOutAt!.getTime());
        r.earlyLeaveMin += res.earlyLeaveMin;
        const ot = res.workedMin - planned;
        if (!open && ot >= otMin) res.overtimeMin = ot;
        r.overtimeMin += res.overtimeMin;
        r.workedMin += res.workedMin;
      }
      r.plans.push(res);
    }
    for (const a of unplanned) {
      const m = worked(a);
      if (m > 0) { r.unplannedShifts++; r.workedMin += m; if (a.checkOutAt) r.overtimeMin += m; }
    }
    r.workedDays = days.size;
    const rate = rates.get(staffId);
    r.pay = Math.round((rate?.hourlyRate ?? 0) * r.workedMin / 60 + (rate?.shiftRate ?? 0) * r.workedDays);
    return r;
  });
}

/** Monday (yyyy-mm-dd) of the week containing the given local date. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
