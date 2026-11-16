import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney, fmtQty } from "@/lib/units";

interface Row { name: string; soldQty: number; revenue: number; cost: number; margin: number; marginPct: number | null; foodCostPct: number | null; noCost: boolean }
interface Report { from: string; to: string; totals: Row & { unlinkedRevenue: number }; products: Row[]; categories: Row[]; days: Row[] }
interface House { id: number; name: string; locationName?: string | null }

type Preset = "today" | "week" | "month" | "custom";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  if (p === "today") return { from: iso(now), to: iso(now) };
  if (p === "week") { const f = new Date(now); f.setDate(f.getDate() - 6); return { from: iso(f), to: iso(now) }; }
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
}

function FoodCost({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground">—</span>;
  const tone = pct <= 30 ? "bg-emerald-100 text-emerald-800" : pct <= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${tone}`}>{fmtQty(pct, 1)}%</span>;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default function SalesMargin() {
  const { canDoVenue, isLoading: roleLoading } = useCurrentUser();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState(presetRange("month"));
  const [houseId, setHouseId] = useState("all");
  const [view, setView] = useState<"products" | "categories" | "days">("products");
  const range = preset === "custom" ? custom : presetRange(preset);

  const { data: houses } = useQuery<House[]>({ queryKey: ["/api/houses"], queryFn: () => customFetch<House[]>("/api/houses") });
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (houseId !== "all") params.set("houseId", houseId);
  const { data, isLoading, error } = useQuery<Report>({
    queryKey: ["/api/reports/sales-margin", range.from, range.to, houseId],
    queryFn: () => customFetch<Report>(`/api/reports/sales-margin?${params}`),
  });

  const rows = useMemo(() => (data ? data[view] : []), [data, view]);
  if (roleLoading) return null;
  if (!canDoVenue("location_admin")) return <AccessDenied />;
  const t = data?.totals;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Маржа продаж</h1>
        <p className="text-muted-foreground">Выручка за вычетом скидок и возвратов, фактическая себестоимость списанных продуктов и маржа по позициям меню.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={preset} onValueChange={(v) => setPreset(v as Preset)}>
          <TabsList><TabsTrigger value="today">Сегодня</TabsTrigger><TabsTrigger value="week">7 дней</TabsTrigger><TabsTrigger value="month">Месяц</TabsTrigger><TabsTrigger value="custom">Период</TabsTrigger></TabsList>
        </Tabs>
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <Input type="date" className="w-40" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="С" />
            <span className="text-muted-foreground">—</span>
            <Input type="date" className="w-40" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="По" />
          </div>
        )}
        <Select value={houseId} onValueChange={setHouseId}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все точки продаж</SelectItem>
            {houses?.map((h) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{(error as { data?: { error?: string } })?.data?.error ?? "Не удалось загрузить отчёт"}</div> : null}

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Выручка" value={fmtMoney(t.revenue)} sub={`${fmtQty(t.soldQty)} позиций продано`} />
          <Tile label="Себестоимость" value={fmtMoney(t.cost)} sub={t.foodCostPct != null ? `фудкост ${fmtQty(t.foodCostPct, 1)}%` : undefined} />
          <Tile label="Маржа" value={fmtMoney(t.margin)} sub={t.marginPct != null ? `${fmtQty(t.marginPct, 1)}% от выручки` : undefined} tone={t.margin >= 0 ? "good" : "bad"} />
          <Tile label="Без списания со склада" value={fmtMoney(t.unlinkedRevenue)} sub="выручка позиций без тех-карты" tone={t.unlinkedRevenue > 0 ? "bad" : undefined} />
        </div>
      )}

      {t && t.unlinkedRevenue > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>Часть продаж не привязана к тех-картам или складу — их себестоимость равна нулю и маржа завышена. Привяжите позиции меню в «Точки продаж» → «Меню».</div>
        </div>
      )}

      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
        <TabsList><TabsTrigger value="products">По позициям</TabsTrigger><TabsTrigger value="categories">По категориям</TabsTrigger><TabsTrigger value="days">По дням</TabsTrigger></TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !rows.length ? (
            <div className="py-12 text-center text-muted-foreground">За период продаж нет.</div>
          ) : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>{view === "products" ? "Позиция" : view === "categories" ? "Категория" : "День"}</TableHead>
                  <TableHead className="text-right">Продано</TableHead>
                  <TableHead className="text-right">Выручка</TableHead>
                  <TableHead className="text-right">Себестоимость</TableHead>
                  <TableHead className="text-right">Маржа</TableHead>
                  <TableHead className="text-right">Фудкост</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="font-medium">
                        {view === "days" ? new Date(`${r.name}T00:00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit" }) : r.name}
                        {r.noCost && <span className="ml-2 text-xs font-normal text-amber-700">без себестоимости</span>}
                      </TableCell>
                      <TableCell className="text-right">{fmtQty(r.soldQty)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(r.revenue)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(r.cost)}</TableCell>
                      <TableCell className={`text-right whitespace-nowrap font-medium ${r.margin < 0 ? "text-destructive" : ""}`}>{fmtMoney(r.margin)}</TableCell>
                      <TableCell className="text-right"><FoodCost pct={r.foodCostPct} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
