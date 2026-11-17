import { describe, it, expect } from "vitest";
import { parseLine, parseAmount } from "../lib/teamBotParse";

describe("telegram receipt lines", () => {
  it("reads name and amount in any order", () => {
    expect(parseLine("Мука высший сорт 450")).toEqual({ name: "Мука высший сорт", amount: 450 });
    expect(parseLine("Сливки — 1 640 сом")).toEqual({ name: "Сливки", amount: 1640 });
    expect(parseLine("Зелень: 99,5")).toEqual({ name: "Зелень", amount: 99.5 });
    expect(parseLine("450 мука")).toEqual({ name: "мука", amount: 450 });
    expect(parseLine("1200")).toEqual({ name: "Покупка", amount: 1200 });
    expect(parseLine("купил муку")).toBeNull();
  });
  it("reads amounts", () => {
    expect(parseAmount("2 500")).toBe(2500);
    expect(parseAmount("3000 сом")).toBe(3000);
    expect(parseAmount("12,75")).toBe(12.75);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("много")).toBeNull();
  });
});
