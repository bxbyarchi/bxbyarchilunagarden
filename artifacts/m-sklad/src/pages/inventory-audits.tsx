import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Plus, ClipboardCheck, ArrowLeft, Printer, Search, Trash2, CheckCircle2, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { compatibleUnits, convert, fmtMoney, fmtQty } from "@/lib/units";

interface AuditSummary {
  id: number; title: string; locationId: number | null; locationName: string | null; status: "draft" | "submitted";
  createdAt: string; submittedAt: string | null; itemsTotal: number; itemsCounted: number; shortageValue: number; surplusValue: number;
}
interface AuditLine {
  id: number; itemId: number; itemName: string | null; unit: string | null; categoryName: string | null;
  systemStock: number; actualStock: number | null; unitPrice: number; movedSinceSnapshot: number;
  diff: number | null; diffValue: number | null; status: "uncounted" | "ok" | "shortage" | "surplus";
}
interface AuditDetail {
  id: number; title: string; locationId: number | null; locationName: string | null; status: "draft" | "submitted";
  notes: string | null; createdAt: string; submittedAt: string | null; createdByName: string | null; submittedByName: string | null;
  totals: { total: number; counted: number; withDiff: number; shortageValue: number; surplusValue: number; balance: number };
  items: AuditLine[];
}
interface LocationOption { id: number; name: string; isActive: boolean }
interface ItemOption { id: number; name: string; unit: string }

