import { describe, it, expect } from "vitest";
import {
  convert, normalizeUnit, unitsCompatible, netAndOutput, costCard, pricing,
  rawRequirements, portionsAvailable, weightedPrice, stockUnitFor, type CardInfo, type ItemInfo,
} from "../lib/techCardMath";

const items = new Map<number, ItemInfo>([
  [1, { id: 1, name: "Говядина", unit: "кг", pricePerUnit: 800 }],
  [2, { id: 2, name: "Лук", unit: "кг", pricePerUnit: 50 }],
  [3, { id: 3, name: "Сливки 33%", unit: "л", pricePerUnit: 400 }],
  [4, { id: 4, name: "Яйцо", unit: "шт", pricePerUnit: 12 }],
  [5, { id: 5, name: "Водка", unit: "л", pricePerUnit: 900 }],
]);

function card(id: number, kind: string, outputQty: number, outputUnit: string, ingredients: CardInfo["ingredients"], salePrice: number | null = null): CardInfo {
  return { id, name: `card${id}`, kind, outputQty, outputUnit, salePrice, ingredients };
}
const ing = (p: Partial<CardInfo["ingredients"][number]>) => ({ itemId: null, semiCardId: null, grossQty: 0, unit: "г", coldLossPct: 0, hotLossPct: 0, ...p });

describe("units", () => {
  it("converts within a family and normalises legacy spellings", () => {
    expect(convert(250, "г", "кг")).toBe(0.25);
    expect(convert(1.5, "л", "мл")).toBe(1500);
    expect(normalizeUnit("Кг.")).toBe("кг");
    expect(normalizeUnit("литр")).toBe("л");
    expect(unitsCompatible("г", "кг")).toBe(true);
    expect(unitsCompatible("г", "мл")).toBe(false);
  });

  it("refuses to mix mass, volume and pieces", () => {
    expect(() => convert(1, "г", "мл")).toThrow();
    expect(() => convert(1, "шт", "кг")).toThrow();
    expect(() => convert(1, "ведро", "кг")).toThrow();
  });

  it("applies cold then hot losses", () => {
    const { net, output } = netAndOutput(200, 10, 25);
    expect(net).toBeCloseTo(180);
    expect(output).toBeCloseTo(135);
  });
});

describe("costCard", () => {
  it("costs raw ingredients with unit conversion", () => {
    const cards = new Map([[10, card(10, "dish", 250, "г", [
      ing({ itemId: 1, grossQty: 200, unit: "г" }), // 0.2 кг × 800 = 160
      ing({ itemId: 2, grossQty: 50, unit: "г" }),  // 0.05 × 50 = 2.5
      ing({ itemId: 4, grossQty: 2, unit: "шт" }),  // 24
    ])]]);
    const r = costCard(10, cards, items);
    expect(r.errors).toEqual([]);
    expect(r.cost).toBe(186.5);
  });

  it("costs a semi-finished ingredient per unit of its output", () => {
    // Соус: 0.5 л сливок (200) + 2 яйца (24) = 224 сом за 500 мл выхода
    const cards = new Map([
      [20, card(20, "semi", 500, "мл", [ing({ itemId: 3, grossQty: 0.5, unit: "л" }), ing({ itemId: 4, grossQty: 2, unit: "шт" })])],
      [21, card(21, "dish", 300, "г", [ing({ itemId: 1, grossQty: 150, unit: "г" }), ing({ semiCardId: 20, grossQty: 50, unit: "мл" })])],
    ]);
    const r = costCard(21, cards, items);
    expect(r.errors).toEqual([]);
    expect(r.cost).toBeCloseTo(120 + 22.4, 2);
  });

  it("reports incompatible units and cycles instead of crashing", () => {
    const cards = new Map([
      [30, card(30, "semi", 100, "г", [ing({ semiCardId: 31, grossQty: 10, unit: "г" })])],
      [31, card(31, "semi", 100, "г", [ing({ semiCardId: 30, grossQty: 10, unit: "г" })])],
      [32, card(32, "dish", 100, "г", [ing({ itemId: 3, grossQty: 100, unit: "г" })])],
    ]);
    expect(costCard(30, cards, items).errors.join(" ")).toMatch(/Циклическая/);
    expect(costCard(32, cards, items).errors.join(" ")).toMatch(/Нельзя перевести/);
  });

  it("computes markup and food cost", () => {
    expect(pricing(100, 400)).toEqual({ markupPct: 300, foodCostPct: 25, margin: 300 });
    expect(pricing(100, null).foodCostPct).toBeNull();
  });
});

describe("portions from stock", () => {
  const cards = new Map([
    [40, card(40, "semi", 1000, "мл", [ing({ itemId: 3, grossQty: 1, unit: "л" })])],
    [41, card(41, "dish", 50, "мл", [ing({ itemId: 5, grossQty: 40, unit: "мл" }), ing({ semiCardId: 40, grossQty: 10, unit: "мл" })])],
  ]);

  it("flattens semi-finished cards into raw stock needs", () => {
    const req = rawRequirements(41, cards, items);
    expect(req.get(5)).toBeCloseTo(0.04); // л водки
    expect(req.get(3)).toBeCloseTo(0.01); // л сливок через полуфабрикат
  });

  it("finds the limiting item", () => {
    const req = rawRequirements(41, cards, items);
    const r = portionsAvailable(req, new Map([[5, 1], [3, 5]]));
    expect(r.portions).toBe(25);
    expect(r.limitingItemIds).toEqual([5]);
    expect(portionsAvailable(req, new Map([[3, 5]])).portions).toBe(0);
  });
});

describe("semi-finished stock", () => {
  it("takes a produced semi from its stock item instead of raw ingredients", () => {
    const withStock = new Map(items);
    withStock.set(99, { id: 99, name: "Соус (п/ф)", unit: "л", pricePerUnit: 500 });
    const cards = new Map([
      [50, { ...card(50, "semi", 1000, "мл", [ing({ itemId: 3, grossQty: 1, unit: "л" })]), outputItemId: 99 }],
      [51, card(51, "dish", 50, "мл", [ing({ itemId: 5, grossQty: 40, unit: "мл" }), ing({ semiCardId: 50, grossQty: 10, unit: "мл" })])],
    ]);
    const req = rawRequirements(51, cards, withStock);
    expect(req.get(99)).toBeCloseTo(0.01);
    expect(req.has(3)).toBe(false);
  });

  it("weighted average price and stock unit", () => {
    expect(weightedPrice(2, 100, 2, 200)).toBe(150);
    expect(weightedPrice(0, 100, 3, 200)).toBe(200);
    expect(weightedPrice(-1, 100, 1, 50)).toBe(50);
    expect(stockUnitFor("мл")).toBe("л");
    expect(stockUnitFor("г")).toBe("кг");
    expect(stockUnitFor("шт")).toBe("шт");
  });
});
