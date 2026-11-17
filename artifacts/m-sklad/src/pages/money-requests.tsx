import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Wallet, FileText, ReceiptText, HandCoins, Paperclip, Trash2, Check, X, Ban, Banknote, Send, Undo2, AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { DEPARTMENTS, errMsg, fmtDayTime, fmtMoney, todayLocal } from "@/lib/personnel";

type Kind = "advance" | "payment" | "reimbursement";
type Status = "pending" | "approved" | "issued" | "reported" | "closed" | "rejected" | "cancelled";
type Action = "approve" | "reject" | "cancel" | "issue" | "pay" | "report" | "return_report" | "close";
interface Row {
  id: number; kind: Kind; status: Status; title: string; amountRequested: number; amountApproved: number | null; amountIssued: number | null; amountSpent: number | null; settlement: number | null;
  neededBy: string | null; reportDueAt: string | null; reportOverdue: boolean; staffName: string | null; counterpartyName: string | null; requesterName: string; createdAt: string; department: string | null;
}
interface Est { name: string; qty: number; unit: string; price: number }
interface Rep { name: string; amount: number; file: string | null; url?: string | null }
interface Detail extends Row {
  purpose: string | null; estimate: Est[]; files: { file: string; url: string }[]; report: Rep[]; payMethod: string | null; staffPosition: string | null; counterpartyPhone: string | null;
  approvedByName: string | null; issuedByName: string | null; closedByName: string | null; approvedAt: string | null; issuedAt: string | null; reportedAt: string | null; closedAt: string | null;
  events: { id: number; kind: string; text: string; createdAt: string; authorName: string }[]; actions: Action[]; canEdit: boolean;
}
interface Summary { isApprover: boolean; isCashier: boolean; seesAll: boolean; hasStaffCard: boolean; toApprove: Sum | null; toPay: Sum | null; toCheck: Sum | null; advances: Sum | null; advancesOverdue: number | null; myOpen: Sum; myToReport: Sum | null }
interface Sum { count: number; sum: number }
interface Options { staff: { id: number; name: string; position: string | null; department: string | null }[]; counterparties: { id: number; name: string; category: string | null }[]; myStaffId: number | null }
interface Holder { staffId: number | null; name: string; position: string | null; total: number; count: number; overdue: number; oldest: string | null }

const KIND: Record<Kind, { label: string; hint: string; icon: typeof Wallet }> = {
  advance: { label: "Под отчёт", hint: "Выдать деньги на покупку, потом отчитаться чеками и вернуть остаток", icon: HandCoins },
  payment: { label: "Оплата по счёту", hint: "Оплатить поставщику или за услугу — переводом или наличными", icon: FileText },
  reimbursement: { label: "Компенсация", hint: "Сотрудник уже заплатил своими — вернуть по чекам", icon: ReceiptText },
};
const STATUS: Record<Status, { label: string; cls: string }> = {
  pending: { label: "На согласовании", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  approved: { label: "Согласовано", cls: "bg-sky-100 text-sky-900 border-sky-200" },
  issued: { label: "Выдано, ждём отчёт", cls: "bg-violet-100 text-violet-900 border-violet-200" },
  reported: { label: "Отчёт на проверке", cls: "bg-indigo-100 text-indigo-900 border-indigo-200" },
  closed: { label: "Закрыто", cls: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  rejected: { label: "Отклонено", cls: "bg-red-100 text-red-800 border-red-200" },
  cancelled: { label: "Отменено", cls: "bg-muted text-muted-foreground" },
};
const statusLabel = (r: { status: Status; kind: Kind }) => (r.status === "approved" ? (r.kind === "advance" ? "Ждёт выдачи" : "Ждёт оплаты") : STATUS[r.status].label);
const METHOD: Record<string, string> = { cash: "Наличными", transfer: "Переводом", card: "Картой" };
const UNITS = ["шт", "кг", "г", "л", "мл", "уп", "пучок", "услуга"];

/** Phone photos are huge: shrink images to ~1600px JPEG before upload; PDFs go as is. */
async function uploadFile(file: File): Promise<{ file: string; url: string }> {
  let data: string;
  if (file.type.startsWith("image/")) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    data = c.toDataURL("image/jpeg", 0.8);
  } else if (file.type === "application/pdf") {
    if (file.size > 4_000_000) throw new Error("PDF больше 4 МБ");
    data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(file); });
  } else throw new Error("Можно прикрепить фото или PDF");
  return customFetch("/api/money-requests/files", { method: "POST", body: JSON.stringify({ data }) });
}