const errMsg = (e: unknown, fallback: string) => (e as { data?: { error?: string } })?.data?.error ?? fallback;
const fmtDate = (s: string) => new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function DiffCell({ line }: { line: AuditLine }) {
  if (line.status === "uncounted") return <span className="text-muted-foreground">—</span>;
  if (line.status === "ok") return <span className="text-emerald-700">✓</span>;
  const tone = line.status === "shortage" ? "text-destructive" : "text-emerald-700";
  return (
    <div className={`text-right ${tone}`}>
      <div className="font-semibold whitespace-nowrap">{line.diff! > 0 ? "+" : ""}{fmtQty(line.diff)} {line.unit}</div>
      <div className="text-xs whitespace-nowrap">{line.diffValue! > 0 ? "+" : ""}{fmtMoney(line.diffValue)}</div>
    </div>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

export default function InventoryAudits() {
  const { canDo, isLoading: roleLoading, user } = useCurrentUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [department, setDepartment] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ locationId: "", title: "", scope: "stocked" });
  const [creating, setCreating] = useState(false);

  const { data: locations } = useQuery<LocationOption[]>({ queryKey: ["/api/locations"], queryFn: () => customFetch<LocationOption[]>("/api/locations") });
  const { data: audits, isLoading } = useQuery<AuditSummary[]>({
    queryKey: ["/api/inventory-audits", department],
    queryFn: () => customFetch<AuditSummary[]>(`/api/inventory-audits${department !== "all" ? `?locationId=${department}` : ""}`),
  });

  useEffect(() => { if (createOpen) setForm({ locationId: user?.locationId ? String(user.locationId) : "", title: "", scope: "stocked" }); }, [createOpen, user?.locationId]);

  async function create() {
    setCreating(true);
    try {
      const created = await customFetch<{ id: number }>("/api/inventory-audits", { method: "POST", body: JSON.stringify({ locationId: Number(form.locationId), title: form.title, scope: form.scope }) });
      await qc.invalidateQueries({ queryKey: ["/api/inventory-audits"] });
      setCreateOpen(false);
      setLocation(`/inventory-audits/${created.id}`);
    } catch (e) {
      toast({ title: "Не удалось начать инвентаризацию", description: errMsg(e, ""), variant: "destructive" });
    } finally { setCreating(false); }
  }

  if (roleLoading) return null;
  if (!canDo("warehouse")) return <AccessDenied />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Инвентаризация</h1>
          <p className="text-muted-foreground">Пересчёт фактических остатков подразделения: недостачи и излишки в количестве и в деньгах.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Начать инвентаризацию</Button>
      </div>

      <Select value={department} onValueChange={setDepartment}>
        <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Все подразделения</SelectItem>
          {locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !audits?.length ? (
            <div className="py-12 text-center text-muted-foreground"><ClipboardCheck className="mx-auto mb-3 h-8 w-8 opacity-40" />Инвентаризаций пока нет.</div>
          ) : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Инвентаризация</TableHead><TableHead>Подразделение</TableHead><TableHead>Статус</TableHead>
                  <TableHead className="text-right">Посчитано</TableHead><TableHead className="text-right">Недостача</TableHead><TableHead className="text-right">Излишки</TableHead>
                </TableRow></TableHeader>
                <TableBody>{audits.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => setLocation(`/inventory-audits/${a.id}`)}>
                    <TableCell><div className="font-medium">{a.title}</div><div className="text-xs text-muted-foreground">{fmtDate(a.createdAt)}</div></TableCell>
                    <TableCell>{a.locationName ?? "—"}</TableCell>
                    <TableCell>{a.status === "draft" ? <Badge variant="outline">идёт пересчёт</Badge> : <Badge>проведена {a.submittedAt ? new Date(a.submittedAt).toLocaleDateString("ru-RU") : ""}</Badge>}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{a.itemsCounted} из {a.itemsTotal}</TableCell>
                    <TableCell className="text-right whitespace-nowrap text-destructive">{a.shortageValue ? `−${fmtMoney(a.shortageValue)}` : "—"}</TableCell>
                    <TableCell className="text-right whitespace-nowrap text-emerald-700">{a.surplusValue ? `+${fmtMoney(a.surplusValue)}` : "—"}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Новая инвентаризация</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Подразделение</Label>
              <Select value={form.locationId} onValueChange={(v) => setForm((f) => ({ ...f, locationId: v }))}>
                <SelectTrigger><SelectValue placeholder="Где считаем" /></SelectTrigger>
                <SelectContent>{locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Какие позиции включить</Label>
              <Select value={form.scope} onValueChange={(v) => setForm((f) => ({ ...f, scope: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stocked">Только позиции этого подразделения</SelectItem>
                  <SelectItem value="all">Весь справочник (первая инвентаризация)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Название</Label><Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="По умолчанию — подразделение и дата" /></div>
            <p className="text-xs text-muted-foreground">Учётные остатки фиксируются в момент начала. Приходы и списания во время пересчёта не потеряются — при проведении применяется только разница «факт − учёт».</p>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setCreateOpen(false)}>Отмена</Button><Button onClick={create} disabled={creating || !form.locationId}>{creating ? "Создание…" : "Начать"}</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Counting sheet ──────────────────────────────────────────────────────────

type Filter = "all" | "uncounted" | "diff";

function CountInput({ line, disabled, onSave }: { line: AuditLine; disabled: boolean; onSave: (qtyInItemUnit: number | null) => Promise<void> }) {
  const units = line.unit ? compatibleUnits(line.unit) : [];
  const [unit, setUnit] = useState(line.unit ?? "");
  const [value, setValue] = useState(line.actualStock == null ? "" : String(line.actualStock));
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const lastSaved = useRef(line.actualStock);

  useEffect(() => { // server value changed (e.g. another device) and the field isn't being edited
    if (line.actualStock !== lastSaved.current) { lastSaved.current = line.actualStock; setUnit(line.unit ?? ""); setValue(line.actualStock == null ? "" : String(line.actualStock)); }
  }, [line.actualStock, line.unit]);

  async function commit() {
    const raw = value.trim().replace(",", ".");
    let qty: number | null = null;
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { setState("error"); return; }
      qty = line.unit ? convert(n, unit, line.unit) : n;
      if (qty == null) { setState("error"); return; }
      qty = Math.round(qty * 1000) / 1000;
    }
    if (qty === lastSaved.current) return;
    setState("saving");
    try {
      await onSave(qty);
      lastSaved.current = qty;
      if (qty != null && unit !== line.unit) { setUnit(line.unit ?? ""); setValue(String(qty)); }
      setState("idle");
    } catch { setState("error"); }
  }

  return (
    <div className="flex items-center gap-1.5 justify-end">
      <Input
        inputMode="decimal" className={`h-9 w-24 text-right ${state === "error" ? "border-destructive" : ""}`} value={value} disabled={disabled}
        onChange={(e) => setValue(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        aria-label={`Факт: ${line.itemName}`}
      />
      {units.length > 1 && !disabled ? (
        <Select value={unit} onValueChange={setUnit}>
          <SelectTrigger className="h-9 w-[4.5rem] px-2"><SelectValue /></SelectTrigger>
          <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
        </Select>
      ) : <span className="w-[4.5rem] text-sm text-muted-foreground">{line.unit}</span>}
      <span className="w-3 text-xs text-muted-foreground">{state === "saving" ? "…" : ""}</span>
    </div>
  );
}

export function InventoryAuditSheet() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const queryKey = ["/api/inventory-audits", "detail", id];
  const { data: audit, isLoading, error } = useQuery<AuditDetail>({ queryKey, queryFn: () => customFetch<AuditDetail>(`/api/inventory-audits/${id}`) });
  const { data: allItems } = useQuery<ItemOption[]>({ queryKey: ["/api/items", "all"], queryFn: () => customFetch<ItemOption[]>("/api/items"), enabled: addOpen });

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (audit?.items ?? []).filter((l) =>
      (!s || (l.itemName ?? "").toLowerCase().includes(s) || (l.categoryName ?? "").toLowerCase().includes(s)) &&
      (filter === "all" || (filter === "uncounted" ? l.status === "uncounted" : l.status === "shortage" || l.status === "surplus")));
  }, [audit, q, filter]);
  const grouped = useMemo(() => {
    const m = new Map<string, AuditLine[]>();
    for (const l of shown) { const k = l.categoryName ?? "Без категории"; m.set(k, [...(m.get(k) ?? []), l]); }
    return [...m];
  }, [shown]);

  if (roleLoading || isLoading) return <div className="py-12 text-center text-muted-foreground">Загрузка…</div>;
  if (!canDo("warehouse")) return <AccessDenied />;
  if (error || !audit) return <div className="py-12 text-center text-muted-foreground">{errMsg(error, "Инвентаризация не найдена")}</div>;
  const draft = audit.status === "draft";
  const t = audit.totals;
  const onSheet = new Set(audit.items.map((l) => l.itemId));

  async function save(itemId: number, actualStock: number | null) {
    try {
      await customFetch(`/api/inventory-audits/${audit!.id}`, { method: "PATCH", body: JSON.stringify({ items: [{ itemId, actualStock }] }) });
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      toast({ title: "Не сохранено", description: errMsg(e, ""), variant: "destructive" });
      throw e;
    }
  }

  async function fillUncountedWithSystem() {
    if (!window.confirm("Для всех непосчитанных позиций поставить факт = учёт? Используйте, только если эти позиции действительно проверены.")) return;
    setBusy(true);
    try {
      const items = audit!.items.filter((l) => l.status === "uncounted").map((l) => ({ itemId: l.itemId, actualStock: l.systemStock }));
      await customFetch(`/api/inventory-audits/${audit!.id}`, { method: "PATCH", body: JSON.stringify({ items }) });
      await qc.invalidateQueries({ queryKey });
    } catch (e) { toast({ title: "Ошибка", description: errMsg(e, ""), variant: "destructive" }); } finally { setBusy(false); }
  }

  async function submit() {
    const uncounted = t.total - t.counted;
    const msg = `Провести инвентаризацию?\n\nНедостача: ${fmtMoney(t.shortageValue)}\nИзлишки: ${fmtMoney(t.surplusValue)}` +
      (uncounted ? `\n\n${uncounted} позиций не посчитано — их остатки не изменятся.` : "");
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await customFetch(`/api/inventory-audits/${audit!.id}/submit`, { method: "POST" });
      await Promise.all([qc.invalidateQueries({ queryKey: ["/api/inventory-audits"] }), qc.invalidateQueries({ queryKey: ["/api/tech-cards"] })]);
      toast({ title: "Инвентаризация проведена", description: "Остатки подразделения обновлены." });
    } catch (e) { toast({ title: "Не удалось провести", description: errMsg(e, ""), variant: "destructive" }); } finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm("Удалить черновик инвентаризации? Введённые данные пропадут.")) return;
    try {
      await customFetch(`/api/inventory-audits/${audit!.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["/api/inventory-audits"] });
      setLocation("/inventory-audits");
    } catch (e) { toast({ title: "Не удалось удалить", description: errMsg(e, ""), variant: "destructive" }); }
  }

  async function addItem(itemId: number) {
    setAddOpen(false);
    try {
      await customFetch(`/api/inventory-audits/${audit!.id}/items`, { method: "POST", body: JSON.stringify({ itemId }) });
      await qc.invalidateQueries({ queryKey });
    } catch (e) { toast({ title: "Не удалось добавить", description: errMsg(e, ""), variant: "destructive" }); }
  }

  const moved = audit.items.filter((l) => Math.abs(l.movedSinceSnapshot) > 0.0005);

  return (
    <div className="space-y-5 pb-24 print:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" onClick={() => setLocation("/inventory-audits")}><ArrowLeft className="mr-2 h-4 w-4" />Все инвентаризации</Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.print()}><Printer className="mr-2 h-4 w-4" />{draft ? "Бланк для пересчёта" : "Печать"}</Button>
          {draft && canDo("manager") && <Button variant="ghost" className="text-destructive" onClick={remove} aria-label="Удалить черновик"><Trash2 className="h-4 w-4" /></Button>}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{audit.title}</h1>
          <p className="text-muted-foreground">
            {audit.locationName} · начата {fmtDate(audit.createdAt)}{audit.createdByName ? ` (${audit.createdByName})` : ""}
            {audit.submittedAt && ` · проведена ${fmtDate(audit.submittedAt)}${audit.submittedByName ? ` (${audit.submittedByName})` : ""}`}
          </p>
        </div>
        <img src={`${import.meta.env.BASE_URL}brand/logo-horizontal.svg`} alt="" className="hidden print:block h-10" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 print:hidden">
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Посчитано</div><div className="mt-1 text-lg font-semibold">{t.counted} из {t.total}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">С расхождением</div><div className="mt-1 text-lg font-semibold">{t.withDiff}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Недостача</div><div className="mt-1 text-lg font-semibold text-destructive">{t.shortageValue ? `−${fmtMoney(t.shortageValue)}` : "—"}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Излишки</div><div className="mt-1 text-lg font-semibold text-emerald-700">{t.surplusValue ? `+${fmtMoney(t.surplusValue)}` : "—"}</div></div>
      </div>

      {draft && moved.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 print:hidden">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>С начала пересчёта менялись остатки {moved.length} позиций (приход, производство, перемещение). Считайте то, что было на полке на момент начала, — разница при проведении применится к текущему остатку.</div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Поиск позиции" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все позиции</SelectItem>
            <SelectItem value="uncounted">Не посчитанные</SelectItem>
            <SelectItem value="diff">С расхождением</SelectItem>
          </SelectContent>
        </Select>
        {draft && (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild><Button variant="outline"><Plus className="mr-2 h-4 w-4" />Добавить позицию</Button></PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="start">
              <Command>
                <CommandInput placeholder="Найти в справочнике…" />
                <CommandList>
                  <CommandEmpty>Ничего не найдено</CommandEmpty>
                  <CommandGroup>{(allItems ?? []).filter((i) => !onSheet.has(i.id)).map((i) => (
                    <CommandItem key={i.id} value={`${i.name} ${i.id}`} onSelect={() => addItem(i.id)}>{i.name}<span className="ml-auto text-xs text-muted-foreground">{i.unit}</span></CommandItem>
                  ))}</CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {!audit.items.length ? (
            <div className="py-12 text-center text-muted-foreground">В подразделении нет позиций с остатками. Добавьте позиции вручную или начните инвентаризацию по всему справочнику.</div>
          ) : !shown.length ? <div className="py-12 text-center text-muted-foreground">Ничего не найдено.</div> : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Позиция</TableHead>
                  <TableHead className="text-right">Учёт</TableHead>
                  <TableHead className="text-right">Факт</TableHead>
                  <TableHead className="text-right">Расхождение</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {grouped.map(([cat, lines]) => [
                    <TableRow key={`c-${cat}`} className="bg-muted/40 hover:bg-muted/40"><TableCell colSpan={4} className="py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{cat}</TableCell></TableRow>,
                    ...lines.map((l) => (
                      <TableRow key={l.id} className={l.status === "shortage" ? "bg-destructive/5" : l.status === "surplus" ? "bg-emerald-50" : ""}>
                        <TableCell>
                          <div className="font-medium">{l.itemName}</div>
                          <div className="text-xs text-muted-foreground">{fmtMoney(l.unitPrice)} / {l.unit}</div>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">{fmtQty(l.systemStock)} {l.unit}</TableCell>
                        <TableCell className="text-right">
                          <div className="print:hidden"><CountInput line={l} disabled={!draft} onSave={(qty) => save(l.itemId, qty)} /></div>
                          <div className="hidden print:block">{l.actualStock == null ? "______________" : `${fmtQty(l.actualStock)} ${l.unit}`}</div>
                        </TableCell>
                        <TableCell className="text-right"><DiffCell line={l} /></TableCell>
                      </TableRow>
                    )),
                  ])}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {draft ? (
        <div className="fixed bottom-0 left-0 right-0 md:left-64 z-10 border-t bg-background/95 backdrop-blur px-4 py-3 print:hidden">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="text-sm"><span className="text-muted-foreground">Посчитано: </span><span className="font-semibold">{t.counted} из {t.total}</span></div>
            <div className="text-sm"><span className="text-muted-foreground">Итог: </span><span className={`font-semibold ${t.balance < 0 ? "text-destructive" : t.balance > 0 ? "text-emerald-700" : ""}`}>{t.balance > 0 ? "+" : ""}{fmtMoney(t.balance)}</span></div>
            <div className="ml-auto flex gap-2">
              {t.counted < t.total && canDo("manager") && <Button variant="outline" onClick={fillUncountedWithSystem} disabled={busy}>Остальное = учёт</Button>}
              {canDo("manager") ? (
                <Button onClick={submit} disabled={busy || t.counted === 0}><CheckCircle2 className="mr-2 h-4 w-4" />Провести</Button>
              ) : <span className="text-sm text-muted-foreground self-center">Провести может менеджер</span>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
