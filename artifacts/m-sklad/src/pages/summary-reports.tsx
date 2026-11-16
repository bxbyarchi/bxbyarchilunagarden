import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Search, AlertTriangle } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney, fmtQty } from "@/lib/units";
import { downloadCsv } from "@/lib/csv";

type Tab = "movement" | "onDate" | "purchases" | "cash";
const COLUMN_LABEL: Record<string, string> = { receipts: "Приход", transfers: "Перемещения", production: "Производство", sales: "Продажи", writeOffs: "Списания", adjustments: "Инвентаризация и правки" };
const KIND_LABEL: Record<string, string> = {
  opening: "Начальный остаток", item_create: "Создание позиции", receipt: "Поступление", receipt_edit: "Правка поступления", receipt_delete: "Удаление поступления",
  write_off: "Списание", write_off_edit: "Правка списания", write_off_delete: "Удаление списания", transfer_out: "Перемещение (отправлено)",
  transfer_in: "Перемещение (принято)", transfer_return: "Перемещение (возврат)", production_out: "Производство: сырьё", production_in: "Производство: выпуск",
  production_cancel: "Отмена производства", sale: "Продажа", sale_return: "Возврат продажи", inventory: "Инвентаризация", manual_adjust: "Ручная правка остатка",
  telegram_receipt: "Поступление (Telegram)", telegram_write_off: "Списание (Telegram)", other: "Прочее",
};

interface Loc { id: number; name: string; isActive: boolean }
interface MoveRow { itemId: number; locationId: number; name: string; unit: string; category: string | null; locationName: string | null; opening: number; closing: number; closingValue: number; columns: Record<string, number> }
interface MoveReport { from: string; to: string; columns: string[]; rows: MoveRow[]; closingValue: number }
interface OnDateRow { itemId: number; name: string; unit: string; category: string | null; locationName: string | null; qty: number; price: number; value: number }
interface OnDateReport { date: string; rows: OnDateRow[]; totalValue: number; negative: number }
interface PurchaseRow { counterpartyId: number | null; name: string; category: string | null; receipts: number; items: number; total: number; share: number; last: string }
interface PurchasesReport { total: number; rows: PurchaseRow[] }
interface CashShift { id: number; openedAt: string; status: string; pointName: string; registerName: string; cashierName: string; openingCash: number; salesCash: number; salesCard: number; returnsCash: number; returnsCard: number; collected: number; deposited: number; revenue: number; expected: number; counted: number | null; difference: number | null }
interface CashReport { shifts: CashShift[]; totals: { salesCash: number; salesCard: number; returnsCash: number; returnsCard: number; collected: number; deposited: number; revenue: number; shortage: number; surplus: number } }
interface LedgerRow { id: number; createdAt: string; locationName: string | null; kind: string; refId: number | null; delta: number; balanceAfter: number; userName: string | null }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthStart = () => { const n = new Date(); return iso(new Date(n.getFullYear(), n.getMonth(), 1)); };
const today = () => iso(new Date());
const signed = (v: number, unit = "") => (v === 0 ? "" : `${v > 0 ? "+" : ""}${fmtQty(v)}${unit ? ` ${unit}` : ""}`);
const err = (e: unknown) => (e as { data?: { error?: string } })?.data?.error ?? "Не удалось загрузить отчёт";

function ErrorBox({ error }: { error: unknown }) {
  return error ? <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{err(error)}</div> : null;
}

