/**
 * The advisor reads data only through the CRM's own report endpoints, called with the
 * asking user's session: it sees exactly what that person may see in the web app.
 */

export interface ReportDef { path: string; about: string; period: boolean; q?: boolean }

export const REPORTS: Record<string, ReportDef> = {
  sales_margin: { path: "/reports/sales-margin", period: true, about: "Продажи по блюдам и категориям: количество, выручка, себестоимость, маржа, по дням" },
  kassa_summary: { path: "/kassa-analytics/summary", period: true, about: "Кассы: выручка, число чеков, средний чек, наличные/карта, возвраты, по дням и часам" },
  cash_report: { path: "/reports/cash", period: true, about: "Деньги в кассах по сменам: ожидаемые и фактические наличные, расхождения, инкассации" },
  stock_items: { path: "/items", period: false, q: true, about: "Товары склада с текущими остатками, мин. остатком и ценой (q — поиск по названию)" },
  low_stock: { path: "/analytics/low-stock", period: false, about: "Товары ниже минимального остатка" },
  stock_movement: { path: "/reports/stock-movement", period: true, about: "Движение товаров за период: остаток на начало, приход, расход, списания, перемещения, остаток на конец" },
  purchases: { path: "/reports/purchases", period: true, about: "Закупки за период по поставщикам и товарам, суммы" },
  top_write_offs: { path: "/analytics/top-write-offs", period: false, about: "Самые крупные списания (бой, порча, хищение…)" },
  tech_cards: { path: "/tech-cards", period: false, about: "Тех-карты блюд и полуфабрикатов с себестоимостью и выходом" },
  bookings: { path: "/bookings", period: true, about: "Брони за период: гости, количество человек, статусы, предоплаты" },
  timesheet: { path: "/personnel/timesheet", period: true, about: "Табель: отработано, опоздания, ранний уход, переработки, прогулы, начисления по сотрудникам" },
  schedule: { path: "/personnel/schedule", period: true, about: "График смен сотрудников и как смены прошли на самом деле" },
  tasks_efficiency: { path: "/tasks/efficiency", period: true, about: "Эффективность по задачам: выполнено вовремя, с опозданием, просрочено, возвраты, % вовремя" },
  tasks_overdue: { path: "/tasks?view=all&status=overdue", period: false, about: "Просроченные открытые задачи сейчас" },
  tasks_open: { path: "/tasks?view=all&status=open", period: false, about: "Все открытые задачи сейчас" },
  money_summary: { path: "/money-requests/summary", period: false, about: "Запросы денег: ждут согласования, к выдаче, отчёты на проверке, сумма под отчётом" },
  money_advances: { path: "/money-requests/advances", period: false, about: "У кого сколько денег под отчётом и просроченные отчёты" },
  money_requests: { path: "/money-requests?view=all&status=all", period: false, about: "Последние запросы денег (все статусы): суммы, отделы, кто запросил" },
  ai_agent_stats: { path: "/ai/stats?days=30", period: false, about: "ИИ-агент для гостей за 30 дней: диалоги, брони, ошибки, расход" },
};

export const REPORT_NAMES = Object.keys(REPORTS);

export function reportUrl(name: string, params: { from: string | null; to: string | null; q: string | null }): string | null {
  const def = REPORTS[name];
  if (!def) return null;
  const qs = new URLSearchParams();
  if (def.period) {
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
  }
  if (def.q && params.q) qs.set("search", params.q);
  const s = qs.toString();
  return `/api${def.path}${s ? (def.path.includes("?") ? "&" : "?") + s : ""}`;
}

/**
 * Keep a report small enough for the model: long arrays are cut to their first items with a note,
 * long strings trimmed. Returns compact JSON.
 */
export function shrink(data: unknown, maxChars = 24_000): string {
  let limit = 60;
  for (;;) {
    const cut = (v: unknown, depth: number): unknown => {
      if (Array.isArray(v)) {
        const items = v.slice(0, limit).map((x) => cut(x, depth + 1));
        return v.length > limit ? [...items, `…ещё ${v.length - limit} строк не показано`] : items;
      }
      if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
          if (x == null || k.endsWith("ClerkId") || k === "clerkUserId" || k === "pinHash") continue; // ids are noise for the model
          o[k] = cut(x, depth + 1);
        }
        return o;
      }
      if (typeof v === "string" && v.length > 300) return `${v.slice(0, 300)}…`;
      if (typeof v === "number" && !Number.isInteger(v)) return Math.round(v * 100) / 100;
      return v;
    };
    const s = JSON.stringify(cut(data, 0));
    if (s.length <= maxChars || limit <= 5) return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…(обрезано)`;
    limit = Math.floor(limit / 2);
  }
}
