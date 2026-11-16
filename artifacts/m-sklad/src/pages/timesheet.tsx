import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, Download, Camera } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { DEPARTMENTS, PERSONNEL_ADMIN, PERSONNEL_VIEW, addDays, errMsg, fmtDayTime, fmtMin, fmtMoney, fmtTime, fromInput, toInput, todayLocal } from "@/lib/personnel";
import type { StaffRow } from "./staff";

interface Row {
  staffId: number; name: string; position: string | null; department: string | null; hourlyRate: number | null; shiftRate: number | null;
  plannedShifts: number; plannedMin: number; workedDays: number; workedMin: number; lateCount: number; lateMin: number; earlyLeaveMin: number;
  overtimeMin: number; absences: number; unplannedShifts: number; forgottenCheckouts: number; pay: number;
}
interface Att { id: number; staffId: number; staffName: string; checkInAt: string; checkOutAt: string | null; method: string; note: string | null; checkInPhoto: string | null; checkOutPhoto: string | null; editedBy: string | null; minutes: number | null }

function monthStart(d: string) { return `${d.slice(0, 8)}01`; }
function monthEnd(d: string) { const x = new Date(`${d.slice(0, 8)}01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); }

function Photo({ src, label }: { src: string | null; label: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return <span className="inline-flex h-10 w-10 items-center justify-center rounded bg-muted text-muted-foreground" title="Без фото"><Camera className="h-4 w-4 opacity-40" /></span>;
  return <>
    <button type="button" onClick={() => setOpen(true)} title={label}><img src={src} alt={label} className="h-10 w-10 rounded object-cover" loading="lazy" /></button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader><img src={src} alt={label} className="w-full rounded" /></DialogContent></Dialog>
  </>;
}

export default function Timesheet() {
  const { user, isLoading } = useCurrentUser();
  const isAdmin = PERSONNEL_ADMIN.includes(user?.role ?? "");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [from, setFrom] = useState(() => monthStart(todayLocal()));
  const [to, setTo] = useState(() => todayLocal());
  const [tab, setTab] = useState<"summary" | "log">("summary");
  const [staffFilter, setStaffFilter] = useState("all");
  const enabled = !!user && !!from && !!to && from <= to;
  const { data: rows } = useQuery<Row[]>({ queryKey: ["/api/personnel/timesheet", from, to], queryFn: () => customFetch(`/api/personnel/timesheet?from=${from}&to=${to}`), enabled });
  const { data: log } = useQuery<Att[]>({ queryKey: ["/api/personnel/attendance", from, to, staffFilter], queryFn: () => customFetch(`/api/personnel/attendance?from=${from}&to=${to}${staffFilter !== "all" ? `&staffId=${staffFilter}` : ""}`), enabled: enabled && tab === "log" });
  const { data: staff } = useQuery<StaffRow[]>({ queryKey: ["/api/personnel/staff"], queryFn: () => customFetch("/api/personnel/staff"), enabled: !!user });
  const [edit, setEdit] = useState<{ id?: number; staffId: string; inAt: string; outAt: string; note: string } | null>(null);

  const total = useMemo(() => (rows ?? []).reduce((a, r) => ({ worked: a.worked + r.workedMin, pay: a.pay + r.pay, late: a.late + r.lateCount, abs: a.abs + r.absences, ot: a.ot + r.overtimeMin }), { worked: 0, pay: 0, late: 0, abs: 0, ot: 0 }), [rows]);

  if (isLoading) return null;
  if (!PERSONNEL_VIEW.includes(user?.role ?? "")) return <AccessDenied />;

  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/personnel/attendance"] }); void qc.invalidateQueries({ queryKey: ["/api/personnel/timesheet"] }); void qc.invalidateQueries({ queryKey: ["/api/personnel/staff"] }); };
  async function save() {
    if (!edit) return;
    const body = { staffId: Number(edit.staffId), checkInAt: fromInput(edit.inAt), checkOutAt: fromInput(edit.outAt), note: edit.note };
    try {
      if (edit.id) await customFetch(`/api/personnel/attendance/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await customFetch("/api/personnel/attendance", { method: "POST", body: JSON.stringify(body) });
      refresh(); setEdit(null); toast({ title: "Отметка сохранена" });
    } catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  async function remove(a: Att) {
    if (!confirm(`Удалить отметку ${a.staffName} от ${fmtDayTime(a.checkInAt)}?`)) return;
    try { await customFetch(`/api/personnel/attendance/${a.id}`, { method: "DELETE" }); refresh(); } catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  function exportCsv() {
    const head = ["Сотрудник", "Должность", "Отдел", "Смен по графику", "Часов по графику", "Дней отработано", "Часов отработано", "Опозданий", "Минут опозданий", "Ранний уход, мин", "Переработка, ч", "Прогулов", "Вне графика", "Ставка/час", "Ставка/смена", "Начислено, сом"];
    const lines = (rows ?? []).map((r) => [r.name, r.position ?? "", r.department ? DEPARTMENTS[r.department] : "", r.plannedShifts, (r.plannedMin / 60).toFixed(1), r.workedDays, (r.workedMin / 60).toFixed(1), r.lateCount, r.lateMin, r.earlyLeaveMin, (r.overtimeMin / 60).toFixed(1), r.absences, r.unplannedShifts, r.hourlyRate ?? "", r.shiftRate ?? "", r.pay]);
    const csv = "﻿" + [head, ...lines].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `tabel_${from}_${to}.csv`; a.click();
  }
  const activeStaff = (staff ?? []).filter((s) => s.isActive);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Табель</h1>
          <p className="text-muted-foreground">Отработанные часы, опоздания, переработки и прогулы — по графику и отметкам в киоске.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label className="text-xs">С</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
          <div className="space-y-1"><Label className="text-xs">По</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
          <Button variant="ghost" onClick={() => { const t = todayLocal(); setFrom(monthStart(t)); setTo(t); }}>Этот месяц</Button>
          <Button variant="ghost" onClick={() => { const p = addDays(monthStart(todayLocal()), -1); setFrom(monthStart(p)); setTo(monthEnd(p)); }}>Прошлый месяц</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Отработано</div><div className="mt-0.5 text-lg font-semibold">{Math.round(total.worked / 60)} ч</div></div>
        <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Начислено по ставкам</div><div className="mt-0.5 text-lg font-semibold">{fmtMoney(total.pay)}</div></div>
        <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Переработки</div><div className="mt-0.5 text-lg font-semibold">{Math.round(total.ot / 60)} ч</div></div>
        <div className={`rounded-xl border p-3 ${total.late ? "border-amber-300 bg-amber-50" : "bg-card"}`}><div className="text-xs text-muted-foreground">Опозданий</div><div className="mt-0.5 text-lg font-semibold">{total.late}</div></div>
        <div className={`rounded-xl border p-3 ${total.abs ? "border-red-200 bg-red-50" : "bg-card"}`}><div className="text-xs text-muted-foreground">Прогулов</div><div className="mt-0.5 text-lg font-semibold">{total.abs}</div></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}><TabsList><TabsTrigger value="summary">Сводка по сотрудникам</TabsTrigger><TabsTrigger value="log">Отметки с фото</TabsTrigger></TabsList></Tabs>
        <div className="flex gap-2">
          {tab === "summary" ? <Button variant="outline" onClick={exportCsv} disabled={!rows?.length}><Download className="mr-2 h-4 w-4" />Excel (CSV)</Button> : <>
            <Select value={staffFilter} onValueChange={setStaffFilter}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Все сотрудники</SelectItem>{(staff ?? []).map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select>
            {isAdmin && <Button onClick={() => setEdit({ staffId: staffFilter !== "all" ? staffFilter : "", inAt: "", outAt: "", note: "" })}><Plus className="mr-2 h-4 w-4" />Отметка вручную</Button>}
          </>}
        </div>
      </div>

      {tab === "summary" ? (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Сотрудник</TableHead><TableHead className="text-right">По графику</TableHead><TableHead className="text-right">Отработано</TableHead>
              <TableHead className="text-right">Опоздания</TableHead><TableHead className="text-right">Ранний уход</TableHead><TableHead className="text-right">Переработка</TableHead>
              <TableHead className="text-right">Прогулы</TableHead><TableHead className="text-right">Начислено</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {!rows?.length ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Нет данных за период</TableCell></TableRow> : rows.map((r) => (
                <TableRow key={r.staffId}>
                  <TableCell><button type="button" className="text-left hover:underline" onClick={() => { setStaffFilter(String(r.staffId)); setTab("log"); }}><div className="font-medium">{r.name}</div></button>
                    <div className="text-xs text-muted-foreground">{[r.position, r.department && DEPARTMENTS[r.department]].filter(Boolean).join(" · ")}</div>
                    {r.forgottenCheckouts > 0 && <Badge variant="outline" className="mt-1 border-amber-300 text-amber-800">забыл отметить уход: {r.forgottenCheckouts}</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.plannedShifts} см.<div className="text-xs text-muted-foreground">{fmtMin(r.plannedMin)}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{r.workedDays} дн.<div className="text-xs text-muted-foreground">{fmtMin(r.workedMin)}</div>{r.unplannedShifts > 0 && <div className="text-xs text-sky-700">вне графика: {r.unplannedShifts}</div>}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.lateCount ? "text-amber-700" : "text-muted-foreground"}`}>{r.lateCount ? <>{r.lateCount} раз<div className="text-xs">{fmtMin(r.lateMin)}</div></> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMin(r.earlyLeaveMin)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMin(r.overtimeMin)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.absences ? "font-semibold text-red-700" : "text-muted-foreground"}`}>{r.absences || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{r.hourlyRate == null && r.shiftRate == null ? <span className="text-xs font-normal text-muted-foreground">ставка не задана</span> : fmtMoney(r.pay)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      ) : (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead>Приход</TableHead><TableHead>Уход</TableHead><TableHead className="text-right">Время</TableHead><TableHead>Комментарий</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
            <TableBody>
              {!log?.length ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Отметок нет</TableCell></TableRow> : log.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.staffName}</TableCell>
                  <TableCell><div className="flex items-center gap-2"><Photo src={a.checkInPhoto} label={`${a.staffName} — приход ${fmtDayTime(a.checkInAt)}`} /><span className="tabular-nums">{fmtDayTime(a.checkInAt)}</span></div></TableCell>
                  <TableCell>{a.checkOutAt ? <div className="flex items-center gap-2"><Photo src={a.checkOutPhoto} label={`${a.staffName} — уход ${fmtDayTime(a.checkOutAt)}`} /><span className="tabular-nums">{fmtTime(a.checkOutAt)}</span></div> : <Badge className="bg-sky-100 text-sky-900 hover:bg-sky-100">на смене</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMin(a.minutes)}</TableCell>
                  <TableCell className="max-w-64 text-sm">{a.method === "manual" && <Badge variant="outline" className="mr-1">вручную</Badge>}{a.note}{a.editedBy && <div className="text-xs text-muted-foreground">изменил(а): {a.editedBy}</div>}</TableCell>
                  {isAdmin && <TableCell className="whitespace-nowrap text-right">
                    <Button variant="ghost" size="icon" aria-label="Исправить" onClick={() => setEdit({ id: a.id, staffId: String(a.staffId), inAt: toInput(a.checkInAt), outAt: toInput(a.checkOutAt), note: "" })}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Удалить" onClick={() => remove(a)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{edit?.id ? "Исправить отметку" : "Отметка вручную"}</DialogTitle></DialogHeader>
          {edit && <div className="space-y-3">
            <div className="space-y-1.5"><Label>Сотрудник</Label>
              <Select value={edit.staffId} onValueChange={(v) => setEdit({ ...edit, staffId: v })} disabled={!!edit.id}><SelectTrigger><SelectValue placeholder="Выберите" /></SelectTrigger>
                <SelectContent>{(edit.id ? staff ?? [] : activeStaff).map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Приход</Label><Input type="datetime-local" value={edit.inAt} onChange={(e) => setEdit({ ...edit, inAt: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Уход</Label><Input type="datetime-local" value={edit.outAt} onChange={(e) => setEdit({ ...edit, outAt: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>Причина *</Label><Input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="Забыл отметиться, сломался планшет…" /></div>
            <p className="text-xs text-muted-foreground">Все ручные отметки и исправления сохраняются в журнале аудита.</p>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEdit(null)}>Отмена</Button><Button onClick={save} disabled={!edit.staffId || !edit.inAt || !edit.note.trim()}>Сохранить</Button></div>
          </div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
