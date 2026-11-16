/** Pure aggregation for the sales margin report. Money in сом. */

export interface MarginLine {
  key: string;        // product id or free-price name
  name: string;
  category: string;
  day: string;        // YYYY-MM-DD
  linked: boolean;    // has a tech card / stock item, i.e. a cost is expected
  soldQty: number;    // net of returns
  revenue: number;    // after receipt discount and refunds
  cost: number;       // actual write-offs, restocks netted
}

export interface MarginRow {
  name: string; soldQty: number; revenue: number; cost: number; margin: number;
  marginPct: number | null; foodCostPct: number | null; noCost: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

function finish(name: string, soldQty: number, revenue: number, cost: number, noCost: boolean): MarginRow {
  const margin = revenue - cost;
  return {
    name, soldQty: Math.round(soldQty * 1000) / 1000, revenue: r2(revenue), cost: r2(cost), margin: r2(margin),
    marginPct: revenue > 0 ? r1((margin / revenue) * 100) : null,
    foodCostPct: revenue > 0 ? r1((cost / revenue) * 100) : null,
    noCost,
  };
}

function group(lines: MarginLine[], keyOf: (l: MarginLine) => string, nameOf: (l: MarginLine) => string) {
  const m = new Map<string, { name: string; qty: number; rev: number; cost: number; unlinkedRev: number }>();
  for (const l of lines) {
    const k = keyOf(l);
    const g = m.get(k) ?? { name: nameOf(l), qty: 0, rev: 0, cost: 0, unlinkedRev: 0 };
    g.qty += l.soldQty; g.rev += l.revenue; g.cost += l.cost;
    if (!l.linked) g.unlinkedRev += l.revenue;
    m.set(k, g);
  }
  return [...m.values()].map((g) => finish(g.name, g.qty, g.rev, g.cost, g.unlinkedRev > 0 && g.cost === 0));
}

export function aggregateMargin(lines: MarginLine[]) {
  const totalsRev = lines.reduce((s, l) => s + l.revenue, 0);
  const totalsCost = lines.reduce((s, l) => s + l.cost, 0);
  const unlinkedRevenue = lines.filter((l) => !l.linked).reduce((s, l) => s + l.revenue, 0);
  const byRevenue = (a: MarginRow, b: MarginRow) => b.revenue - a.revenue;
  return {
    totals: { ...finish("Итого", lines.reduce((s, l) => s + l.soldQty, 0), totalsRev, totalsCost, false), unlinkedRevenue: r2(unlinkedRevenue) },
    products: group(lines, (l) => l.key, (l) => l.name).sort(byRevenue),
    categories: group(lines, (l) => l.category, (l) => l.category).sort(byRevenue),
    days: group(lines, (l) => l.day, (l) => l.day).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
