import { describe, it, expect } from "vitest";
import { reportUrl, shrink, REPORT_NAMES } from "../lib/advisor/reports";

describe("advisor reports", () => {
  it("builds report URLs with only the params a report takes", () => {
    expect(reportUrl("sales_margin", { from: "2026-11-01", to: "2026-11-16", q: null })).toBe("/api/reports/sales-margin?from=2026-11-01&to=2026-11-16");
    expect(reportUrl("low_stock", { from: "2026-11-01", to: "2026-11-16", q: "x" })).toBe("/api/analytics/low-stock");
    expect(reportUrl("stock_items", { from: null, to: null, q: "мука" })).toBe("/api/items?search=%D0%BC%D1%83%D0%BA%D0%B0");
    expect(reportUrl("tasks_overdue", { from: null, to: null, q: null })).toBe("/api/tasks?view=all&status=overdue");
    expect(reportUrl("nope", { from: null, to: null, q: null })).toBeNull();
    expect(REPORT_NAMES.length).toBeGreaterThan(10);
  });
  it("shrinks big reports and drops account ids", () => {
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ name: `Блюдо ${i}`, revenue: i * 1.23456, creatorClerkId: "u_x" })) };
    const s = shrink(big, 5000);
    expect(s.length).toBeLessThanOrEqual(5000);
    expect(s).toContain("ещё");
    expect(s).not.toContain("u_x");
    expect(JSON.parse(shrink({ a: 1.23456 }))).toEqual({ a: 1.23 });
  });
});
