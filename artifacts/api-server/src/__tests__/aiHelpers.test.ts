import { describe, it, expect } from "vitest";
import { localDateTime, toLocal, depositFor, costUsd, nearbyTimes } from "../lib/ai/helpers";

describe("AI agent helpers", () => {
  it("reads and prints times in Bishkek time regardless of server timezone", () => {
    const d = localDateTime("2026-11-18", "19:30")!;
    expect(d.toISOString()).toBe("2026-11-18T13:30:00.000Z");
    expect(toLocal(d)).toMatchObject({ date: "2026-11-18", time: "19:30" });
    expect(toLocal(new Date("2026-11-18T20:30:00Z"))).toMatchObject({ date: "2026-11-19", time: "02:30" });
    expect(localDateTime("18.11.2026", "19:30")).toBeNull();
    expect(localDateTime("2026-11-18", "25:00")).toBeNull();
  });

  it("computes the deposit only from the configured threshold", () => {
    expect(depositFor(6, 8, 500)).toBe(0);
    expect(depositFor(8, 8, 500)).toBe(4000);
    expect(depositFor(20, null, 500)).toBe(0);
    expect(depositFor(20, 8, null)).toBe(0);
  });

  it("prices tokens per model", () => {
    expect(costUsd("claude-opus-5-5", 10_000, 1_000)).toBe(0.06);
    expect(costUsd("claude-haiku-5-5", 10_000, 1_000)).toBe(0.0015);
  });

  it("offers nearest alternative times first", () => {
    const t = nearbyTimes(localDateTime("2026-11-18", "19:00")!).map((d) => toLocal(d).time);
    expect(t.slice(0, 4)).toEqual(["18:30", "19:30", "18:00", "20:00"]);
    expect(t).toHaveLength(8);
  });
});
