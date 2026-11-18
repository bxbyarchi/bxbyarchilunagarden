import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { TrendingUp, TrendingDown, Minus, Info, Landmark } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { DEPARTMENTS, addDays, errMsg, fmtMoney, mondayOf, todayLocal } from "@/lib/personnel";

interface Pnl {
  revenue: number; returns: number; checks: number; avgCheck: number | null; byMethod: { key: string; amount: number }[];
  cogs: number; foodCostPct: number | null; grossProfit: number; grossMarginPct: number | null;
  writeOffs: number; writeOffsByReason: { key: string; amount: number }[];
  payroll: number; payrollPct: number | null; payrollByDepartment: { key: string; amount: number }[];
  otherExpenses: number; expensesByCategory: { key: string; label: string; amount: number }[];
  operatingProfit: number; operatingMarginPct: number | null; info: { purchases: number; goodsViaMoney: number };
}
interface Data { from: string; to: string; previousPeriod: { from: string; to: string }; current: Pnl; previous: Pnl; byDay: { day: string; revenue: number; checks: number }[] }

const METHOD: Record<string, string> = { cash: "Наличные", card: "Карта", mixed: "Смешанная", transfer: "Перевод", qr: "QR" };
const ROLES = ["super_admin", "manager", "accountant"];
const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const monthEnd = (d: string) => { const x = new Date(`${d.slice(0, 8)}01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
const ru = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** Change vs the previous period; `good` = whether growth is good news (costs: no). */
function Delta({ now, before, good = true, points = false }: { now: number | null; before: number | null; good?: boolean; points?: boolean }) {
  if (now == null || before == null || (!points && before === 0)) return <span className="text-xs text-muted-foreground">нет данных для сравнения</span>;
  const d = points ? Math.round((now - before) * 10) / 10 : Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
  if (d === 0) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Minus className="h-3 w-3" />без изменений</span>;
  const up = d > 0, ok = up === good;
  const I = up ? TrendingUp : TrendingDown;
  return <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? "text-emerald-700" : "text-red-700"}`}><I className="h-3.5 w-3.5" />{up ? "+" : ""}{d}{points ? " п.п." : "%"} к прошлому</span>;
}

function Kpi({ label, value, sub, delta, tone }: { label: string; value: string; sub?: string; delta: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === "bad" ? "border-red-200 bg-red-50" : tone === "good" ? "border-emerald-200 bg-emerald-50/60" : "bg-card"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums xl:text-2xl">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      <div className="mt-1">{delta}</div>
    </div>
  );
}

