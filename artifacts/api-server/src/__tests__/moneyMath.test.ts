import { describe, it, expect } from "vitest";
import { allowedActions, estimateTotal, spentTotal, settlementOf, isReportOverdue } from "../lib/moneyMath";

const cook = { role: "warehouse", isRequester: true, isHolder: true };
const manager = { role: "manager", isRequester: false, isHolder: false };
const accountant = { role: "accountant", isRequester: false, isHolder: false };

describe("money request rules", () => {
  it("managers approve, nobody approves their own request except the owner", () => {
    expect(allowedActions("advance", "pending", manager)).toEqual(["approve", "reject", "cancel"]);
    expect(allowedActions("advance", "pending", { ...manager, isRequester: true })).toEqual(["cancel"]);
    expect(allowedActions("advance", "pending", { role: "super_admin", isRequester: true, isHolder: false })).toContain("approve");
    expect(allowedActions("advance", "pending", cook)).toEqual(["cancel"]);
    expect(allowedActions("advance", "pending", accountant)).toEqual([]);
  });
  it("accounting issues advances and pays invoices", () => {
    expect(allowedActions("advance", "approved", accountant)).toEqual(["issue"]);
    expect(allowedActions("payment", "approved", accountant)).toEqual(["pay"]);
    expect(allowedActions("reimbursement", "approved", accountant)).toEqual(["pay"]);
    expect(allowedActions("advance", "approved", manager)).toEqual(["cancel"]);
  });
  it("the holder reports, accounting closes or returns the report", () => {
    expect(allowedActions("advance", "issued", cook)).toEqual(["report"]);
    expect(allowedActions("advance", "issued", manager)).toEqual([]);
    expect(allowedActions("advance", "reported", accountant)).toEqual(["close", "return_report"]);
    expect(allowedActions("advance", "reported", cook)).toEqual([]);
    expect(allowedActions("advance", "closed", accountant)).toEqual([]);
  });
  it("totals and settlement", () => {
    expect(estimateTotal([{ qty: 2.5, price: 120 }, { qty: 3, price: 99.99 }])).toBe(599.97);
    expect(spentTotal([{ amount: 1200 }, { amount: 349.5 }])).toBe(1549.5);
    expect(settlementOf(2000, 1549.5)).toBe(450.5);
    expect(settlementOf(1500, 1700)).toBe(-200);
  });
  it("flags advances not reported in time", () => {
    expect(isReportOverdue({ kind: "advance", status: "issued", reportDueAt: "2026-11-15" }, "2026-11-17")).toBe(true);
    expect(isReportOverdue({ kind: "advance", status: "reported", reportDueAt: "2026-11-15" }, "2026-11-17")).toBe(false);
  });
});
