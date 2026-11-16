import { describe, it, expect } from "vitest";
import { aggregateMargin, type MarginLine } from "../lib/marginMath";

const line = (p: Partial<MarginLine>): MarginLine => ({ key: "p1", name: "Стейк", category: "Горячее", day: "2026-11-16", linked: true, soldQty: 1, revenue: 1290, cost: 389, ...p });

describe("margin aggregation", () => {
  it("groups by product, category and day", () => {
    const r = aggregateMargin([
      line({}),
      line({ soldQty: 2, revenue: 2322, cost: 778, day: "2026-11-17" }),
      line({ key: "p2", name: "Отвёртка", category: "Коктейли", revenue: 350, cost: 67.5 }),
    ]);
    expect(r.totals.revenue).toBe(3962);
    expect(r.totals.cost).toBe(1234.5);
    expect(r.totals.margin).toBe(2727.5);
    expect(r.totals.foodCostPct).toBe(31.2);
    expect(r.products[0]).toMatchObject({ name: "Стейк", soldQty: 3, revenue: 3612, cost: 1167 });
    expect(r.categories.map((c) => c.name)).toEqual(["Горячее", "Коктейли"]);
    expect(r.days.map((d) => d.name)).toEqual(["2026-11-16", "2026-11-17"]);
  });

  it("flags positions sold without any stock link", () => {
    const r = aggregateMargin([line({ key: "n:Чай", name: "Чай", linked: false, cost: 0, revenue: 100 })]);
    expect(r.products[0].noCost).toBe(true);
    expect(r.totals.unlinkedRevenue).toBe(100);
  });

  it("handles fully returned lines without dividing by zero", () => {
    const r = aggregateMargin([line({ soldQty: 0, revenue: 0, cost: 0 })]);
    expect(r.products[0].marginPct).toBeNull();
  });
});