export default function Finance() {
  const { user, isLoading } = useCurrentUser();
  const today = todayLocal();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [open, setOpen] = useState<string | null>("other");
  const ok = !!from && !!to && from <= to;
  const { data, error, isFetching } = useQuery<Data>({ queryKey: ["/api/reports/pnl", from, to], queryFn: () => customFetch(`/api/reports/pnl?from=${from}&to=${to}`), enabled: !!user && ok && ROLES.includes(user.role) });
  if (isLoading) return null;
  if (!ROLES.includes(user?.role ?? "")) return <AccessDenied />;
  const c = data?.current, p = data?.previous;
  const presets: [string, () => void][] = [
    ["Этот месяц", () => { setFrom(monthStart(today)); setTo(today); }],
    ["Прошлый месяц", () => { const x = addDays(monthStart(today), -1); setFrom(monthStart(x)); setTo(monthEnd(x)); }],
    ["Эта неделя", () => { setFrom(mondayOf(today)); setTo(today); }],
    ["Прошлая неделя", () => { const m = addDays(mondayOf(today), -7); setFrom(m); setTo(addDays(m, 6)); }],
  ];
  type Row = { key: string; label: string; now: number; before: number; sign: "+" | "−" | "="; pctNow?: number | null; items?: { label: string; now: number; before: number }[]; strong?: boolean };
  const rows: Row[] = c && p ? [
    { key: "rev", label: "Выручка", now: c.revenue, before: p.revenue, sign: "+", strong: true, items: c.byMethod.map((m) => ({ label: METHOD[m.key] ?? m.key, now: m.amount, before: p.byMethod.find((x) => x.key === m.key)?.amount ?? 0 })).concat(c.returns ? [{ label: "Возвраты (уже вычтены)", now: -c.returns, before: -p.returns }] : []) },
    { key: "cogs", label: "Себестоимость проданного", now: c.cogs, before: p.cogs, sign: "−", pctNow: c.foodCostPct },
    { key: "gross", label: "Валовая прибыль", now: c.grossProfit, before: p.grossProfit, sign: "=", pctNow: c.grossMarginPct, strong: true },
    { key: "wo", label: "Списания", now: c.writeOffs, before: p.writeOffs, sign: "−", items: c.writeOffsByReason.map((w) => ({ label: w.key, now: w.amount, before: p.writeOffsByReason.find((x) => x.key === w.key)?.amount ?? 0 })) },
    { key: "pay", label: "Зарплата по табелю", now: c.payroll, before: p.payroll, sign: "−", pctNow: c.payrollPct, items: c.payrollByDepartment.map((d) => ({ label: DEPARTMENTS[d.key] ?? "Без отдела", now: d.amount, before: p.payrollByDepartment.find((x) => x.key === d.key)?.amount ?? 0 })) },
    { key: "other", label: "Прочие расходы", now: c.otherExpenses, before: p.otherExpenses, sign: "−", items: c.expensesByCategory.map((e) => ({ label: e.label, now: e.amount, before: p.expensesByCategory.find((x) => x.key === e.key)?.amount ?? 0 })) },
    { key: "op", label: "Операционная прибыль", now: c.operatingProfit, before: p.operatingProfit, sign: "=", pctNow: c.operatingMarginPct, strong: true },
  ] : [];
  const maxExp = c ? Math.max(1, c.cogs, c.payroll, c.writeOffs, ...c.expensesByCategory.map((e) => e.amount)) : 1;
  const structure = c ? [{ label: "Себестоимость", v: c.cogs }, { label: "Зарплата", v: c.payroll }, { label: "Списания", v: c.writeOffs }, ...c.expensesByCategory.map((e) => ({ label: e.label, v: e.amount }))].filter((x) => x.v > 0).sort((a, b) => b.v - a.v) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Landmark className="h-6 w-6 text-primary" />Финансы</h1>
          <p className="text-muted-foreground">Доходы и расходы ресторана: сколько заработали за период и куда ушли деньги.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {presets.map(([l, f]) => <Button key={l} variant="ghost" size="sm" onClick={f}>{l}</Button>)}
          <div className="space-y-1"><Label className="text-xs">С</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label className="text-xs">По</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{errMsg(error) ?? "Отчёт не загрузился"}</div>}
      {data && <div className="text-sm text-muted-foreground">{ru(data.from)} — {ru(data.to)} · сравнение с {ru(data.previousPeriod.from)} — {ru(data.previousPeriod.to)}{isFetching && " · обновляется…"}</div>}

      {c && p && <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          <Kpi label="Выручка" value={fmtMoney(c.revenue)} sub={`${c.checks} чеков`} delta={<Delta now={c.revenue} before={p.revenue} />} />
          <Kpi label="Операционная прибыль" value={fmtMoney(c.operatingProfit)} sub={c.operatingMarginPct != null ? `${c.operatingMarginPct}% от выручки` : undefined} delta={<Delta now={c.operatingProfit} before={p.operatingProfit} />} tone={c.operatingProfit < 0 ? "bad" : c.operatingProfit > 0 ? "good" : undefined} />
          <Kpi label="Валовая прибыль" value={fmtMoney(c.grossProfit)} sub={c.grossMarginPct != null ? `маржа ${c.grossMarginPct}%` : undefined} delta={<Delta now={c.grossProfit} before={p.grossProfit} />} />
          <Kpi label="Средний чек" value={c.avgCheck != null ? fmtMoney(c.avgCheck) : "—"} delta={<Delta now={c.avgCheck} before={p.avgCheck} />} />
          <Kpi label="Фудкост" value={c.foodCostPct != null ? `${c.foodCostPct}%` : "—"} sub="норма 25–35%" delta={<Delta now={c.foodCostPct} before={p.foodCostPct} good={false} points />} tone={c.foodCostPct != null && c.foodCostPct > 38 ? "bad" : undefined} />
          <Kpi label="Зарплата к выручке" value={c.payrollPct != null ? `${c.payrollPct}%` : "—"} sub="норма 20–30%" delta={<Delta now={c.payrollPct} before={p.payrollPct} good={false} points />} tone={c.payrollPct != null && c.payrollPct > 35 ? "bad" : undefined} />
        </div>

        <div className="grid gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-3"><CardHeader className="pb-2"><CardTitle className="text-base">Отчёт о прибыли</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead><tr className="border-y bg-muted/40 text-xs text-muted-foreground"><th className="px-4 py-2 text-left font-medium">Статья</th><th className="px-3 py-2 text-right font-medium">Сейчас</th><th className="px-3 py-2 text-right font-medium">% выручки</th><th className="px-4 py-2 text-right font-medium">Было</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.key}>
                      <tr className={`border-b ${r.strong ? "bg-muted/20 font-semibold" : ""} ${r.items?.length ? "cursor-pointer hover:bg-muted/30" : ""}`} onClick={() => r.items?.length && setOpen(open === r.key ? null : r.key)}>
                        <td className="px-4 py-2.5"><span className="mr-2 inline-block w-3 text-muted-foreground">{r.sign}</span>{r.label}{r.items?.length ? <span className="ml-1 text-xs text-muted-foreground">{open === r.key ? "▾" : "▸"}</span> : null}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${r.key === "op" && r.now < 0 ? "text-red-700" : ""}`}>{fmtMoney(r.now)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.key === "rev" ? "100%" : r.pctNow != null ? `${r.pctNow}%` : c.revenue ? `${Math.round((r.now / c.revenue) * 1000) / 10}%` : "—"}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMoney(r.before)}</td>
                      </tr>
                      {open === r.key && r.items?.map((it) => (
                        <tr key={it.label} className="border-b bg-muted/10 text-xs"><td className="py-1.5 pl-12 pr-4 text-muted-foreground">{it.label}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(it.now)}</td><td /><td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{fmtMoney(it.before)}</td></tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="space-y-4 xl:col-span-2">
            <Card><CardHeader className="pb-2"><CardTitle className="text-base">Выручка по дням</CardTitle></CardHeader>
              <CardContent className="h-56">
                {data!.byDay.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data!.byDay} margin={{ left: 0, right: 8, top: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(8)} fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis fontSize={11} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}к` : String(v))} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} labelFormatter={(d: string) => ru(d)} />
                      <Bar dataKey="revenue" name="Выручка" fill="#831F21" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Продаж за период нет</div>}
              </CardContent>
            </Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-base">Куда уходят деньги</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {!structure.length && <div className="text-sm text-muted-foreground">Расходов за период нет</div>}
                {structure.map((x) => (
                  <div key={x.label}>
                    <div className="flex justify-between text-sm"><span>{x.label}</span><span className="tabular-nums">{fmtMoney(x.v)}</span></div>
                    <div className="mt-0.5 h-2 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-primary/80" style={{ width: `${(x.v / maxExp) * 100}%` }} /></div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="flex gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>Закупки товара на склад за период — <b>{fmtMoney(c.info.purchases)}</b>{c.info.goodsViaMoney ? <>, из них через подотчёт — <b>{fmtMoney(c.info.goodsViaMoney)}</b></> : null}. В расходы они попадают не сразу, а через себестоимость — по мере продажи блюд.</p>
            <p>Зарплата считается по табелю и ставкам из карточек сотрудников. Аренда, коммунальные, налоги и прочее попадают в отчёт, если оплачены через «Запросы денег» с нужной статьёй расхода.</p>
          </div>
        </div>
      </>}
    </div>
  );
}