function LedgerDialog({ row, from, to, onClose }: { row: MoveRow | null; from: string; to: string; onClose: () => void }) {
  const { data } = useQuery<{ rows: LedgerRow[] }>({
    queryKey: ["/api/reports/stock-movement", row?.itemId, row?.locationId, from, to],
    queryFn: () => customFetch(`/api/reports/stock-movement/${row!.itemId}?from=${from}&to=${to}&locationId=${row!.locationId}`),
    enabled: !!row,
  });
  return (
    <Dialog open={!!row} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{row?.name} · {row?.locationName}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Каждое изменение остатка за период: на начало {fmtQty(row?.opening)} {row?.unit}, на конец {fmtQty(row?.closing)} {row?.unit}.</p>
        <Table>
          <TableHeader><TableRow><TableHead>Когда</TableHead><TableHead>Операция</TableHead><TableHead className="text-right">Изменение</TableHead><TableHead className="text-right">Остаток</TableHead><TableHead>Кто</TableHead></TableRow></TableHeader>
          <TableBody>{(data?.rows ?? []).map((l) => (
            <TableRow key={l.id}>
              <TableCell className="whitespace-nowrap text-sm">{new Date(l.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</TableCell>
              <TableCell className="text-sm">{KIND_LABEL[l.kind] ?? l.kind}{l.refId ? <span className="text-muted-foreground"> №{l.refId}</span> : null}</TableCell>
              <TableCell className={`text-right whitespace-nowrap font-medium ${l.delta < 0 ? "text-destructive" : "text-emerald-700"}`}>{signed(l.delta, row?.unit)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">{fmtQty(l.balanceAfter)} {row?.unit}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{l.userName ?? "—"}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
        {data && !data.rows.length && <p className="py-6 text-center text-muted-foreground">За период движений не было.</p>}
      </DialogContent>
    </Dialog>
  );
}

export default function SummaryReports() {
  const { canDo, canDoVenue, isLoading: roleLoading } = useCurrentUser();
  const [tab, setTab] = useState<Tab>("movement");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [onDate, setOnDate] = useState(today());
  const [locationId, setLocationId] = useState("all");
  const [q, setQ] = useState("");
  const [ledgerRow, setLedgerRow] = useState<MoveRow | null>(null);

  const { data: locations } = useQuery<Loc[]>({ queryKey: ["/api/locations"], queryFn: () => customFetch<Loc[]>("/api/locations") });
  const loc = locationId !== "all" ? `&locationId=${locationId}` : "";
  const movement = useQuery<MoveReport>({ queryKey: ["rep-move", from, to, locationId], queryFn: () => customFetch(`/api/reports/stock-movement?from=${from}&to=${to}${loc}`), enabled: tab === "movement" });
  const stock = useQuery<OnDateReport>({ queryKey: ["rep-ondate", onDate, locationId], queryFn: () => customFetch(`/api/reports/stock-on-date?date=${onDate}${loc}`), enabled: tab === "onDate" });
  const purchases = useQuery<PurchasesReport>({ queryKey: ["rep-purch", from, to], queryFn: () => customFetch(`/api/reports/purchases?from=${from}&to=${to}`), enabled: tab === "purchases" });
  const cash = useQuery<CashReport>({ queryKey: ["rep-cash", from, to], queryFn: () => customFetch(`/api/reports/cash?from=${from}&to=${to}`), enabled: tab === "cash" });

  const match = (s: string | null | undefined) => !q.trim() || (s ?? "").toLowerCase().includes(q.trim().toLowerCase());
  const moveRows = useMemo(() => (movement.data?.rows ?? []).filter((r) => match(r.name) || match(r.category)), [movement.data, q]);
  const stockRows = useMemo(() => (stock.data?.rows ?? []).filter((r) => match(r.name) || match(r.category)), [stock.data, q]);

  if (roleLoading) return null;
  if (!canDo("warehouse")) return <AccessDenied />;
  const canPurchases = canDo("manager");
  const canCash = canDoVenue("location_admin");

  function exportCsv() {
    if (tab === "movement" && movement.data) {
      const cols = movement.data.columns;
      downloadCsv(`движение-товара_${from}_${to}.csv`, ["Подразделение", "Категория", "Позиция", "Ед.", "На начало", ...cols.map((c) => COLUMN_LABEL[c] ?? c), "На конец", "Сумма на конец"],
        moveRows.map((r) => [r.locationName, r.category, r.name, r.unit, r.opening, ...cols.map((c) => r.columns[c]), r.closing, r.closingValue]));
    } else if (tab === "onDate" && stock.data) {
      downloadCsv(`остатки_${onDate}.csv`, ["Подразделение", "Категория", "Позиция", "Ед.", "Остаток", "Цена", "Сумма"], stockRows.map((r) => [r.locationName, r.category, r.name, r.unit, r.qty, r.price, r.value]));
    } else if (tab === "purchases" && purchases.data) {
      downloadCsv(`закупки_${from}_${to}.csv`, ["Поставщик", "Категория", "Поступлений", "Позиций", "Сумма", "Доля, %"], purchases.data.rows.map((r) => [r.name, r.category, r.receipts, r.items, r.total, r.share]));
    } else if (tab === "cash" && cash.data) {
      downloadCsv(`деньги-по-сменам_${from}_${to}.csv`, ["Открыта", "Точка", "Касса", "Кассир", "На старте", "Нал", "Безнал", "Возвр. нал", "Возвр. безнал", "Инкассация", "Пополнение", "Ожидалось", "Факт", "Расхождение"],
        cash.data.shifts.map((s) => [new Date(s.openedAt).toLocaleString("ru-RU"), s.pointName, s.registerName, s.cashierName, s.openingCash, s.salesCash, s.salesCard, s.returnsCash, s.returnsCard, s.collected, s.deposited, s.expected, s.counted, s.difference]));
    }
  }

  const periodInputs = (
    <div className="flex items-center gap-2">
      <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="С" />
      <span className="text-muted-foreground">—</span>
      <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="По" />
    </div>
  );
  const locationSelect = (
    <Select value={locationId} onValueChange={setLocationId}>
      <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Все подразделения</SelectItem>
        {locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  const search = (
    <div className="relative w-full sm:w-64">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input className="pl-9" placeholder="Позиция или категория" value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Сводные отчёты</h1>
          <p className="text-muted-foreground">Движение товара по журналу операций, остатки на любую дату, закупки и деньги по сменам.</p>
        </div>
        <Button variant="outline" onClick={exportCsv}><Download className="mr-2 h-4 w-4" />Excel (CSV)</Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="movement">Движение товара</TabsTrigger>
          <TabsTrigger value="onDate">Остатки на дату</TabsTrigger>
          {canPurchases && <TabsTrigger value="purchases">Закупки по поставщикам</TabsTrigger>}
          {canCash && <TabsTrigger value="cash">Деньги по сменам</TabsTrigger>}
        </TabsList>
      </Tabs>

      {tab === "movement" && (
        <>
          <div className="flex flex-wrap items-center gap-3">{periodInputs}{locationSelect}{search}</div>
          <ErrorBox error={movement.error} />
          <Card><CardContent className="p-0">
            {movement.isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !moveRows.length ? <div className="py-12 text-center text-muted-foreground">Движений нет.</div> : (
              <div className="table-scroll-mobile">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Позиция</TableHead><TableHead className="text-right">На начало</TableHead>
                    {movement.data!.columns.map((c) => <TableHead key={c} className="text-right">{COLUMN_LABEL[c] ?? c}</TableHead>)}
                    <TableHead className="text-right">На конец</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{moveRows.map((r) => (
                    <TableRow key={`${r.itemId}:${r.locationId}`} className="cursor-pointer" onClick={() => setLedgerRow(r)}>
                      <TableCell><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.locationName}{r.category ? ` · ${r.category}` : ""}</div></TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(r.opening)} {r.unit}</TableCell>
                      {movement.data!.columns.map((c) => <TableCell key={c} className={`text-right whitespace-nowrap ${r.columns[c] < 0 ? "text-destructive" : r.columns[c] > 0 ? "text-emerald-700" : ""}`}>{signed(r.columns[c])}</TableCell>)}
                      <TableCell className={`text-right whitespace-nowrap font-semibold ${r.closing < 0 ? "text-destructive" : ""}`}>{fmtQty(r.closing)} {r.unit}<div className="text-xs font-normal text-muted-foreground">{fmtMoney(r.closingValue)}</div></TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
            )}
          </CardContent></Card>
          {movement.data && <p className="text-sm text-muted-foreground">Нажмите на строку — откроется каждая операция с остатком после неё. Стоимость на конец — {fmtMoney(movement.data.closingValue)} по текущим ценам.</p>}
          <LedgerDialog row={ledgerRow} from={from} to={to} onClose={() => setLedgerRow(null)} />
        </>
      )}

      {tab === "onDate" && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Input type="date" className="w-44" value={onDate} max={today()} onChange={(e) => setOnDate(e.target.value)} aria-label="Дата" />
            {locationSelect}{search}
          </div>
          <ErrorBox error={stock.error} />
          {stock.data && (
            <div className="flex flex-wrap gap-3">
              <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Стоимость остатков на конец {new Date(`${stock.data.date}T00:00:00`).toLocaleDateString("ru-RU")}</div><div className="mt-1 text-xl font-semibold">{fmtMoney(stock.data.totalValue)}</div><div className="text-xs text-muted-foreground">по текущим ценам</div></div>
              {stock.data.negative > 0 && <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"><AlertTriangle className="h-4 w-4" />{stock.data.negative} позиций в минусе — продали больше, чем оприходовали</div>}
            </div>
          )}
          <Card><CardContent className="p-0">
            {stock.isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !stockRows.length ? <div className="py-12 text-center text-muted-foreground">Остатков нет.</div> : (
              <div className="table-scroll-mobile">
                <Table>
                  <TableHeader><TableRow><TableHead>Позиция</TableHead><TableHead>Подразделение</TableHead><TableHead className="text-right">Остаток</TableHead><TableHead className="text-right">Цена</TableHead><TableHead className="text-right">Сумма</TableHead></TableRow></TableHeader>
                  <TableBody>{stockRows.map((r) => (
                    <TableRow key={`${r.itemId}:${r.locationName}`}>
                      <TableCell><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.category}</div></TableCell>
                      <TableCell>{r.locationName}</TableCell>
                      <TableCell className={`text-right whitespace-nowrap ${r.qty < 0 ? "text-destructive font-semibold" : ""}`}>{fmtQty(r.qty)} {r.unit}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(r.price)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(r.value)}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
            )}
          </CardContent></Card>
        </>
      )}

      {tab === "purchases" && canPurchases && (
        <>
          <div className="flex flex-wrap items-center gap-3">{periodInputs}</div>
          <ErrorBox error={purchases.error} />
          {purchases.data && <div className="rounded-xl border bg-card p-4 inline-block"><div className="text-xs text-muted-foreground">Закуплено за период</div><div className="mt-1 text-xl font-semibold">{fmtMoney(purchases.data.total)}</div></div>}
          <Card><CardContent className="p-0">
            {purchases.isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !purchases.data?.rows.length ? <div className="py-12 text-center text-muted-foreground">Поступлений нет.</div> : (
              <Table>
                <TableHeader><TableRow><TableHead>Поставщик</TableHead><TableHead className="text-right">Поступлений</TableHead><TableHead className="text-right">Позиций</TableHead><TableHead className="text-right">Сумма</TableHead><TableHead className="w-48">Доля</TableHead></TableRow></TableHeader>
                <TableBody>{purchases.data.rows.map((r) => (
                  <TableRow key={`${r.counterpartyId}:${r.name}`}>
                    <TableCell>{r.counterpartyId ? <Link href={`/counterparties/${r.counterpartyId}`} className="font-medium text-primary hover:underline">{r.name}</Link> : <span className="font-medium">{r.name}</span>}<div className="text-xs text-muted-foreground">{r.category ?? (r.counterpartyId ? "" : "не из справочника")}</div></TableCell>
                    <TableCell className="text-right">{r.receipts}</TableCell>
                    <TableCell className="text-right">{r.items}</TableCell>
                    <TableCell className="text-right whitespace-nowrap font-medium">{fmtMoney(r.total)}</TableCell>
                    <TableCell><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${Math.min(r.share, 100)}%` }} /></div><span className="w-12 text-right text-xs text-muted-foreground">{fmtQty(r.share, 1)}%</span></div></TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
          </CardContent></Card>
        </>
      )}

      {tab === "cash" && canCash && (
        <>
          <div className="flex flex-wrap items-center gap-3">{periodInputs}</div>
          <ErrorBox error={cash.error} />
          {cash.data && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Выручка (за вычетом возвратов)</div><div className="mt-1 text-xl font-semibold">{fmtMoney(cash.data.totals.revenue)}</div></div>
              <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Наличные / безнал</div><div className="mt-1 text-lg font-semibold">{fmtMoney(cash.data.totals.salesCash)} / {fmtMoney(cash.data.totals.salesCard)}</div></div>
              <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Возвраты нал / безнал</div><div className="mt-1 text-lg font-semibold">{fmtMoney(cash.data.totals.returnsCash)} / {fmtMoney(cash.data.totals.returnsCard)}</div></div>
              <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Расхождения в кассах</div><div className={`mt-1 text-lg font-semibold ${cash.data.totals.shortage < 0 ? "text-destructive" : ""}`}>{fmtMoney(cash.data.totals.shortage)} / +{fmtMoney(cash.data.totals.surplus)}</div></div>
            </div>
          )}
          <Card><CardContent className="p-0">
            {cash.isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !cash.data?.shifts.length ? <div className="py-12 text-center text-muted-foreground">Смен нет.</div> : (
              <div className="table-scroll-mobile">
                <Table>
                  <TableHeader><TableRow><TableHead>Смена</TableHead><TableHead className="text-right">Нал</TableHead><TableHead className="text-right">Безнал</TableHead><TableHead className="text-right">Возвраты</TableHead><TableHead className="text-right">Инкасс. / попол.</TableHead><TableHead className="text-right">Ожидалось</TableHead><TableHead className="text-right">Факт</TableHead><TableHead className="text-right">Расхождение</TableHead></TableRow></TableHeader>
                  <TableBody>{cash.data.shifts.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell><div className="font-medium whitespace-nowrap">{new Date(s.openedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} {s.status === "open" && <Badge variant="outline">открыта</Badge>}</div><div className="text-xs text-muted-foreground">{s.pointName} · {s.registerName} · {s.cashierName}</div></TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(s.salesCash)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(s.salesCard)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap text-sm">{s.returnsCash || s.returnsCard ? <>{fmtMoney(s.returnsCash)}<div className="text-xs text-muted-foreground">безнал {fmtMoney(s.returnsCard)}</div></> : "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap text-sm">{s.collected || s.deposited ? `−${fmtMoney(s.collected)} / +${fmtMoney(s.deposited)}` : "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(s.expected)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{s.counted == null ? "—" : fmtMoney(s.counted)}</TableCell>
                      <TableCell className={`text-right whitespace-nowrap font-semibold ${s.difference == null ? "" : s.difference < 0 ? "text-destructive" : s.difference > 0 ? "text-emerald-700" : ""}`}>{s.difference == null ? "—" : fmtMoney(s.difference)}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
            )}
          </CardContent></Card>
        </>
      )}
    </div>
  );
}
