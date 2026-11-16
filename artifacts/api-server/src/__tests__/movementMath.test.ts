import { describe, it, expect } from "vitest";
import { buildMovement, columnOf } from "../lib/movementMath";

describe("stock movement report", () => {
  it("maps ledger kinds to report columns", () => {
    expect(columnOf("telegram_receipt")).toBe("receipts");
    expect(columnOf("production_out")).toBe("production");
    expect(columnOf("sale_return")).toBe("sales");
    expect(columnOf("something_new")).toBe("adjustments");
  });

  it("opening + period movements = closing, per item and department", () => {
    const rows = buildMovement([
      { itemId: 1, locationId: 3, kind: "opening", inRange: false, delta: 5 },
      { itemId: 1, locationId: 3, kind: "sale", inRange: false, delta: -1 },
      { itemId: 1, locationId: 3, kind: "receipt", inRange: true, delta: 2 },
      { itemId: 1, locationId: 3, kind: "sale", inRange: true, delta: -0.9 },
      { itemId: 1, locationId: 3, kind: "sale_return", inRange: true, delta: 0.3 },
      { itemId: 1, locationId: 3, kind: "inventory", inRange: true, delta: -0.4 },
      { itemId: 2, locationId: 2, kind: "receipt", inRange: true, delta: 1 },
    ]);
    const beef = rows.find((r) => r.itemId === 1)!;
    expect(beef.opening).toBe(4);
    expect(beef.columns).toMatchObject({ receipts: 2, sales: -0.6, adjustments: -0.4 });
    expect(beef.closing).toBe(5);
    expect(rows.find((r) => r.itemId === 2)).toMatchObject({ opening: 0, closing: 1 });
  });

  it("counts ledger opening balances as the start even when recorded inside the period", () => {
    const [r] = buildMovement([{ itemId: 1, locationId: 3, kind: "opening", inRange: true, delta: 4.7 }, { itemId: 1, locationId: 3, kind: "receipt", inRange: true, delta: 2 }]);
    expect(r.opening).toBe(4.7);
    expect(r.columns.adjustments).toBe(0);
    expect(r.closing).toBe(6.7);
  });

  it("drops rows that never had stock", () => {
    expect(buildMovement([{ itemId: 9, locationId: 1, kind: "receipt", inRange: false, delta: 0 }])).toEqual([]);
  });
});
