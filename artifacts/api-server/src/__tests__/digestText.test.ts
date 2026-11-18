import { describe, it, expect } from "vitest";
import { plural, pctChange } from "../lib/digest";
import { plainText } from "../lib/teamBot";

describe("telegram texts", () => {
  it("russian plurals", () => {
    expect([1, 2, 5, 11, 21, 23, 112].map((n) => plural(n, "гость", "гостя", "гостей"))).toEqual(["гость", "гостя", "гостей", "гостей", "гость", "гостя", "гостей"]);
  });
  it("change vs last week", () => {
    expect(pctChange(110, 100)).toBe(" (+10% к прошлой неделе)");
    expect(pctChange(90, 100)).toBe(" (-10% к прошлой неделе)");
    expect(pctChange(100, 0)).toBe("");
  });
  it("turns Markdown answers into readable Telegram text", () => {
    const md = "## Итог\n\n**Выручка** выросла.\n\n| Показатель | Значение |\n|---|---|\n| Выручка | 12 400 сом |\n\n- пункт один\n- пункт два\n\n_Ответила резервная модель_";
    expect(plainText(md)).toBe("Итог\n\nВыручка выросла.\n\nПоказатель — Значение\nВыручка — 12 400 сом\n• пункт один\n• пункт два\n\nОтветила резервная модель");
  });
});
