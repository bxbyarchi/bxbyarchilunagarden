import { useEffect, useMemo, useState } from "react";
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
import { Plus, Search, Repeat, MapPin, MessageSquare, ListChecks, Clock, AlertTriangle, X, Play, Send, Check, Undo2, Ban, RotateCcw, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { DEPARTMENTS, addDays, errMsg, fmtDayTime, fromInput, toInput, todayLocal } from "@/lib/personnel";

type Status = "new" | "in_progress" | "review" | "done" | "cancelled";
interface Check { text: string; done: boolean }
interface Row {
  id: number; title: string; status: Status; priority: string; dueAt: string | null; department: string | null; zone: string | null; repeat: string | null; needsReview: boolean;
  assigneeStaffId: number | null; assigneeName: string | null; creatorClerkId: string; creatorName: string; checklist: Check[]; comments: number; overdue: boolean; completedAt: string | null;
}
interface Detail extends Row {
  description: string | null; assigneePosition: string | null; returnedCount: number; createdAt: string; submittedAt: string | null;
  events: { id: number; kind: string; text: string; createdAt: string; authorName: string }[];
  can: { edit: boolean; checklist: boolean; transitions: Status[] }; me: { isAdmin: boolean; isCreator: boolean; isAssignee: boolean };
}
interface Assignee { id: number; name: string; position: string | null; department: string | null; hasAccount: boolean }
interface Summary { hasStaffCard: boolean; myOpen: number; myOverdue: number; toReview: number; isAdmin: boolean }
interface Eff { staffId: number; name: string; position: string | null; department: string | null; total: number; done: number; open: number; onTime: number; late: number; overdueOpen: number; returned: number; avgDelayHours: number | null; score: number | null }

export const STATUS: Record<Status, { label: string; cls: string }> = {
  new: { label: "Новая", cls: "bg-slate-100 text-slate-800 border-slate-200" },
  in_progress: { label: "В работе", cls: "bg-sky-100 text-sky-900 border-sky-200" },
  review: { label: "На проверке", cls: "bg-violet-100 text-violet-900 border-violet-200" },
  done: { label: "Выполнена", cls: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  cancelled: { label: "Отменена", cls: "bg-muted text-muted-foreground" },
};
const PRIORITY: Record<string, { label: string; dot: string }> = {
  low: { label: "Низкий", dot: "bg-slate-300" }, normal: { label: "Обычный", dot: "bg-sky-400" }, high: { label: "Высокий", dot: "bg-amber-500" }, urgent: { label: "Срочно", dot: "bg-red-600" },
};
const REPEAT: Record<string, string> = { daily: "каждый день", weekly: "каждую неделю", monthly: "каждый месяц" };
const ZONES = ["Зал", "Терраса", "VIP-зал", "Бар", "Горячий цех", "Холодный цех", "Кондитерский цех", "Склад", "Мойка", "Вход и гардероб", "Туалеты", "Двор / парковка", "Офис"];

function dueLabel(r: { dueAt: string | null; overdue: boolean; status: Status }) {
  if (!r.dueAt) return <span className="text-muted-foreground">без срока</span>;
  const d = new Date(r.dueAt);
  const today = todayLocal(), day = new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const time = d.toLocaleTimeString("ru-RU", { timeZone: "Asia/Bishkek", hour: "2-digit", minute: "2-digit" });
  const text = day === today ? `сегодня ${time}` : day === addDays(today, 1) ? `завтра ${time}` : fmtDayTime(r.dueAt);
  const open = ["new", "in_progress", "review"].includes(r.status);
  return <span className={r.overdue ? "font-medium text-red-700" : open && day === today ? "font-medium text-amber-700" : ""}>{r.overdue && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}{text}</span>;
}

type Form = { title: string; description: string; assigneeStaffId: string; department: string; zone: string; due: string; priority: string; repeat: string; needsReview: boolean; checklist: Check[] };
const emptyForm = (): Form => ({ title: "", description: "", assigneeStaffId: "", department: "", zone: "", due: "", priority: "normal", repeat: "", needsReview: true, checklist: [] });

function TaskForm({ f, setF, assignees }: { f: Form; setF: (f: Form) => void; assignees: Assignee[] }) {
  const [item, setItem] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const quick = (days: number, time: string) => set("due", `${addDays(todayLocal(), days)}T${time}`);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2"><Label>Что сделать *</Label><Input autoFocus value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Например: почистить вытяжку на горячем цехе" /></div>
      <div className="space-y-1.5 sm:col-span-2"><Label>Подробности</Label><Textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
      <div className="space-y-1.5"><Label>Исполнитель</Label>
        <Select value={f.assigneeStaffId || "none"} onValueChange={(v) => { const a = assignees.find((x) => String(x.id) === v); setF({ ...f, assigneeStaffId: v === "none" ? "" : v, department: f.department || a?.department || "" }); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Не назначен</SelectItem>{assignees.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}{a.position ? ` · ${a.position}` : ""}{a.hasAccount ? "" : " (без аккаунта)"}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5"><Label>Срок</Label><Input type="datetime-local" value={f.due} onChange={(e) => set("due", e.target.value)} />
        <div className="flex flex-wrap gap-1">{[["Сегодня 18:00", 0, "18:00"], ["Завтра 12:00", 1, "12:00"], ["Через неделю", 7, "18:00"]].map(([l, d, t]) => <button key={l as string} type="button" className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted" onClick={() => quick(d as number, t as string)}>{l}</button>)}{f.due && <button type="button" className="px-1 text-[11px] text-muted-foreground" onClick={() => set("due", "")}>убрать</button>}</div>
      </div>
      <div className="space-y-1.5"><Label>Приоритет</Label>
        <Select value={f.priority} onValueChange={(v) => set("priority", v)}><SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(PRIORITY).map(([k, v]) => <SelectItem key={k} value={k}><span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${v.dot}`} />{v.label}</span></SelectItem>)}</SelectContent></Select>
      </div>
      <div className="space-y-1.5"><Label>Отдел</Label>
        <Select value={f.department || "none"} onValueChange={(v) => set("department", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Не указан</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
      </div>
      <div className="space-y-1.5"><Label>Где (зона)</Label><Input list="task-zones" value={f.zone} onChange={(e) => set("zone", e.target.value)} placeholder="Бар, горячий цех, терраса…" /><datalist id="task-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist></div>
      <div className="space-y-1.5"><Label>Повторять</Label>
        <Select value={f.repeat || "none"} onValueChange={(v) => set("repeat", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Не повторять</SelectItem>{Object.entries(REPEAT).map(([k, v]) => <SelectItem key={k} value={k}>{v[0].toUpperCase() + v.slice(1)}</SelectItem>)}</SelectContent></Select>
        {f.repeat && !f.due && <p className="text-xs text-amber-700">Укажите срок — от него считаются повторы</p>}
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label>Чек-лист</Label>
        {f.checklist.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-sm"><ListChecks className="h-4 w-4 text-muted-foreground" /><span className="flex-1">{c.text}</span>
            <button type="button" aria-label="Убрать пункт" onClick={() => set("checklist", f.checklist.filter((_, k) => k !== i))}><X className="h-4 w-4 text-muted-foreground" /></button></div>
        ))}
        <div className="flex gap-2"><Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Пункт и Enter" onKeyDown={(e) => { if (e.key === "Enter" && item.trim()) { e.preventDefault(); set("checklist", [...f.checklist, { text: item.trim(), done: false }]); setItem(""); } }} />
          <Button type="button" variant="outline" disabled={!item.trim()} onClick={() => { set("checklist", [...f.checklist, { text: item.trim(), done: false }]); setItem(""); }}>Добавить</Button></div>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.needsReview} onChange={(e) => set("needsReview", e.target.checked)} />Проверить результат перед закрытием (иначе исполнитель закрывает сам)</label>
    </div>
  );
}
const formBody = (f: Form) => ({ title: f.title, description: f.description || null, assigneeStaffId: f.assigneeStaffId ? Number(f.assigneeStaffId) : null, department: f.department || null, zone: f.zone || null, dueAt: fromInput(f.due), priority: f.priority, repeat: f.repeat || null, needsReview: f.needsReview, checklist: f.checklist });

function TaskDialog({ id, assignees, onClose, onChanged }: { id: number; assignees: Assignee[]; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ["/api/tasks", id];
  const { data: t } = useQuery<Detail>({ queryKey: key, queryFn: () => customFetch(`/api/tasks/${id}`) });
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const put = (d: Detail) => { qc.setQueryData(key, d); onChanged(); };
  async function call(path: string, body: unknown, method = "POST") {
    setBusy(true);
    try { put(await customFetch<Detail>(`/api/tasks/${id}${path}`, { method, body: JSON.stringify(body) })); return true; }
    catch (e) { toast({ title: "Не получилось", description: errMsg(e), variant: "destructive" }); return false; } finally { setBusy(false); }
  }
  async function move(to: Status, needComment = false) {
    if (needComment && !comment.trim()) { toast({ title: to === "cancelled" ? "Напишите причину отмены в поле комментария" : "Напишите в комментарии, что исправить", variant: "destructive" }); return; }
    if (await call("/status", { to, comment })) setComment("");
  }
  if (!t) return <DialogContent className="max-w-2xl"><div className="p-8 text-center text-muted-foreground">Загрузка…</div></DialogContent>;
  const tr = new Set(t.can.transitions);
  const boss = t.me.isAdmin || t.me.isCreator;
  const doneN = t.checklist.filter((c) => c.done).length;

  const actions: { to: Status; label: string; icon: typeof Play; variant?: "default" | "outline" | "ghost"; comment?: boolean }[] = [];
  if (t.status === "new" && tr.has("in_progress") && t.me.isAssignee) actions.push({ to: "in_progress", label: "Взять в работу", icon: Play, variant: "outline" });
  if (["new", "in_progress"].includes(t.status) && t.needsReview && tr.has("review") && t.me.isAssignee) actions.push({ to: "review", label: "Готово, на проверку", icon: Send });
  if (["new", "in_progress"].includes(t.status) && (!t.needsReview || boss) && tr.has("done")) actions.push({ to: "done", label: t.needsReview ? "Закрыть без проверки" : "Выполнено", icon: Check, variant: t.needsReview ? "outline" : "default" });
  if (t.status === "review" && boss && tr.has("done")) actions.push({ to: "done", label: "Принять", icon: Check });
  if (t.status === "review" && tr.has("in_progress")) actions.push({ to: "in_progress", label: boss && !t.me.isAssignee ? "Вернуть на доработку" : "Забрать обратно", icon: Undo2, variant: "outline", comment: boss && !t.me.isAssignee });
  if (["done", "cancelled"].includes(t.status) && boss) actions.push({ to: "in_progress", label: "Открыть снова", icon: RotateCcw, variant: "outline" });
  if (["new", "in_progress", "review"].includes(t.status) && boss) actions.push({ to: "cancelled", label: "Отменить", icon: Ban, variant: "ghost", comment: true });

  return (
    <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
      {editing ? <>
        <DialogHeader><DialogTitle>Изменить задачу</DialogTitle></DialogHeader>
        <TaskForm f={editing} setF={setEditing} assignees={assignees} />
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEditing(null)}>Отмена</Button>
          <Button disabled={busy || !editing.title.trim()} onClick={async () => { if (await call("", formBody(editing), "PATCH")) setEditing(null); }}>Сохранить</Button></div>
      </> : <>
        <DialogHeader><DialogTitle className="pr-6 leading-snug">{t.title}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
          <span className="flex items-center gap-1.5 text-xs"><span className={`h-2 w-2 rounded-full ${PRIORITY[t.priority]?.dot}`} />{PRIORITY[t.priority]?.label}</span>
          {t.repeat && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Repeat className="h-3.5 w-3.5" />{REPEAT[t.repeat]}</span>}
          {t.returnedCount > 0 && <Badge variant="outline" className="border-amber-300 text-amber-800">возвращалась: {t.returnedCount}</Badge>}
          {t.can.edit && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing({ title: t.title, description: t.description ?? "", assigneeStaffId: t.assigneeStaffId ? String(t.assigneeStaffId) : "", department: t.department ?? "", zone: t.zone ?? "", due: toInput(t.dueAt), priority: t.priority, repeat: t.repeat ?? "", needsReview: t.needsReview, checklist: t.checklist })}><Pencil className="mr-1.5 h-4 w-4" />Изменить</Button>}
        </div>
        <div className="grid gap-x-6 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
          <div><span className="text-muted-foreground">Исполнитель: </span>{t.assigneeName ?? "не назначен"}</div>
          <div><span className="text-muted-foreground">Поставил(а): </span>{t.creatorName}</div>
          <div><span className="text-muted-foreground">Срок: </span>{dueLabel(t)}</div>
          <div><span className="text-muted-foreground">Где: </span>{[t.department && DEPARTMENTS[t.department], t.zone].filter(Boolean).join(" · ") || "—"}</div>
        </div>
        {t.description && <p className="whitespace-pre-wrap text-sm">{t.description}</p>}
        {t.checklist.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Чек-лист {doneN}/{t.checklist.length}</div>
            <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-emerald-500" style={{ width: `${(doneN / t.checklist.length) * 100}%` }} /></div>
            {t.checklist.map((c, i) => (
              <label key={i} className={`flex items-center gap-2 rounded px-1 py-1 text-sm ${t.can.checklist ? "cursor-pointer hover:bg-muted/50" : ""}`}>
                <input type="checkbox" checked={c.done} disabled={!t.can.checklist || busy || ["done", "cancelled"].includes(t.status)} onChange={(e) => call("", { checklist: t.checklist.map((x, k) => (k === i ? { ...x, done: e.target.checked } : x)) }, "PATCH")} />
                <span className={c.done ? "text-muted-foreground line-through" : ""}>{c.text}</span>
              </label>
            ))}
          </div>
        )}
        {actions.length > 0 && <div className="flex flex-wrap gap-2 border-t pt-3">{actions.map((a) => <Button key={a.label} variant={a.variant ?? "default"} disabled={busy} onClick={() => move(a.to, a.comment)}><a.icon className="mr-1.5 h-4 w-4" />{a.label}</Button>)}</div>}
        <div className="space-y-2 border-t pt-3">
          <div className="text-sm font-medium">История и комментарии</div>
          <div className="space-y-2">
            {t.events.map((e) => (
              <div key={e.id} className={`text-sm ${e.kind === "comment" ? "rounded-lg bg-muted/50 px-3 py-2" : "text-xs text-muted-foreground"}`}>
                <span className="font-medium text-foreground/80">{e.authorName}</span> · {fmtDayTime(e.createdAt)}{e.kind === "comment" ? <div className="mt-0.5 whitespace-pre-wrap">{e.text}</div> : <> — {e.text}</>}
              </div>
            ))}
          </div>
          <div className="flex gap-2"><Textarea rows={2} className="min-h-0 resize-none" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий (для «вернуть» и «отменить» — обязательно)" />
            <Button className="self-end" variant="outline" disabled={busy || !comment.trim()} onClick={async () => { if (await call("/comments", { text: comment })) setComment(""); }} aria-label="Отправить комментарий"><Send className="h-4 w-4" /></Button></div>
        </div>
      </>}
    </DialogContent>
  );
}

function EfficiencyTab() {
  const [from, setFrom] = useState(() => `${todayLocal().slice(0, 8)}01`);
  const [to, setTo] = useState(() => todayLocal());
  const { data } = useQuery<Eff[]>({ queryKey: ["/api/tasks/efficiency", from, to], queryFn: () => customFetch(`/api/tasks/efficiency?from=${from}&to=${to}`), enabled: !!from && !!to && from <= to });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label className="text-xs">Срок задач с</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">по</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <p className="max-w-md pb-1 text-xs text-muted-foreground">«Вовремя» — доля задач со сроком, сданных до дедлайна. Просроченные и не сданные считаются как невыполненные в срок. Ожидание проверки исполнителю не засчитывается.</p>
      </div>
      <Card><CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead className="text-right">Задач</TableHead><TableHead className="text-right">Выполнено</TableHead><TableHead className="text-right">Вовремя</TableHead><TableHead className="text-right">С опозданием</TableHead><TableHead className="text-right">Просрочено сейчас</TableHead><TableHead className="text-right">Возвраты</TableHead><TableHead className="w-48">Вовремя, %</TableHead></TableRow></TableHeader>
          <TableBody>
            {!data?.length ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Нет задач со сроком в этом периоде</TableCell></TableRow> : data.map((e) => (
              <TableRow key={e.staffId}>
                <TableCell><div className="font-medium">{e.name}</div><div className="text-xs text-muted-foreground">{[e.position, e.department && DEPARTMENTS[e.department]].filter(Boolean).join(" · ")}</div></TableCell>
                <TableCell className="text-right tabular-nums">{e.total}</TableCell>
                <TableCell className="text-right tabular-nums">{e.done}</TableCell>
                <TableCell className="text-right tabular-nums text-emerald-700">{e.onTime || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-amber-700">{e.late ? <>{e.late}<div className="text-xs">в среднем +{e.avgDelayHours} ч</div></> : "—"}</TableCell>
                <TableCell className={`text-right tabular-nums ${e.overdueOpen ? "font-semibold text-red-700" : "text-muted-foreground"}`}>{e.overdueOpen || "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{e.returned || "—"}</TableCell>
                <TableCell>{e.score == null ? <span className="text-xs text-muted-foreground">ещё нечего оценивать</span> : (
                  <div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded bg-muted"><div className={`h-full ${e.score >= 85 ? "bg-emerald-500" : e.score >= 60 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${e.score}%` }} /></div><span className="w-10 text-right text-sm font-semibold tabular-nums">{e.score}%</span></div>
                )}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}

export default function Tasks() {
  const { user, isLoading } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: summary } = useQuery<Summary>({ queryKey: ["/api/tasks/summary"], queryFn: () => customFetch("/api/tasks/summary"), enabled: !!user });
  const [view, setView] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [assignee, setAssignee] = useState("all");
  const [dept, setDept] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState<Form | null>(null);
  useEffect(() => { if (summary && !view) setView(summary.hasStaffCard ? "mine" : summary.isAdmin ? "all" : "created"); }, [summary, view]);
  const { data: assignees } = useQuery<Assignee[]>({ queryKey: ["/api/tasks/assignees"], queryFn: () => customFetch("/api/tasks/assignees"), enabled: !!user });
  const params = new URLSearchParams({ view: view ?? "mine", status, ...(assignee !== "all" && view === "all" ? { assigneeStaffId: assignee } : {}), ...(dept !== "all" ? { department: dept } : {}), ...(q ? { q } : {}) });
  const { data: rows } = useQuery<Row[]>({ queryKey: ["/api/tasks", params.toString()], queryFn: () => customFetch(`/api/tasks?${params}`), enabled: !!user && !!view && view !== "efficiency", refetchInterval: 30_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/tasks"] }); void qc.invalidateQueries({ queryKey: ["/api/tasks/summary"] }); };
  const grouped = useMemo(() => {
    if (status !== "open") return [["", rows ?? []] as const];
    const g: Record<string, Row[]> = { overdue: [], review: [], active: [] };
    for (const r of rows ?? []) (r.overdue ? g.overdue : r.status === "review" ? g.review : g.active).push(r);
    return ([["Просрочено", g.overdue], ["На проверке", g.review], ["В работе и новые", g.active]] as const).filter(([, l]) => l.length);
  }, [rows, status]);

  if (isLoading || !user) return null;
  async function create() {
    if (!creating) return;
    try { const r = await customFetch<{ id: number }>("/api/tasks", { method: "POST", body: JSON.stringify(formBody(creating)) }); setCreating(null); refresh(); setOpen(r.id); toast({ title: "Задача поставлена" }); }
    catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  const tabs: [string, string, number?][] = [
    ...(summary?.hasStaffCard ? [["mine", "Мои задачи", summary.myOpen] as [string, string, number]] : []),
    ["created", "Поставленные мной"], ["review", "На проверку", summary?.toReview],
    ...(summary?.isAdmin ? [["all", "Все задачи"], ["efficiency", "Эффективность"]] as [string, string][] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Задачи</h1>
          <p className="text-muted-foreground">Поручения между управляющими и сотрудниками: сроки, чек-листы, проверка результата и процент выполнения вовремя.</p>
        </div>
        <Button onClick={() => setCreating(emptyForm())}><Plus className="mr-2 h-4 w-4" />Поставить задачу</Button>
      </div>

      {summary && !summary.hasStaffCard && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Ваш аккаунт не привязан к карточке сотрудника — вам нельзя назначать задачи. Привяжите его в разделе «Сотрудники».</div>}
      {summary && summary.myOverdue > 0 && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="h-4 w-4" />У вас просрочено задач: <b>{summary.myOverdue}</b></div>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={view ?? ""} onValueChange={setView}><TabsList className="h-auto flex-wrap">{tabs.map(([v, l, n]) => <TabsTrigger key={v} value={v}>{l}{n ? <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{n}</span> : null}</TabsTrigger>)}</TabsList></Tabs>
      </div>

      {view === "efficiency" ? <EfficiencyTab /> : <>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5">{[["open", "Открытые"], ["overdue", "Просроченные"], ["done", "Выполненные"], ["cancelled", "Отменённые"]].map(([v, l]) => <button key={v} type="button" onClick={() => setStatus(v)} className={`rounded-md px-2.5 py-1 text-sm ${status === v ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{l}</button>)}</div>
          <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="w-56 pl-8" placeholder="Поиск по названию" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {view === "all" && <Select value={assignee} onValueChange={setAssignee}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Все исполнители</SelectItem><SelectItem value="none">Без исполнителя</SelectItem>{assignees?.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent></Select>}
          <Select value={dept} onValueChange={setDept}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Все отделы</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
        </div>

        {!rows?.length ? <Card><CardContent className="py-12 text-center text-muted-foreground">{status === "open" ? "Открытых задач нет 🎉" : "Ничего не найдено"}</CardContent></Card> : grouped.map(([title, list]) => (
          <div key={title} className="space-y-1.5">
            {title && <div className={`text-xs font-semibold uppercase tracking-wide ${title === "Просрочено" ? "text-red-700" : "text-muted-foreground"}`}>{title} · {list.length}</div>}
            <Card className="divide-y overflow-hidden">
              {list.map((r) => {
                const d = r.checklist.filter((c) => c.done).length;
                return (
                  <button key={r.id} type="button" onClick={() => setOpen(r.id)} className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-muted/40 ${r.overdue ? "bg-red-50/40" : ""}`}>
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY[r.priority]?.dot}`} title={PRIORITY[r.priority]?.label} />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate font-medium ${r.status === "done" || r.status === "cancelled" ? "text-muted-foreground" : ""}`}>{r.title}</div>
                      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span>{view === "mine" ? `от ${r.creatorName}` : r.assigneeName ?? "без исполнителя"}</span>
                        {(r.zone || r.department) && <span className="flex items-center gap-0.5"><MapPin className="h-3 w-3" />{r.zone ?? DEPARTMENTS[r.department!]}</span>}
                        {r.repeat && <span className="flex items-center gap-0.5"><Repeat className="h-3 w-3" />{REPEAT[r.repeat]}</span>}
                        {r.checklist.length > 0 && <span className="flex items-center gap-0.5"><ListChecks className="h-3 w-3" />{d}/{r.checklist.length}</span>}
                        {r.comments > 0 && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{r.comments}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm"><Clock className="h-3.5 w-3.5 text-muted-foreground" />{r.status === "done" && r.completedAt ? <span className="text-muted-foreground">{fmtDayTime(r.completedAt)}</span> : dueLabel(r)}</div>
                    <span className={`w-24 shrink-0 rounded border px-2 py-0.5 text-center text-xs ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  </button>
                );
              })}
            </Card>
          </div>
        ))}
      </>}

      <Dialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Новая задача</DialogTitle></DialogHeader>
          {creating && <TaskForm f={creating} setF={setCreating} assignees={assignees ?? []} />}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setCreating(null)}>Отмена</Button><Button onClick={create} disabled={!creating?.title.trim() || (!!creating?.repeat && !creating?.due)}>Поставить</Button></div>
        </DialogContent>
      </Dialog>
      <Dialog open={open != null} onOpenChange={(o) => !o && setOpen(null)}>
        {open != null && <TaskDialog id={open} assignees={assignees ?? []} onClose={() => setOpen(null)} onChanged={refresh} />}
      </Dialog>
    </div>
  );
}
