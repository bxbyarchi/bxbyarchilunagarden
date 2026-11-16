// Mirrors artifacts/api-server/src/lib/techCardMath.ts (server is authoritative;
// this is only for the live preview in the tech-card editor).

export const UNITS = ["г", "кг", "мл", "л", "шт"] as const;
export type Unit = (typeof UNITS)[number];

const INFO: Record<Unit, { family: string; toBase: number }> = {
  г: { family: "mass", toBase: 1 },
  кг: { family: "mass", toBase: 1000 },
  мл: { family: "volume", toBase: 1 },
  л: { family: "volume", toBase: 1000 },
  шт: { family: "piece", toBase: 1 },
};

export function normalizeUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  const u = raw.trim().toLowerCase().replace(/\.$/, "");
  const aliases: Record<string, Unit> = { г: "г", гр: "г", кг: "кг", мл: "мл", л: "л", литр: "л", шт: "шт", ед: "шт" };
  return aliases[u] ?? null;
}

/** Units an ingredient may be entered in, given the stock unit of its source. */
export function compatibleUnits(unit: string): Unit[] {
  const u = normalizeUnit(unit);
  if (!u) return [];
  return UNITS.filter((x) => INFO[x].family === INFO[u].family);
}

export function convert(qty: number, from: string, to: string): number | null {
  const f = normalizeUnit(from), t = normalizeUnit(to);
  if (!f || !t || INFO[f].family !== INFO[t].family) return null;
  return (qty * INFO[f].toBase) / INFO[t].toBase;
}

/** The small unit of a family, for entering recipe quantities: кг → г, л → мл. */
export function recipeUnit(unit: string): Unit {
  const u = normalizeUnit(unit);
  if (u === "кг") return "г";
  if (u === "л") return "мл";
  return u ?? "г";
}

export const fmtMoney = (v: number | null | undefined) =>
  v == null ? "—" : `${v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} сом`;
export const fmtQty = (v: number | null | undefined, digits = 3) =>
  v == null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