function FilePick({ onFile, label = "Прикрепить", small }: { onFile: (f: { file: string; url: string }) => void; label?: string; small?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  return <>
    <input ref={ref} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={async (e) => {
      const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
      setBusy(true);
      try { onFile(await uploadFile(f)); } catch (err) { toast({ title: "Файл не загружен", description: errMsg(err) ?? (err as Error).message, variant: "destructive" }); } finally { setBusy(false); }
    }} />
    <Button type="button" variant="outline" size={small ? "sm" : "default"} disabled={busy} onClick={() => ref.current?.click()}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Paperclip className="mr-1.5 h-4 w-4" />}{label}</Button>
  </>;
}

function ReportEditor({ lines, setLines }: { lines: Rep[]; setLines: (l: Rep[]) => void }) {
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="min-w-40 flex-1" placeholder="Что куплено" value={l.name} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <Input className="w-28" type="number" min={0} placeholder="Сумма" value={l.amount || ""} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, amount: Number(e.target.value) } : x)))} />
          {l.file ? <a href={l.url ?? "#"} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-emerald-700"><Check className="h-4 w-4" />чек</a>
            : <FilePick small label="Чек" onFile={(f) => setLines(lines.map((x, k) => (k === i ? { ...x, file: f.file, url: f.url } : x)))} />}
          <Button type="button" variant="ghost" size="icon" aria-label="Удалить строку" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { name: "", amount: 0, file: null }])}><Plus className="mr-1 h-4 w-4" />Строка</Button>
        <div className="text-sm">Итого: <b>{fmtMoney(total)}</b></div>
      </div>
    </div>
  );
}

type Form = { kind: Kind; title: string; purpose: string; staffId: string; counterpartyId: string; department: string; neededBy: string; payMethod: string; amount: string; estimate: Est[]; report: Rep[]; files: { file: string; url: string }[] };

