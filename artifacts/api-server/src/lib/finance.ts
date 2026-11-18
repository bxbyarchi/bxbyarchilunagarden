/** Management P&L: pure assembly of the numbers gathered from the cash desk, stock, timesheet and money requests. */

export const EXPENSE_RU: Record<string, string> = {
  goods: "Товар на склад", services: "Услуги", repair: "Ремонт и обслуживание", household: "Хозяйственные нужды", utilities: "Коммунальные и связь",
  rent: "Аренда", marketing: "Реклама и мероприятия", salary: "Зарплата и премии вне табеля", taxes: "Налоги и сборы", other: "Прочие расходы",
};

export interface PnlInput {
  sales: { amount: number; method: string; checks: number }[];
  returns: number;
  cogs: number;
  writeOffs: { reason: string; value: number }[];
  payroll: { department: string | null; pay: number }[];
  money: { category: string | null; amount: number }[];
  purchases: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
function group<T>(rows: T[], key: (r: T) => string, val: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return [...m.entries()].map(([k, v]) => ({ key: k, amount: r2(v) })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
}

export function buildPnl(i: PnlInput) {
  const gross = i.sales.reduce((s, x) => s + x.amount, 0);
  const revenue = r2(gross - i.returns);
  const checks = i.sales.reduce((s, x) => s + x.checks, 0);
  const grossProfit = r2(revenue - i.cogs);
  const writeOffs = r2(i.writeOffs.reduce((s, x) => s + x.value, 0));
  const payroll = r2(i.payroll.reduce((s, x) => s + x.pay, 0));
  // Stock purchases reach the P&L via the cost of sales — counting them here too would double them.
  const opex = i.money.filter((m) => m.category !== "goods");
  const other = r2(opex.reduce((s, x) => s + x.amount, 0));
  const operatingProfit = r2(grossProfit - writeOffs - payroll - other);
  return {
    revenue, returns: r2(i.returns), checks, avgCheck: checks ? Math.round(gross / checks) : null,
    byMethod: group(i.sales, (s) => s.method, (s) => s.amount),
    cogs: r2(i.cogs), foodCostPct: pct(i.cogs, revenue), grossProfit, grossMarginPct: pct(grossProfit, revenue),
    writeOffs, writeOffsByReason: group(i.writeOffs, (w) => w.reason, (w) => w.value),
    payroll, payrollPct: pct(payroll, revenue), payrollByDepartment: group(i.payroll, (p) => p.department ?? "other", (p) => p.pay),
    otherExpenses: other, expensesByCategory: group(opex, (m) => m.category ?? "other", (m) => m.amount).map((x) => ({ ...x, label: EXPENSE_RU[x.key] ?? x.key })),
    operatingProfit, operatingMarginPct: pct(operatingProfit, revenue),
    info: { purchases: r2(i.purchases), goodsViaMoney: r2(i.money.filter((m) => m.category === "goods").reduce((s, x) => s + x.amount, 0)) },
  };
}
export type Pnl = ReturnType<typeof buildPnl>;

/** The same length of time right before [from, to] (inclusive days). */
export function previousPeriod(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  const d = (s: string, n: number) => { const x = new Date(`${s}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  return { from: d(from, -days), to: d(from, -1) };
}
