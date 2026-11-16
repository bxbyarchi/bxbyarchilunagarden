import { describe, it, expect } from "vitest";
import { normalizePhone, formatPhone, overlaps, freeTables, suggestTables, type TableInfo } from "../lib/bookingMath";

describe("phones", () => {
  it("normalises the usual Kyrgyz spellings to one form", () => {
    for (const p of ["0555 12-34-56", "+996 555 123 456", "555123456", "996555123456", "00996555123456"]) expect(normalizePhone(p)).toBe("996555123456");
    expect(normalizePhone("+7 701 123 45 67")).toBe("77011234567");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(formatPhone("996555123456")).toBe("+996 555 123 456");
  });
});

const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m);
const tables: TableInfo[] = [
  { id: 1, name: "1", zone: "Зал", seats: 2 },
  { id: 2, name: "2", zone: "Зал", seats: 4 },
  { id: 3, name: "3", zone: "Зал", seats: 6 },
  { id: 4, name: "В1", zone: "Веранда", seats: 4 },
  { id: 5, name: "В2", zone: "Веранда", seats: 4 },
];

describe("bookings", () => {
  it("treats back-to-back bookings as not overlapping", () => {
    expect(overlaps({ startsAt: at(18), durationMin: 120 }, { startsAt: at(20), durationMin: 60 })).toBe(false);
    expect(overlaps({ startsAt: at(18), durationMin: 120 }, { startsAt: at(19, 30), durationMin: 60 })).toBe(true);
  });

  it("excludes tables busy during the slot, except the booking being edited", () => {
    const busy = [{ id: 10, tableIds: [2, 3], startsAt: at(19), durationMin: 120 }];
    expect(freeTables(tables, busy, { startsAt: at(20), durationMin: 120 }).map((t) => t.id)).toEqual([1, 4, 5]);
    expect(freeTables(tables, busy, { startsAt: at(21), durationMin: 60 }).map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(freeTables(tables, busy, { startsAt: at(20), durationMin: 60 }, 10)).toHaveLength(5);
  });

  it("suggests the smallest fitting table, or joins tables in one zone", () => {
    expect(suggestTables(tables, 3)!.map((t) => t.id)).toEqual([2]);
    expect(suggestTables(tables, 8)!.map((t) => t.id).sort()).toEqual([4, 5]);
    expect(suggestTables(tables, 10)!.map((t) => t.id)).toEqual([3, 2]);
    expect(suggestTables(tables, 30)).toBeNull();
    expect(suggestTables(tables, 2, "Веранда")!.map((t) => t.id)).toEqual([4]);
  });
});
