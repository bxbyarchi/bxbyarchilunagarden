import { describe, it, expect } from "vitest";
import { auditLineMath, auditTotals } from "../lib/inventoryMath";

describe("inventory math", () => {
  it("classifies lines and values discrepancies", () => {
    expect(auditLineMath(2, null, 450).status).toBe("uncounted");
    expect(auditLineMath(2, 2, 450)).toEqual({ diff: 0, diffValue: 0, status: "ok" });
    expect(auditLineMath(2, 1.7, 450)).toEqual({ diff: -0.3, diffValue: -135, status: "shortage" });
    expect(auditLineMath(0.5, 0.75, 1200)).toEqual({ diff: 0.25, diffValue: 300, status: "surplus" });
  });

  it("treats float noise as no discrepancy", () => {
    expect(auditLineMath(0.3, 0.1 + 0.2, 1000).status).toBe("ok");
  });

  it("totals shortage and surplus separately", () => {
    const t = auditTotals([
      auditLineMath(2, 1.7, 450),   // −135
      auditLineMath(0.5, 0.75, 1200), // +300
      auditLineMath(1, 1, 100),
      auditLineMath(1, null, 100),
    ]);
    expect(t).toEqual({ total: 4, counted: 3, withDiff: 2, shortageValue: 135, surplusValue: 300, balance: 165 });
  });
});
