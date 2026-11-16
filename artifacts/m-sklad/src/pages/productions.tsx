import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Factory, AlertTriangle, Undo2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney, fmtQty } from "@/lib/units";

interface ProductionRow {
  id: number; techCardId: number; techCardName: string | null; departmentId: number; departmentName: string | null;
  batches: number; plannedOutput: number; actualOutput: number; outputUnit: string; totalCost: number;
  status: "done" | "cancelled"; notes: string | null; createdAt: string; recordedByName: string | null;
}
interface ProductionDetail extends ProductionRow {
  outputItemQty: number; cancelledAt: string | null;
  outputItem: { id: number; name: string; unit: string } | null;
  lines: { itemId: number; name: string | null; unit: string | null; qty: number; unitPrice: number; cost: number }[];
}
interface PreviewLine { itemId: number; name: string; unit: string; qty: number; unitPrice: number; cost: number; stock: number; shortage: number }
interface Preview { plannedOutput: number; outputUnit: string; totalCost: number; lines: PreviewLine[]; canProduce: boolean }
interface SemiCard { id: number; name: string; departmentId: number | null; outputQty: number; outputUnit: string; isActive: boolean }
interface LocationOption { id: number; name: string; isActive: boolean }

const errMsg = (e: unknown, fallback: string) => (e as { data?: { error?: string } })?.data?.error ?? fallback;
const fmtDate = (s: string) => new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Debounces a value so the preview isn't refetched on every keystroke. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function NewProductionDialog({ open, onOpenChange, initialCardId, locations, semis, defaultDepartmentId }: {
  open: boolean; onOpenChange: (v: boolean) => void; initialCardId: number | null;
  locations: LocationOption[]; semis: SemiCard[]; defaultDepartmentId: number | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [cardId, setCardId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [batches, setBatches] = useState("1");
  const [actual, setActual] = useState("");
  const [actualTouched, setActualTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const card = semis.find((s) => s.id === initialCardId);
    setCardId(card ? String(card.id) : "");
    setDepartmentId(card?.departmentId ? String(card.departmentId) : defaultDepartmentId ? String(defaultDepartmentId) : "");
    setBatches("1"); setActual(""); setActualTouched(false); setNotes("");
  }, [open, initialCardId, semis, defaultDepartmentId]);

  const card = semis.find((s) => String(s.id) === cardId);
  const debouncedBatches = useDebounced(batches);
  const batchesNum = Number(debouncedBatches.replace(",", "."));
  const ready = !!cardId && !!departmentId && batchesNum > 0;
  const { data: preview, error: previewError, isFetching } = useQuery<Preview>({
    queryKey: ["/api/productions/preview", cardId, departmentId, batchesNum],
    queryFn: () => customFetch<Preview>(`/api/productions/preview?techCardId=${cardId}&departmentId=${departmentId}&batches=${batchesNum}`),
    enabled: open && ready,
    retry: false,
  });

  useEffect(() => { if (preview && !actualTouched) setActual(String(preview.plannedOutput)); }, [preview, actualTouched]);

  async function submit() {
    setSaving(true);
    try {
      await customFetch("/api/productions", { method: "POST", body: JSON.stringify({ techCardId: Number(cardId), departmentId: Number(departmentId), batches, actualOutput: actual, notes }) });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/productions"] }),
        qc.invalidateQueries({ queryKey: ["/api/tech-cards"] }),
        qc.invalidateQueries({ queryKey: ["/api/items"] }),
      ]);
      toast({ title: "Акт производства проведён", description: `${card?.name}: ${actual} ${preview?.outputUnit ?? ""} оприходовано` });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Не удалось провести акт", description: errMsg(e, ""), variant: "destructive" });
      void qc.invalidateQueries({ queryKey: ["/api/productions/preview"] });
    } finally {
      setSaving(false);
    }
  }

  const actualNum = Number(actual.replace(",", "."));
  const yieldPct = preview && actualNum > 0 ? (actualNum / preview.plannedOutput) * 100 : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Новый акт производства</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label>Полуфабрикат</Label>
            <Select value={cardId} onValueChange={(v) => { setCardId(v); const c = semis.find((s) => String(s.id) === v); if (c?.departmentId) setDepartmentId(String(c.departmentId)); setActualTouched(false); }}>
              <SelectTrigger><SelectValue placeholder="Выберите тех-карту полуфабриката" /></SelectTrigger>
              <SelectContent>{semis.filter((s) => s.isActive).map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} · {fmtQty(s.outputQty)} {s.outputUnit} за закладку</SelectItem>)}</SelectContent>
            </Select>
            {!semis.length && <p className="text-xs text-muted-foreground">Нет тех-карт с типом «Полуфабрикат». Создайте её в разделе «Тех-карты».</p>}
          </div>
          <div className="space-y-1.5"><Label>Подразделение</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger><SelectValue placeholder="Где готовим" /></SelectTrigger>
              <SelectContent>{locations.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Сырьё списывается и полуфабрикат приходуется здесь.</p>
          </div>
          <div className="space-y-1.5"><Label>Количество закладок</Label>
            <Input inputMode="decimal" value={batches} onChange={(e) => { setBatches(e.target.value); setActualTouched(false); }} />
            {card && <p className="text-xs text-muted-foreground">План: {fmtQty(card.outputQty * (Number(batches.replace(",", ".")) || 0))} {card.outputUnit}</p>}
          </div>
        </div>

        {previewError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errMsg(previewError, "Не удалось рассчитать")}</div>
        ) : preview && ready ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">Будет списано{isFetching && <span className="text-muted-foreground font-normal"> · пересчёт…</span>}</div>
            <div className="rounded-lg border max-h-64 overflow-y-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Продукт</TableHead><TableHead className="text-right">Списать</TableHead><TableHead className="text-right">Есть</TableHead><TableHead className="text-right">Сумма</TableHead></TableRow></TableHeader>
                <TableBody>
                  {preview.lines.map((l) => (
                    <TableRow key={l.itemId} className={l.shortage > 0 ? "bg-destructive/5" : ""}>
                      <TableCell>{l.name}{l.shortage > 0 && <div className="text-xs text-destructive">не хватает {fmtQty(l.shortage)} {l.unit}</div>}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(l.qty)} {l.unit}</TableCell>
                      <TableCell className={`text-right whitespace-nowrap ${l.shortage > 0 ? "text-destructive font-semibold" : "text-muted-foreground"}`}>{fmtQty(l.stock)} {l.unit}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(l.cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="text-sm text-right">Себестоимость партии: <span className="font-semibold">{fmtMoney(preview.totalCost)}</span></div>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Фактический выход{preview ? `, ${preview.outputUnit}` : ""}</Label>
            <Input inputMode="decimal" value={actual} onChange={(e) => { setActual(e.target.value); setActualTouched(true); }} disabled={!preview} />
            {yieldPct != null && Math.abs(yieldPct - 100) >= 0.5 && (
              <p className={`text-xs ${yieldPct < 90 ? "text-amber-700" : "text-muted-foreground"}`}>{fmtQty(yieldPct, 1)}% от плана — себестоимость единицы пересчитается по факту</p>
            )}
          </div>
          <div className="space-y-1.5"><Label>Комментарий</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Необязательно" /></div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button onClick={submit} disabled={saving || !preview || !preview.canProduce || !(actualNum > 0) || isFetching}>
            {saving ? "Проводим…" : preview && !preview.canProduce ? "Не хватает продуктов" : "Провести акт"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProductionDetailDialog({ id, onClose, canCancel }: { id: number | null; onClose: () => void; canCancel: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: p } = useQuery<ProductionDetail>({ queryKey: ["/api/productions", id], queryFn: () => customFetch<ProductionDetail>(`/api/productions/${id}`), enabled: id != null });
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (!p || !window.confirm("Отменить акт? Сырьё вернётся на склад, полуфабрикат будет списан.")) return;
    setBusy(true);
    try {
      await customFetch(`/api/productions/${p.id}/cancel`, { method: "POST" });
      await Promise.all([qc.invalidateQueries({ queryKey: ["/api/productions"] }), qc.invalidateQueries({ queryKey: ["/api/tech-cards"] })]);
      toast({ title: "Акт отменён" });
      onClose();
    } catch (e) {
      toast({ title: "Не удалось отменить", description: errMsg(e, ""), variant: "destructive" });
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={id != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Акт производства №{id}</DialogTitle></DialogHeader>
        {!p ? <div className="py-8 text-center text-muted-foreground">Загрузка…</div> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-muted-foreground text-xs">Полуфабрикат</div><div className="font-medium">{p.techCardName}</div></div>
              <div><div className="text-muted-foreground text-xs">Подразделение</div><div className="font-medium">{p.departmentName}</div></div>
              <div><div className="text-muted-foreground text-xs">Выход: факт / план</div><div className="font-medium">{fmtQty(p.actualOutput)} / {fmtQty(p.plannedOutput)} {p.outputUnit} ({fmtQty(p.batches)} закл.)</div></div>
              <div><div className="text-muted-foreground text-xs">Оприходовано</div><div className="font-medium">{fmtQty(p.outputItemQty)} {p.outputItem?.unit} · {p.outputItem?.name}</div></div>
              <div><div className="text-muted-foreground text-xs">Себестоимость</div><div className="font-medium">{fmtMoney(p.totalCost)} · {fmtMoney(p.totalCost / (p.outputItemQty || 1))}/{p.outputItem?.unit}</div></div>
              <div><div className="text-muted-foreground text-xs">Провёл</div><div className="font-medium">{p.recordedByName ?? "—"} · {fmtDate(p.createdAt)}</div></div>
            </div>
            {p.status === "cancelled" && <Badge variant="destructive">Отменён {p.cancelledAt ? fmtDate(p.cancelledAt) : ""}</Badge>}
            {p.notes && <p className="text-sm whitespace-pre-wrap rounded-lg bg-muted/50 p-3">{p.notes}</p>}
            <div className="rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>Списано</TableHead><TableHead className="text-right">Кол-во</TableHead><TableHead className="text-right">Цена</TableHead><TableHead className="text-right">Сумма</TableHead></TableRow></TableHeader>
                <TableBody>{p.lines.map((l) => (
                  <TableRow key={l.itemId}><TableCell>{l.name}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtQty(l.qty)} {l.unit}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(l.unitPrice)}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(l.cost)}</TableCell></TableRow>
                ))}</TableBody>
              </Table>
            </div>
            {canCancel && p.status === "done" && (
              <div className="flex justify-end"><Button variant="outline" className="text-destructive" onClick={cancel} disabled={busy}><Undo2 className="mr-2 h-4 w-4" />Отменить акт</Button></div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Productions() {
  const { canDo, isLoading: roleLoading, user } = useCurrentUser();
  const [department, setDepartment] = useState("all");
  const [newOpen, setNewOpen] = useState(false);
  const [initialCardId, setInitialCardId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: locations } = useQuery<LocationOption[]>({ queryKey: ["/api/locations"], queryFn: () => customFetch<LocationOption[]>("/api/locations") });
  const { data: semis } = useQuery<SemiCard[]>({ queryKey: ["/api/tech-cards", "all", "semi"], queryFn: () => customFetch<SemiCard[]>("/api/tech-cards?kind=semi") });
  const { data: rows, isLoading } = useQuery<ProductionRow[]>({
    queryKey: ["/api/productions", department],
    queryFn: () => customFetch<ProductionRow[]>(`/api/productions${department !== "all" ? `?departmentId=${department}` : ""}`),
  });

  // "Произвести" on a semi tech card links here with ?new=<cardId>.
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("new"));
    if (id && semis) { setInitialCardId(id); setNewOpen(true); window.history.replaceState(null, "", window.location.pathname); }
  }, [semis]);

  const totals = useMemo(() => (rows ?? []).filter((r) => r.status === "done").reduce((s, r) => s + r.totalCost, 0), [rows]);

  if (roleLoading) return null;
  if (!canDo("warehouse")) return <AccessDenied />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Производство</h1>
          <p className="text-muted-foreground">Акты производства полуфабрикатов: сырьё списывается по тех-карте, готовый полуфабрикат приходуется на склад подразделения.</p>
        </div>
        <Button onClick={() => { setInitialCardId(null); setNewOpen(true); }}><Plus className="mr-2 h-4 w-4" />Новый акт</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все подразделения</SelectItem>
            {locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {!!rows?.length && <span className="text-sm text-muted-foreground">Произведено на {fmtMoney(totals)}</span>}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !rows?.length ? (
            <div className="py-12 text-center text-muted-foreground"><Factory className="mx-auto mb-3 h-8 w-8 opacity-40" />Актов производства пока нет.</div>
          ) : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Дата</TableHead><TableHead>Полуфабрикат</TableHead><TableHead>Подразделение</TableHead>
                  <TableHead className="text-right">Выход (факт / план)</TableHead><TableHead className="text-right">Себестоимость</TableHead><TableHead>Провёл</TableHead>
                </TableRow></TableHeader>
                <TableBody>{rows.map((r) => {
                  const low = r.actualOutput < r.plannedOutput * 0.9;
                  return (
                    <TableRow key={r.id} className={`cursor-pointer ${r.status === "cancelled" ? "opacity-50" : ""}`} onClick={() => setDetailId(r.id)}>
                      <TableCell className="whitespace-nowrap">{fmtDate(r.createdAt)}</TableCell>
                      <TableCell className="font-medium">{r.techCardName}{r.status === "cancelled" && <Badge variant="outline" className="ml-2">отменён</Badge>}</TableCell>
                      <TableCell>{r.departmentName}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {fmtQty(r.actualOutput)} / {fmtQty(r.plannedOutput)} {r.outputUnit}
                        {low && <AlertTriangle className="inline ml-1 h-3.5 w-3.5 text-amber-600" aria-label="Выход ниже плана" />}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(r.totalCost)}</TableCell>
                      <TableCell>{r.recordedByName ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <NewProductionDialog open={newOpen} onOpenChange={setNewOpen} initialCardId={initialCardId} locations={locations ?? []} semis={semis ?? []} defaultDepartmentId={user?.locationId ?? null} />
      <ProductionDetailDialog id={detailId} onClose={() => setDetailId(null)} canCancel={canDo("manager")} />
    </div>
  );
}
