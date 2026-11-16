import { describe, it, expect } from "vitest";
import { saleWriteOffs, restockShare, refundAmount } from "../lib/saleWriteOff";
import type { CardInfo, ItemInfo } from "../lib/techCardMath";

const items = new Map<number, ItemInfo>([
  [1, { id: 1, name: "Говядина", unit: "кг", pricePerUnit: 1200 }],
  [2, { id: 2, name: "Водка", unit: "л", pricePerUnit: 900 }],
  [3, { id: 3, name: "Сок", unit: "л", pricePerUnit: 150 }],
  [4, { id: 4, name: "Вода 0.5", unit: "шт", pricePerUnit: 30 }],
  [9, { id: 9, name: "Соус (п/ф)", unit: "л", pricePerUnit: 600 }],
]);
const ing = (p: Partial<CardInfo["ingredients"][number]>) => ({ itemId: null, semiCardId: null, grossQty: 0, unit: "г", coldLossPct: 0, hotLossPct: 0, ...p });
const cards = new Map<number, CardInfo>([
  [10, { id: 10, name: "Стейк", kind: "dish", outputQty: 250, outputUnit: "г", salePrice: 1290, departmentId: 3, ingredients: [ing({ itemId: 1, grossQty: 300, unit: "г" }), ing({ semiCardId: 11, grossQty: 50, unit: "мл" })] }],
  [11, { id: 11, name: "Соус", kind: "semi", outputQty: 500, outputUnit: "мл", salePrice: null, outputItemId: 9, departmentId: 3, ingredients: [] }],
  [12, { id: 12, name: "Отвёртка", kind: "dish", outputQty: 200, outputUnit: "мл", salePrice: 350, departmentId: 2, ingredients: [ing({ itemId: 2, grossQty: 50, unit: "мл" }), ing({ itemId: 3, grossQty: 150, unit: "мл" })] }],
]);
const product = (p: Partial<Parameters<typeof saleWriteOffs>[0]>) => ({ id: 1, techCardId: null, itemId: null, itemQty: 1, writeOffLocationId: null, ...p });

describe("sale write-offs", () => {
  it("writes off a dish by its tech card from the card's department, semis from stock", () => {
    const w = saleWriteOffs(product({ techCardId: 10 }), 2, 8, cards, items);
    expect(w).toEqual([
      { itemId: 1, locationId: 3, qty: 0.6, unitCost: 1200 },
      { itemId: 9, locationId: 3, qty: 0.1, unitCost: 600 },
    ]);
  });

  it("honours a per-product write-off location", () => {
    const w = saleWriteOffs(product({ techCardId: 12, writeOffLocationId: 5 }), 1, 8, cards, items);
    expect(w.every((x) => x.locationId === 5)).toBe(true);
    expect(w.find((x) => x.itemId === 2)?.qty).toBe(0.05);
  });

  it("writes off a resale item from the point of sale, and nothing for unlinked positions", () => {
    expect(saleWriteOffs(product({ itemId: 4, itemQty: 1 }), 3, 8, cards, items)).toEqual([{ itemId: 4, locationId: 8, qty: 3, unitCost: 30 }]);
    expect(saleWriteOffs(product({}), 3, 8, cards, items)).toEqual([]);
  });
});

describe("returns", () => {
  it("restocks pro rata", () => {
    const back = restockShare([{ itemId: 1, locationId: 3, qty: 0.6, unitCost: 1200 }], 2, 1);
    expect(back).toEqual([{ itemId: 1, locationId: 3, qty: 0.3, unitCost: 1200 }]);
    expect(restockShare([{ itemId: 1, locationId: 3, qty: 0.6, unitCost: 1200 }], 2, 5)[0].qty).toBe(0.6);
  });

  it("refunds what was actually paid after the receipt discount", () => {
    expect(refundAmount(1, 1290, 0)).toBe(1290);
    expect(refundAmount(2, 350, 10)).toBe(630);
    expect(refundAmount(1, 99.99, 15)).toBe(84.99);
  });
});
