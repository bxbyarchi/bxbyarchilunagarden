/**
 * Pure tech-card math (no DB): units, losses, cost, portions available.
 * Prices of stock items stay per the item's own unit (сом за кг / л / шт),
 * ingredient quantities are entered in any compatible unit and converted.
 */

export const UNITS = ["г", "кг", "мл", "л", "шт"] as const;
export type Unit = (typeof UNITS)[number];

const UNIT_INFO: Record<Unit, { family: "mass" | "volume" | "piece"; toBase: number }> = {
  г: { family: "mass", toBase: 1 },
  кг: { family: "mass", toBase: 1000 },
  мл: { family: "volume", toBase: 1 },
  л: { family: "volume", toBase: 1000 },
  шт: { family: "piece", toBase: 1 },
};

/** Maps legacy free-text units ("кг.", "литр", "pcs") onto a known unit, or null. */
export function normalizeUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  const u = raw.trim().toLowerCase().replace(/\.$/, "");
  const aliases: Record<string, Unit> = {
    г: "г", гр: "г", грамм: "г", g: "г",
    кг: "кг", kg: "кг", килограмм: "кг",
    мл: "мл", ml: "мл",
    л: "л", литр: "л", l: "л",
    шт: "шт", штук: "шт", штука: "шт", pcs: "шт", ед: "шт",
  };
  return aliases[u] ?? null;
}

export function unitsCompatible(a: string, b: string): boolean {
  const ua = normalizeUnit(a), ub = normalizeUnit(b);
  return !!ua && !!ub && UNIT_INFO[ua].family === UNIT_INFO[ub].family;
}

