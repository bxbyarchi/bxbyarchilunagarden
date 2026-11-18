import { describe, it, expect } from "vitest";
import { findNoShows, findForgottenCheckouts } from "../lib/attendanceAlerts";

const at = (s: string) => new Date(`${s}:00+06:00`);
const plan = (id: number, staffId: number, date: string, s: string, e: string, notified: Date | null = null) => ({ id, staffId, date, startTime: s, endTime: e, noShowNotifiedAt: notified });

describe("no-show alerts", () => {
  const plans = [plan(1, 1, "2026-11-18", "10:00", "22:00"), plan(2, 2, "2026-11-18", "10:00", "22:00"), plan(3, 3, "2026-11-18", "12:00", "00:00"), plan(4, 4, "2026-11-18", "10:00", "22:00", at("2026-11-18T10:20"))];
  it("alerts only after the grace period, while the shift runs, once", () => {
    const presence = [{ staffId: 2, checkInAt: at("2026-11-18T09:52"), checkOutAt: null }];
    expect(findNoShows(plans, presence, at("2026-11-18T10:10")).map((x) => x.plan.id)).toEqual([]);
    expect(findNoShows(plans, presence, at("2026-11-18T10:20")).map((x) => x.plan.id)).toEqual([1]);
    expect(findNoShows(plans, presence, at("2026-11-18T12:30")).map((x) => [x.plan.id, x.lateMin])).toEqual([[1, 150], [3, 30]]);
    expect(findNoShows(plans, presence, at("2026-11-18T22:30")).map((x) => x.plan.id)).toEqual([3]); // overnight shift still running
  });
  it("does not alert when the person came and left before the check", () => {
    const presence = [{ staffId: 1, checkInAt: at("2026-11-18T10:05"), checkOutAt: at("2026-11-18T10:40") }];
    expect(findNoShows([plans[0]], presence, at("2026-11-18T11:00"))).toEqual([]);
  });
});

describe("forgotten check-out", () => {
  const plans = [plan(1, 1, "2026-11-18", "10:00", "22:00")];
  const open = (staffId: number, inAt: string, reminded: Date | null = null) => ({ id: staffId, staffId, checkInAt: at(inAt), checkOutAt: null, checkoutRemindedAt: reminded });
  it("reminds two hours after the shift end, or after 14 h without a shift", () => {
    expect(findForgottenCheckouts([open(1, "2026-11-18T09:58")], plans, at("2026-11-18T23:30"))).toHaveLength(0);
    expect(findForgottenCheckouts([open(1, "2026-11-18T09:58")], plans, at("2026-11-19T00:05"))).toHaveLength(1);
    expect(findForgottenCheckouts([open(2, "2026-11-18T08:00")], plans, at("2026-11-18T23:00"))).toHaveLength(0);
    expect(findForgottenCheckouts([open(2, "2026-11-18T08:00")], plans, at("2026-11-19T00:00"))).toHaveLength(1);
    expect(findForgottenCheckouts([open(1, "2026-11-18T09:58", at("2026-11-19T00:05"))], plans, at("2026-11-19T03:00"))).toHaveLength(0);
  });
});
