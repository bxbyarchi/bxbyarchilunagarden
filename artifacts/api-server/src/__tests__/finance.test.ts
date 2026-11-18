import { describe, it, expect } from "vitest";
import { buildPnl, previousPeriod } from "../lib/finance";

describe("P&L", () => {
  const p = buildPnl({
    sales: [{ amount: 600_000, method: "cash", checks: 300 }, { amount: 400_000, method: "card", checks: 200 }],
    returns: 10_000, cogs: 330_000,
    writeOffs: [{ reason: "Порча", value: 8_000 }, { reason: "Бой/повреждение", value: 2_000 }, { reason: "Порча", value: 1_000 }],
    payroll: [{ department: "kitchen", pay: 150_000 }, { department: "hall", pay: 90_000 }, { department: null, pay: 10_000 }],
    money: [{ category: "rent", amount: 120_000 }, { category: "goods", amount: 25_000 }, { category: null, amount: 5_000 }, { category: "utilities", amount: 30_000 }],
    purchases: 340_000,
  });
  it("counts revenue, margin and operating profit", () => {
    expect(p).toMatchObject({ revenue: 990_000, checks: 500, avgCheck: 2000, cogs: 330_000, grossProfit: 660_000, foodCostPct: 33.3, grossMarginPct: 66.7 });
    expect(p).toMatchObject({ writeOffs: 11_000, payroll: 250_000, payrollPct: 25.3, otherExpenses: 155_000 });
    expect(p.operatingProfit).toBe(660_000 - 11_000 - 250_000 - 155_000);
  });
  it("keeps stock purchases out of expenses and groups lines", () => {
    expect(p.info).toEqual({ purchases: 340_000, goodsViaMoney: 25_000 });
    expect(p.expensesByCategory.map((x) => [x.key, x.amount])).toEqual([["rent", 120_000], ["utilities", 30_000], ["other", 5_000]]);
    expect(p.writeOffsByReason[0]).toEqual({ key: "Порча", amount: 9_000 });
    expect(p.byMethod.map((x) => x.key)).toEqual(["cash", "card"]);
  });
  it("handles an empty period", () => {
    const e = buildPnl({ sales: [], returns: 0, cogs: 0, writeOffs: [], payroll: [], money: [], purchases: 0 });
    expect(e).toMatchObject({ revenue: 0, avgCheck: null, foodCostPct: null, operatingProfit: 0 });
  });
  it("previous period of the same length", () => {
    expect(previousPeriod("2026-11-01", "2026-11-30")).toEqual({ from: "2026-10-02", to: "2026-10-31" });
    expect(previousPeriod("2026-11-16", "2026-11-22")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });
});
