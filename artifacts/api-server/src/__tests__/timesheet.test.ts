import { describe, it, expect } from "vitest";
import { summarize, planWindow, mondayOf, addDays, type PlanRow, type PresenceRow } from "../lib/timesheet";

const at = (s: string) => new Date(`${s}:00+06:00`);
const rates = new Map([[1, { hourlyRate: 100, shiftRate: null }], [2, { hourlyRate: null, shiftRate: 1500 }]]);

describe("timesheet", () => {
  it("handles overnight planned shifts", () => {
    const w = planWindow("2026-11-16", "18:00", "02:00")!;
    expect(w.start.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-16T20:00:00.000Z");
  });

  it("counts lateness, early leave, overtime and absences", () => {
    const plans: PlanRow[] = [
      { id: 1, staffId: 1, date: "2026-11-10", startTime: "10:00", endTime: "22:00" }, // late 20 min, overtime 50
      { id: 2, staffId: 1, date: "2026-11-11", startTime: "10:00", endTime: "22:00" }, // left 2h early
      { id: 3, staffId: 1, date: "2026-11-12", startTime: "10:00", endTime: "22:00" }, // absent
      { id: 4, staffId: 1, date: "2026-11-20", startTime: "10:00", endTime: "22:00" }, // future
    ];
    const presence: PresenceRow[] = [
      { id: 1, staffId: 1, checkInAt: at("2026-11-10T10:20"), checkOutAt: at("2026-11-10T23:10") },
      { id: 2, staffId: 1, checkInAt: at("2026-11-11T09:55"), checkOutAt: at("2026-11-11T20:00") },
      { id: 3, staffId: 1, checkInAt: at("2026-11-14T12:00"), checkOutAt: at("2026-11-14T16:00") }, // unplanned
    ];
    const [s] = summarize([1], plans, presence, rates, { now: at("2026-11-16T12:00") });
    expect(s.plans.map((p) => p.status)).toEqual(["done", "done", "absent", "upcoming"]);
    expect(s.plans[0]).toMatchObject({ lateMin: 20, overtimeMin: 50, earlyLeaveMin: 0, workedMin: 770 });
    expect(s.plans[1]).toMatchObject({ lateMin: 0, earlyLeaveMin: 120, overtimeMin: 0, workedMin: 605 });
    expect(s).toMatchObject({ plannedShifts: 4, absences: 1, lateCount: 1, lateMin: 20, unplannedShifts: 1, workedDays: 3 });
    expect(s.workedMin).toBe(770 + 605 + 240);
    expect(s.overtimeMin).toBe(50 + 240);
    expect(s.pay).toBe(Math.round(100 * (770 + 605 + 240) / 60));
  });

  it("ignores small lateness/overtime and flags forgotten check-outs", () => {
    const plans: PlanRow[] = [{ id: 1, staffId: 2, date: "2026-11-15", startTime: "10:00", endTime: "18:00" }];
    const presence: PresenceRow[] = [
      { id: 1, staffId: 2, checkInAt: at("2026-11-15T10:04"), checkOutAt: at("2026-11-15T18:10") },
      { id: 2, staffId: 2, checkInAt: at("2026-11-13T10:00"), checkOutAt: null },
    ];
    const [s] = summarize([2], plans, presence, rates, { now: at("2026-11-16T12:00") });
    expect(s).toMatchObject({ lateCount: 0, overtimeMin: 0, forgottenCheckouts: 1, workedDays: 1, pay: 1500 });
  });

  it("counts an open shift up to now while it is in progress", () => {
    const plans: PlanRow[] = [{ id: 1, staffId: 1, date: "2026-11-16", startTime: "10:00", endTime: "22:00" }];
    const presence: PresenceRow[] = [{ id: 1, staffId: 1, checkInAt: at("2026-11-16T10:00"), checkOutAt: null }];
    const [s] = summarize([1], plans, presence, rates, { now: at("2026-11-16T13:30") });
    expect(s.plans[0]).toMatchObject({ status: "in_progress", workedMin: 210, overtimeMin: 0, earlyLeaveMin: 0 });
  });

  it("marks a started shift without check-in as missing", () => {
    const plans: PlanRow[] = [{ id: 1, staffId: 1, date: "2026-11-16", startTime: "10:00", endTime: "22:00" }];
    const [s] = summarize([1], plans, [], rates, { now: at("2026-11-16T10:30") });
    expect(s.plans[0].status).toBe("missing");
    expect(s.absences).toBe(0);
  });

  it("week helpers", () => {
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });
});