function NewRequest({ options, onDone, canPickStaff }: { options: Options; onDone: (id: number) => void; canPickStaff: boolean }) {
  const { toast } = useToast();
  const [f, setF] = useState<Form>({ kind: "advance", title: "", purpose: "", staffId: options.myStaffId ? String(options.myStaffId) : "", counterpartyId: "", department: "", neededBy: "", payMethod: "", amount: "", estimate: [], report: [{ name: "", amount: 0, file: null }], files: [] });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const estTotal = f.estimate.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const total = f.kind === "reimbursement" ? f.report.reduce((s, l) => s + (Number(l.amount) || 0), 0) : f.estimate.length ? estTotal : Number(f.amount) || 0;
  async function save() {
    setSaving(true);
    try {
      const body = { kind: f.kind, title: f.title, purpose: f.purpose || null, staffId: f.kind === "payment" ? null : f.staffId ? Number(f.staffId) : null, counterpartyId: f.kind === "payment" && f.counterpartyId ? Number(f.counterpartyId) : null,
        department: f.department || null, neededBy: f.neededBy || null, payMethod: f.payMethod || null, files: f.files.map((x) => x.file),
        ...(f.kind === "reimbursement" ? { report: f.report.map(({ name, amount, file }) => ({ name, amount, file })) } : f.estimate.length ? { estimate: f.estimate } : { amount: Number(f.amount) }) };
      const r = await customFetch<{ id: number }>("/api/money-requests", { method: "POST", body: JSON.stringify(body) });
      toast({ title: `Запрос №${r.id} отправлен на согласование` }); onDone(r.id);
    } catch (e) { toast({ title: "Не отправлено", description: errMsg(e), variant: "destructive" }); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(KIND) as Kind[]).map((k) => { const K = KIND[k]; return (
          <button key={k} type="button" onClick={() => set("kind", k)} className={`rounded-lg border p-3 text-left transition ${f.kind === k ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50"}`}>
            <div className="flex items-center gap-2 font-medium"><K.icon className="h-4 w-4" />{K.label}</div><div className="mt-1 text-xs text-muted-foreground">{K.hint}</div>
          </button>); })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2"><Label>На что *</Label><Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder={f.kind === "payment" ? "Оплата за мясо по счёту №45" : f.kind === "advance" ? "Закупка овощей на рынке" : "Купил моющее средство"} /></div>
        {f.kind === "payment" ? (
          <div className="space-y-1.5"><Label>Получатель</Label>
            <Select value={f.counterpartyId || "none"} onValueChange={(v) => set("counterpartyId", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Не из контрагентов (укажите в описании)</SelectItem>{options.counterparties.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}{c.category ? ` · ${c.category}` : ""}</SelectItem>)}</SelectContent></Select></div>
        ) : (
          <div className="space-y-1.5"><Label>Кому выдать</Label>
            <Select value={f.staffId || "none"} onValueChange={(v) => set("staffId", v === "none" ? "" : v)} disabled={!canPickStaff && !!options.myStaffId}><SelectTrigger><SelectValue placeholder="Выберите сотрудника" /></SelectTrigger>
              <SelectContent>{options.staff.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}{s.id === options.myStaffId ? " (я)" : ""}</SelectItem>)}</SelectContent></Select></div>
        )}
        <div className="space-y-1.5"><Label>Отдел</Label>
          <Select value={f.department || "none"} onValueChange={(v) => set("department", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Не указан</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
        {f.kind !== "reimbursement" && <div className="space-y-1.5"><Label>Нужно к</Label><Input type="date" min={todayLocal()} value={f.neededBy} onChange={(e) => set("neededBy", e.target.value)} /></div>}
        <div className="space-y-1.5"><Label>Как удобнее получить</Label>
          <Select value={f.payMethod || "none"} onValueChange={(v) => set("payMethod", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Не важно</SelectItem>{Object.entries(METHOD).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Описание{f.kind === "payment" ? " / реквизиты" : ""}</Label><Textarea rows={2} value={f.purpose} onChange={(e) => set("purpose", e.target.value)} /></div>
      </div>

      {f.kind === "reimbursement" ? (
        <div className="space-y-2 rounded-lg border p-3"><div className="font-medium">Чеки</div><ReportEditor lines={f.report} setLines={(l) => set("report", l)} /></div>
      ) : (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between"><div className="font-medium">Смета</div>
            {!f.estimate.length && <Button type="button" variant="outline" size="sm" onClick={() => set("estimate", [{ name: "", qty: 1, unit: "шт", price: 0 }])}><Plus className="mr-1 h-4 w-4" />Расписать по позициям</Button>}</div>
          {!f.estimate.length ? (
            <div className="flex items-center gap-2"><Input className="w-48" type="number" min={0} placeholder="Сумма, сом" value={f.amount} onChange={(e) => set("amount", e.target.value)} /><span className="text-xs text-muted-foreground">или распишите по позициям — так согласуют быстрее</span></div>
          ) : <>
            {f.estimate.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input className="min-w-40 flex-1" placeholder="Позиция" value={l.name} onChange={(e) => set("estimate", f.estimate.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                <Input className="w-20" type="number" min={0} step="any" value={l.qty || ""} onChange={(e) => set("estimate", f.estimate.map((x, k) => (k === i ? { ...x, qty: Number(e.target.value) } : x)))} />
                <Select value={l.unit} onValueChange={(v) => set("estimate", f.estimate.map((x, k) => (k === i ? { ...x, unit: v } : x)))}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent></Select>
                <Input className="w-28" type="number" min={0} placeholder="Цена" value={l.price || ""} onChange={(e) => set("estimate", f.estimate.map((x, k) => (k === i ? { ...x, price: Number(e.target.value) } : x)))} />
                <span className="w-24 text-right text-sm tabular-nums">{fmtMoney((l.qty || 0) * (l.price || 0))}</span>
                <Button type="button" variant="ghost" size="icon" aria-label="Удалить позицию" onClick={() => set("estimate", f.estimate.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => set("estimate", [...f.estimate, { name: "", qty: 1, unit: "шт", price: 0 }])}><Plus className="mr-1 h-4 w-4" />Позиция</Button>
          </>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FilePick label={f.kind === "payment" ? "Прикрепить счёт" : "Прикрепить документ"} onFile={(x) => set("files", [...f.files, x])} />
        {f.files.map((x, i) => <a key={x.file} href={x.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border px-2 py-1 text-xs"><Paperclip className="h-3 w-3" />файл {i + 1}</a>)}
      </div>
      <div className="flex items-center justify-between border-t pt-3">
        <div className="text-lg">Сумма: <b>{fmtMoney(total)}</b></div>
        <Button onClick={save} disabled={saving || !f.title.trim() || !(total > 0)}>{saving ? "…" : "Отправить на согласование"}</Button>
      </div>
    </div>
  );
}

function RequestDialog({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ["/api/money-requests", id];
  const { data: r } = useQuery<Detail>({ queryKey: key, queryFn: () => customFetch(`/api/money-requests/${id}`) });
  const [comment, setComment] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [lines, setLines] = useState<Rep[] | null>(null);
  const [docs, setDocs] = useState<{ file: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  async function post(path: string, body: unknown) {
    setBusy(true);
    try { const d = await customFetch<Detail>(`/api/money-requests/${id}${path}`, { method: "POST", body: JSON.stringify(body) }); qc.setQueryData(key, d); onChanged(); setComment(""); setAmount(""); setLines(null); setDocs([]); return true; }
    catch (e) { toast({ title: "Не получилось", description: errMsg(e), variant: "destructive" }); return false; } finally { setBusy(false); }
  }
  if (!r) return <DialogContent className="max-w-2xl"><div className="p-8 text-center text-muted-foreground">Загрузка…</div></DialogContent>;
  const has = (a: Action) => r.actions.includes(a);
  const K = KIND[r.kind];
  const issued = r.amountIssued ?? 0;
  const reportTotal = (lines ?? []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const steps = r.kind === "advance" ? ["pending", "approved", "issued", "reported", "closed"] : ["pending", "approved", "closed"];
  const at = steps.indexOf(r.status);

  return (
    <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle className="pr-6">№{r.id} · {r.title}</DialogTitle></DialogHeader>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5"><K.icon className="h-4 w-4" />{K.label}</span>
        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS[r.status].cls}`}>{statusLabel(r)}</span>
        {r.reportOverdue && <Badge variant="outline" className="border-red-300 text-red-700"><AlertTriangle className="mr-1 h-3 w-3" />отчёт просрочен</Badge>}
      </div>
      {at >= 0 && <div className="flex gap-1">{steps.map((s, i) => <div key={s} className={`h-1.5 flex-1 rounded ${i <= at ? "bg-primary" : "bg-muted"}`} title={STATUS[s as Status].label} />)}</div>}

      <div className="grid gap-x-6 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
        <div><span className="text-muted-foreground">Запросил(а): </span>{r.requesterName}</div>
        <div><span className="text-muted-foreground">{r.kind === "payment" ? "Получатель: " : "Кому: "}</span>{r.kind === "payment" ? r.counterpartyName ?? "см. описание" : r.staffName ?? "—"}</div>
        <div><span className="text-muted-foreground">Запрошено: </span><b>{fmtMoney(r.amountRequested)}</b></div>
        {r.amountApproved != null && <div><span className="text-muted-foreground">Согласовано: </span><b>{fmtMoney(r.amountApproved)}</b>{r.approvedByName && <span className="text-muted-foreground"> · {r.approvedByName}</span>}</div>}
        {r.amountIssued != null && <div><span className="text-muted-foreground">{r.kind === "advance" ? "Выдано: " : "Оплачено: "}</span><b>{fmtMoney(r.amountIssued)}</b>{r.payMethod && <span className="text-muted-foreground"> · {METHOD[r.payMethod]?.toLowerCase()}</span>}</div>}
        {r.amountSpent != null && r.kind === "advance" && <div><span className="text-muted-foreground">Потрачено по чекам: </span><b>{fmtMoney(r.amountSpent)}</b></div>}
        {r.settlement != null && r.settlement !== 0 && <div className="sm:col-span-2">{r.settlement > 0 ? `Остаток ${fmtMoney(r.settlement)} возвращён в кассу` : `Перерасход ${fmtMoney(-r.settlement)} выплачен сотруднику`}</div>}
        {r.neededBy && <div><span className="text-muted-foreground">Нужно к: </span>{new Date(r.neededBy).toLocaleDateString("ru-RU")}</div>}
        {r.reportDueAt && r.status === "issued" && <div><span className="text-muted-foreground">Отчитаться до: </span>{new Date(r.reportDueAt).toLocaleDateString("ru-RU")}</div>}
        {r.department && <div><span className="text-muted-foreground">Отдел: </span>{DEPARTMENTS[r.department]}</div>}
      </div>
      {r.purpose && <p className="whitespace-pre-wrap text-sm">{r.purpose}</p>}

      {r.estimate.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>Смета</TableHead><TableHead className="text-right">Кол-во</TableHead><TableHead className="text-right">Цена</TableHead><TableHead className="text-right">Сумма</TableHead></TableRow></TableHeader>
        <TableBody>{r.estimate.map((l, i) => <TableRow key={i}><TableCell>{l.name}</TableCell><TableCell className="text-right tabular-nums">{l.qty} {l.unit}</TableCell><TableCell className="text-right tabular-nums">{fmtMoney(l.price)}</TableCell><TableCell className="text-right tabular-nums">{fmtMoney(l.qty * l.price)}</TableCell></TableRow>)}</TableBody></Table></div>}
      {r.report.length > 0 && <div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>{r.kind === "reimbursement" ? "Чеки" : "Отчёт"}</TableHead><TableHead className="text-right">Сумма</TableHead><TableHead className="text-right">Чек</TableHead></TableRow></TableHeader>
        <TableBody>{r.report.map((l, i) => <TableRow key={i}><TableCell>{l.name}</TableCell><TableCell className="text-right tabular-nums">{fmtMoney(l.amount)}</TableCell><TableCell className="text-right">{l.url ? <a className="text-primary hover:underline" href={l.url} target="_blank" rel="noreferrer">открыть</a> : <span className="text-xs text-amber-700">нет чека</span>}</TableCell></TableRow>)}</TableBody></Table></div>}
      {r.files.length > 0 && <div className="flex flex-wrap gap-2">{r.files.map((x, i) => <a key={x.file} href={x.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"><Paperclip className="h-3 w-3" />документ {i + 1}</a>)}</div>}

      {r.actions.length > 0 && (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          {has("approve") && <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">Согласовать сумму</Label><Input className="w-40" type="number" placeholder={String(r.amountRequested)} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <Button disabled={busy} onClick={() => post("/action", { action: "approve", amount: amount || null, comment })}><Check className="mr-1.5 h-4 w-4" />Согласовать</Button>
            <Button variant="outline" disabled={busy} onClick={() => comment.trim() ? post("/action", { action: "reject", comment }) : toast({ title: "Напишите причину отказа в комментарии", variant: "destructive" })}><X className="mr-1.5 h-4 w-4" />Отклонить</Button>
          </div>}
          {(has("issue") || has("pay")) && <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">Сумма</Label><Input className="w-36" type="number" placeholder={String(r.amountApproved ?? r.amountRequested)} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">Способ</Label><Select value={method || r.payMethod || "cash"} onValueChange={setMethod}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(METHOD).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
            <FilePick small label={docs.length ? `Документов: ${docs.length}` : "Платёжка/расписка"} onFile={(x) => setDocs([...docs, x])} />
            <Button disabled={busy} onClick={() => post("/action", { action: has("issue") ? "issue" : "pay", amount: amount || null, payMethod: method || r.payMethod || "cash", files: docs.map((d) => d.file), comment })}><Banknote className="mr-1.5 h-4 w-4" />{has("issue") ? "Выдать под отчёт" : "Оплачено"}</Button>
          </div>}
          {has("report") && (lines == null ? <Button onClick={() => setLines(r.report.length ? r.report : [{ name: "", amount: 0, file: null }])}><ReceiptText className="mr-1.5 h-4 w-4" />Отчитаться чеками</Button> : (
            <div className="space-y-2">
              <div className="font-medium">Отчёт по выданным {fmtMoney(issued)}</div>
              <ReportEditor lines={lines} setLines={setLines} />
              <div className="text-sm">{issued - reportTotal > 0 ? <>Вернуть в кассу: <b>{fmtMoney(issued - reportTotal)}</b></> : issued - reportTotal < 0 ? <>Перерасход: <b>{fmtMoney(reportTotal - issued)}</b> — вам доплатят после проверки</> : "Потрачено ровно"}</div>
              <div className="flex gap-2"><Button disabled={busy || !reportTotal} onClick={() => post("/action", { action: "report", report: lines.map(({ name, amount, file }) => ({ name, amount, file })), comment })}><Send className="mr-1.5 h-4 w-4" />Сдать отчёт</Button><Button variant="ghost" onClick={() => setLines(null)}>Отмена</Button></div>
            </div>
          ))}
          {has("close") && <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{(r.amountIssued ?? 0) - (r.amountSpent ?? 0) > 0 ? `Примите остаток ${fmtMoney((r.amountIssued ?? 0) - (r.amountSpent ?? 0))} в кассу` : (r.amountIssued ?? 0) - (r.amountSpent ?? 0) < 0 ? `Выплатите перерасход ${fmtMoney((r.amountSpent ?? 0) - (r.amountIssued ?? 0))}` : "Расчёт сходится"}</span>
            <Button disabled={busy} onClick={() => post("/action", { action: "close", comment })}><Check className="mr-1.5 h-4 w-4" />Принять отчёт и закрыть</Button>
            <Button variant="outline" disabled={busy} onClick={() => comment.trim() ? post("/action", { action: "return_report", comment }) : toast({ title: "Напишите в комментарии, что не так", variant: "destructive" })}><Undo2 className="mr-1.5 h-4 w-4" />Вернуть отчёт</Button>
          </div>}
          {has("cancel") && <Button variant="ghost" size="sm" disabled={busy} onClick={() => post("/action", { action: "cancel", comment })}><Ban className="mr-1.5 h-4 w-4" />Отменить запрос</Button>}
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="text-sm font-medium">История</div>
        {r.events.map((e) => <div key={e.id} className={`text-sm ${e.kind === "comment" ? "rounded-lg bg-muted/50 px-3 py-2" : "text-xs text-muted-foreground"}`}><span className="font-medium text-foreground/80">{e.authorName}</span> · {fmtDayTime(e.createdAt)}{e.kind === "comment" ? <div className="mt-0.5 whitespace-pre-wrap">{e.text}</div> : <> — {e.text}</>}</div>)}
        <div className="flex gap-2"><Textarea rows={2} className="min-h-0 resize-none" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (для отказа и возврата отчёта — обязательно)" />
          <Button className="self-end" variant="outline" disabled={busy || !comment.trim()} onClick={() => post("/comments", { text: comment })} aria-label="Отправить комментарий"><Send className="h-4 w-4" /></Button></div>
      </div>
    </DialogContent>
  );
}

export default function MoneyRequests() {
  const { user, isLoading } = useCurrentUser();
  const qc = useQueryClient();
  const { data: s } = useQuery<Summary>({ queryKey: ["/api/money-requests/summary"], queryFn: () => customFetch("/api/money-requests/summary"), enabled: !!user });
  const { data: options } = useQuery<Options>({ queryKey: ["/api/money-requests/options"], queryFn: () => customFetch("/api/money-requests/options"), enabled: !!user });
  const [view, setView] = useState("mine");
  const [status, setStatus] = useState("open");
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const qs = `view=${view}&status=${status}`;
  const { data: rows } = useQuery<Row[]>({ queryKey: ["/api/money-requests", qs], queryFn: () => customFetch(`/api/money-requests?${qs}`), enabled: !!user && view !== "holders", refetchInterval: 30_000 });
  const { data: holders } = useQuery<Holder[]>({ queryKey: ["/api/money-requests/advances"], queryFn: () => customFetch("/api/money-requests/advances"), enabled: !!s?.seesAll && view === "holders" });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/money-requests"] }); void qc.invalidateQueries({ queryKey: ["/api/money-requests/summary"] }); void qc.invalidateQueries({ queryKey: ["/api/money-requests/advances"] }); };
  const tabs = useMemo(() => {
    const t: [string, string, number?][] = [["mine", "Мои запросы", s?.myOpen.count]];
    if (s?.isApprover) t.push(["approve", "На согласование", s.toApprove?.count]);
    if (s?.isCashier) t.push(["accounting", "Выдать и проверить", (s.toPay?.count ?? 0) + (s.toCheck?.count ?? 0)]);
    if (s?.seesAll) t.push(["holders", "Подотчёт"], ["all", "Все запросы"]);
    return t;
  }, [s]);
  if (isLoading || !user) return null;

  const card = (label: string, v: Sum | null | undefined, extra?: string, tone = "") => v && (
    <div className={`rounded-xl border p-3 ${v.count ? tone : "bg-card"}`}><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 text-lg font-semibold">{v.count} · {fmtMoney(v.sum)}</div>{extra && <div className="text-xs text-muted-foreground">{extra}</div>}</div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Запросы денег</h1>
          <p className="text-muted-foreground">Под отчёт, оплата счетов и компенсация расходов: смета → согласование → выдача → отчёт чеками.</p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={!options}><Plus className="mr-2 h-4 w-4" />Новый запрос</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {card("Ждут согласования", s?.toApprove, undefined, "border-amber-300 bg-amber-50")}
        {card("К выдаче и оплате", s?.toPay, undefined, "border-sky-300 bg-sky-50")}
        {card("Отчёты на проверке", s?.toCheck, undefined, "border-indigo-300 bg-indigo-50")}
        {card("Сейчас под отчётом", s?.advances, s?.advancesOverdue ? `просрочено отчётов: ${s.advancesOverdue}` : undefined, s?.advancesOverdue ? "border-red-300 bg-red-50" : "")}
        {!s?.seesAll && card("Мои открытые", s?.myOpen)}
        {!s?.seesAll && card("Нужно отчитаться", s?.myToReport, undefined, "border-red-300 bg-red-50")}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={setView}><TabsList className="h-auto flex-wrap">{tabs.map(([v, l, n]) => <TabsTrigger key={v} value={v}>{l}{n ? <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{n}</span> : null}</TabsTrigger>)}</TabsList></Tabs>
        {(view === "mine" || view === "all") && <div className="flex rounded-lg border p-0.5">{[["open", "Открытые"], ["closed", "Закрытые"], ["rejected", "Отклонённые"], ["all", "Все"]].map(([v, l]) => <button key={v} type="button" onClick={() => setStatus(v)} className={`rounded-md px-2.5 py-1 text-sm ${status === v ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{l}</button>)}</div>}
      </div>

      {view === "holders" ? (
        <Card><CardContent className="overflow-x-auto p-0"><Table>
          <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead className="text-right">Запросов</TableHead><TableHead className="text-right">Сумма на руках</TableHead><TableHead>Выдано</TableHead><TableHead className="text-right">Просрочено</TableHead></TableRow></TableHeader>
          <TableBody>{!holders?.length ? <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Ни у кого нет неотчитанных денег</TableCell></TableRow> : holders.map((h) => (
            <TableRow key={String(h.staffId)}><TableCell><div className="font-medium">{h.name}</div><div className="text-xs text-muted-foreground">{h.position}</div></TableCell><TableCell className="text-right">{h.count}</TableCell><TableCell className="text-right font-semibold tabular-nums">{fmtMoney(h.total)}</TableCell><TableCell className="text-sm text-muted-foreground">{h.oldest ? `с ${fmtDayTime(h.oldest)}` : "—"}</TableCell><TableCell className={`text-right ${h.overdue ? "font-semibold text-red-700" : "text-muted-foreground"}`}>{h.overdue || "—"}</TableCell></TableRow>
          ))}</TableBody>
        </Table></CardContent></Card>
      ) : !rows?.length ? <Card><CardContent className="py-12 text-center text-muted-foreground">Запросов нет</CardContent></Card> : (
        <Card className="divide-y overflow-hidden">
          {rows.map((r) => { const K = KIND[r.kind]; const amt = r.amountIssued ?? r.amountApproved ?? r.amountRequested; return (
            <button key={r.id} type="button" onClick={() => setOpen(r.id)} className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-muted/40 ${r.reportOverdue ? "bg-red-50/40" : ""}`}>
              <K.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium"><span className="text-muted-foreground">№{r.id}</span> {r.title}</div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>{K.label}</span><span>{r.kind === "payment" ? r.counterpartyName ?? "получатель в описании" : r.staffName ?? "—"}</span><span>от {r.requesterName}, {fmtDayTime(r.createdAt)}</span>{r.reportOverdue && <span className="font-medium text-red-700">отчёт просрочен</span>}</div>
              </div>
              <div className="text-right"><div className="font-semibold tabular-nums">{fmtMoney(amt)}</div>{amt !== r.amountRequested && <div className="text-xs text-muted-foreground line-through">{fmtMoney(r.amountRequested)}</div>}</div>
              <span className={`w-36 shrink-0 rounded border px-2 py-0.5 text-center text-xs ${STATUS[r.status].cls}`}>{statusLabel(r)}</span>
            </button>); })}
        </Card>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>Новый запрос денег</DialogTitle></DialogHeader>
          {options && creating && <NewRequest options={options} canPickStaff={!!s?.seesAll || !options.myStaffId} onDone={(id) => { setCreating(false); refresh(); setOpen(id); }} />}
        </DialogContent>
      </Dialog>
      <Dialog open={open != null} onOpenChange={(o) => !o && setOpen(null)}>{open != null && <RequestDialog id={open} onChanged={refresh} />}</Dialog>
    </div>
  );
}