/** Converts qty from one unit to another of the same family. Throws on mismatch. */
export function convert(qty: number, from: string, to: string): number {
  const f = normalizeUnit(from), t = normalizeUnit(to);
  if (!f || !t) throw new Error(`Неизвестная единица: ${!f ? from : to}`);
  if (UNIT_INFO[f].family !== UNIT_INFO[t].family) throw new Error(`Нельзя перевести ${from} в ${to}`);
  return (qty * UNIT_INFO[f].toBase) / UNIT_INFO[t].toBase;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const clampPct = (p: number) => Math.min(Math.max(p, 0), 99.99);

/** Брутто → нетто (холодная обработка) → выход (тепловая обработка). */
export function netAndOutput(gross: number, coldLossPct: number, hotLossPct: number) {
  const net = gross * (1 - clampPct(coldLossPct) / 100);
  const output = net * (1 - clampPct(hotLossPct) / 100);
  return { net, output };
}

// ─── Card graph ──────────────────────────────────────────────────────────────

export interface ItemInfo {
  id: number;
  name: string;
  unit: string;
  pricePerUnit: number;
}

export interface IngredientInput {
  itemId: number | null;
  semiCardId: number | null;
  grossQty: number;
  unit: string;
  coldLossPct: number;
  hotLossPct: number;
}

export interface CardInfo {
  id: number;
  name: string;
  kind: string;
  outputQty: number;
  outputUnit: string;
  salePrice: number | null;
  /** Stock item the semi-finished product is produced into (null = never produced). */
  outputItemId?: number | null;
  ingredients: IngredientInput[];
}

export interface IngredientLine extends IngredientInput {
  name: string;
  net: number;
  output: number;
  cost: number;
  /** Set when the line can't be costed (unknown/incompatible unit, missing item, cycle). */
  error: string | null;
}

export interface CardCost {
  cost: number;
  lines: IngredientLine[];
  /** Problems that made some lines uncostable (cost of those lines counted as 0). */
  errors: string[];
}

export const MAX_DEPTH = 8;

/**
 * Cost of one portion of `cardId`. Semi-finished ingredients are costed
 * recursively (cost of their whole batch ÷ batch output, × the quantity used).
 * Cycles and over-deep nesting produce an error line instead of recursing.
 */
export function costCard(
  cardId: number,
  cards: Map<number, CardInfo>,
  items: Map<number, ItemInfo>,
  stack: number[] = [],
): CardCost {
  const card = cards.get(cardId);
  if (!card) return { cost: 0, lines: [], errors: [`Тех-карта #${cardId} не найдена`] };
  const errors: string[] = [];
  const lines: IngredientLine[] = card.ingredients.map((ing) => {
    const { net, output } = netAndOutput(ing.grossQty, ing.coldLossPct, ing.hotLossPct);
    const base = { ...ing, net, output, cost: 0, name: "—", error: null as string | null };
    try {
      if (ing.itemId != null) {
        const item = items.get(ing.itemId);
        if (!item) throw new Error(`Позиция #${ing.itemId} не найдена`);
        base.name = item.name;
        base.cost = convert(ing.grossQty, ing.unit, item.unit) * item.pricePerUnit;
      } else if (ing.semiCardId != null) {
        const semi = cards.get(ing.semiCardId);
        if (!semi) throw new Error(`Полуфабрикат #${ing.semiCardId} не найден`);
        base.name = semi.name;
        if (semi.id === cardId || stack.includes(semi.id)) throw new Error(`Циклическая ссылка: «${semi.name}»`);
        if (stack.length >= MAX_DEPTH) throw new Error("Слишком глубокая вложенность полуфабрикатов");
        if (!(semi.outputQty > 0)) throw new Error(`У «${semi.name}» не указан выход`);
        const semiCost = costCard(semi.id, cards, items, [...stack, cardId]);
        if (semiCost.errors.length) errors.push(...semiCost.errors.map((e) => `${semi.name}: ${e}`));
        base.cost = (semiCost.cost / semi.outputQty) * convert(ing.grossQty, ing.unit, semi.outputUnit);
      }
    } catch (e) {
      base.error = (e as Error).message;
      errors.push(base.error);
    }
    base.cost = round(base.cost, 4);
    return base;
  });
  const cost = round(lines.reduce((s, l) => s + l.cost, 0), 2);
  return { cost, lines, errors };
}

/** Markup % over cost and food-cost % of price. */
export function pricing(cost: number, salePrice: number | null) {
  if (!salePrice || salePrice <= 0) return { markupPct: null, foodCostPct: null, margin: null };
  return {
    markupPct: cost > 0 ? round(((salePrice - cost) / cost) * 100, 1) : null,
    foodCostPct: round((cost / salePrice) * 100, 1),
    margin: round(salePrice - cost, 2),
  };
}

/**
 * Stock needed for ONE portion (or one batch of a semi): itemId → quantity in
 * the item's own unit. A semi-finished ingredient that has a stock item
 * (it is produced in advance by a production act) is taken from that stock;
 * one that has never been produced is expanded into its own ingredients.
 */
export function rawRequirements(
  cardId: number,
  cards: Map<number, CardInfo>,
  items: Map<number, ItemInfo>,
  factor = 1,
  stack: number[] = [],
  acc: Map<number, number> = new Map(),
): Map<number, number> {
  const card = cards.get(cardId);
  if (!card || stack.includes(cardId) || stack.length > MAX_DEPTH) return acc;
  for (const ing of card.ingredients) {
    try {
      if (ing.itemId != null) {
        const item = items.get(ing.itemId);
        if (!item) continue;
        const qty = convert(ing.grossQty, ing.unit, item.unit) * factor;
        acc.set(item.id, (acc.get(item.id) ?? 0) + qty);
      } else if (ing.semiCardId != null) {
        const semi = cards.get(ing.semiCardId);
        if (!semi) continue;
        const stocked = semi.outputItemId != null ? items.get(semi.outputItemId) : undefined;
        if (stocked) {
          const qty = convert(ing.grossQty, ing.unit, stocked.unit) * factor;
          acc.set(stocked.id, (acc.get(stocked.id) ?? 0) + qty);
          continue;
        }
        if (!(semi.outputQty > 0)) continue;
        const batches = convert(ing.grossQty, ing.unit, semi.outputUnit) / semi.outputQty;
        rawRequirements(semi.id, cards, items, factor * batches, [...stack, cardId], acc);
      }
    } catch {
      // Unconvertible line — reported by costCard; skipped here.
    }
  }
  return acc;
}

/** Stock unit for a semi-finished product's item: the larger unit of its family (г → кг, мл → л). */
export function stockUnitFor(outputUnit: string): Unit {
  const u = normalizeUnit(outputUnit) ?? "шт";
  return u === "г" ? "кг" : u === "мл" ? "л" : u;
}

/** Weighted-average unit price after adding `addQty` at `addPrice` to `oldQty` at `oldPrice`. */
export function weightedPrice(oldQty: number, oldPrice: number, addQty: number, addPrice: number): number {
  const base = Math.max(oldQty, 0);
  const total = base + addQty;
  if (!(total > 0)) return addPrice;
  return (base * oldPrice + addQty * addPrice) / total;
}

/**
 * How many portions the given stock (itemId → qty in item unit) allows, and
 * which items run out first. Returns portions = 0 with the blocking items
 * when something is missing; null when the card has no costed ingredients.
 */
export function portionsAvailable(requirements: Map<number, number>, stock: Map<number, number>) {
  let portions = Infinity;
  const limiting: number[] = [];
  for (const [itemId, need] of requirements) {
    if (!(need > 0)) continue;
    const can = Math.floor(((stock.get(itemId) ?? 0) / need) + 1e-9);
    if (can < portions) { portions = can; limiting.length = 0; limiting.push(itemId); }
    else if (can === portions) limiting.push(itemId);
  }
  return { portions: Number.isFinite(portions) ? portions : null, limitingItemIds: Number.isFinite(portions) ? limiting : [] };
}
