import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Copy, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { DEPARTMENTS, PERSONNEL_ADMIN, PERSONNEL_VIEW, addDays, errMsg, fmtMin, mondayOf, todayLocal } from "@/lib/personnel";

interface Plan { id: number; staffId: number; date: string; startTime: string; endTime: string; note: string | null; status: "upcoming" | "missing" | "in_progress" | "done" | "absent"; lateMin: number; workedMin: number }
interface Data { staff: { id: number; name: string; position: string | null; department: string | null }[]; plans: Plan[] }

const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PRESETS = [["10:00", "22:00"], ["09:00", "18:00"], ["12:00", "00:00"], ["16:00", "02:00"], ["08:00", "16:00"]];
const STATUS_CLS: Record<Plan["status"], string> = {
  upcoming: "bg-primary/10 text-foreground border-primary/20",
  missing: "bg-amber-50 text-amber-900 border-amber-300 border-dashed",
  in_progress: "bg-sky-100 text-sky-900 border-sky-300",
  done: "bg-emerald-50 text-emerald-900 border-emerald-200",
  absent: "bg-red-50 text-red-800 border-red-200 line-through decoration-red-400",
};
function planMinutes(s: string, e: string) {
  const [a, b] = [s, e].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; });
  return b > a ? b - a : b + 1440 - a;
}

export default function Schedule() {
  const { user, isLoading } = useCurrentUser();
  const isAdmin = PERSONNEL_ADMIN.includes(user?.role ?? "");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [monday, setMonday] = useState(() => mondayOf(todayLocal()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const key = ["/api/personnel/schedule", monday];
  const { data } = useQuery<Data>({ queryKey: key, queryFn: () => customFetch(`/api/personnel/schedule?from=${monday}&to=${days[6]}`), enabled: !!user, refetchInterval: 60_000 });
  const [cell, setCell] = useState<{ staffId: number; date: string; plan?: Plan } | null>(null);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("22:00");
  const [note, setNote] = useState("");

  const byCell = useMemo(() => new Map((data?.plans ?? []).map((p) => [`${p.staffId}:${p.date}`, p])), [data]);
  const groups = useMemo(() => {
    const g = new Map<string, Data["staff"]>();
    for (const s of data?.staff ?? []) { const k = s.department ?? "other"; g.set(k, [...(g.get(k) ?? []), s]); }
    return [...g.entries()].sort(([a], [b]) => Object.keys(DEPARTMENTS).indexOf(a) - Object.keys(DEPARTMENTS).indexOf(b));
  }, [data]);
  const today = todayLocal();

  if (isLoading) return null;
  if (!PERSONNEL_VIEW.includes(user?.role ?? "")) return <AccessDenied />;

  function openCell(staffId: number, date: string) {
    if (!isAdmin) return;
    const plan = byCell.get(`${staffId}:${date}`);
    const prev = plan ?? [...(data?.plans ?? [])].filter((p) => p.staffId === staffId).sort((a, b) => b.date.localeCompare(a.date))[0];
    setStart(prev?.startTime ?? "10:00"); setEnd(prev?.endTime ?? "22:00"); setNote(plan?.note ?? "");
    setCell({ staffId, date, plan });
  }
  async function save(remove = false) {
    if (!cell) return;
    try {
      await customFetch("/api/personnel/schedule", { method: "PUT", body: JSON.stringify({ staffId: cell.staffId, date: cell.date, startTime: remove ? null : start, endTime: remove ? null : end, note }) });
      await qc.invalidateQueries({ queryKey: key }); setCell(null);
    } catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  async function copyPrev() {
    if (!confirm("Скопировать смены прошлой недели на эту? Уже заполненные дни не изменятся.")) return;
    try {
      const r = await customFetch<{ copied: number; skipped: number }>("/api/personnel/schedule/copy-week", { method: "POST", body: JSON.stringify({ fromMonday: addDays(monday, -7), toMonday: monday }) });
      await qc.invalidateQueries({ queryKey: key });
      toast({ title: `Скопировано смен: ${r.copied}`, description: r.skipped ? `Пропущено (день уже заполнен): ${r.skipped}` : undefined });
    } catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  const staffName = cell ? data?.staff.find((s) => s.id === cell.staffId)?.name : "";
  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">График смен</h1>
          <p className="text-muted-foreground">Кто, когда и во сколько работает. Цвет показывает, как смена прошла на самом деле.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setMonday(addDays(monday, -7))} aria-label="Прошлая неделя"><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-40 text-center text-sm font-medium">{label(days[0])} — {label(days[6])}</div>
          <Button variant="outline" size="icon" onClick={() => setMonday(addDays(monday, 7))} aria-label="Следующая неделя"><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="ghost" onClick={() => setMonday(mondayOf(todayLocal()))}>Эта неделя</Button>
          {isAdmin && <Button variant="outline" onClick={copyPrev}><Copy className="mr-2 h-4 w-4" />Как прошлая неделя</Button>}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {([["upcoming", "запланирована"], ["missing", "началась, ещё не пришёл"], ["in_progress", "на смене"], ["done", "отработана"], ["absent", "не вышел"]] as const).map(([k, l]) => <span key={k} className="flex items-center gap-1.5"><span className={`h-3 w-5 rounded border ${STATUS_CLS[k]}`} />{l}</span>)}
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />опоздание</span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="sticky left-0 z-10 w-52 bg-muted/40 px-3 py-2 text-left font-medium">Сотрудник</th>
              {days.map((d, i) => <th key={d} className={`px-1 py-2 text-center font-medium ${d === today ? "text-primary" : ""}`}>{DOW[i]}<div className="text-xs font-normal text-muted-foreground">{label(d)}</div></th>)}
              <th className="px-2 py-2 text-right font-medium">Часов</th>
            </tr>
          </thead>
          <tbody>
            {!data?.staff.length && <tr><td colSpan={9} className="py-10 text-center text-muted-foreground">Добавьте сотрудников в разделе «Сотрудники»</td></tr>}
            {groups.map(([dept, list]) => [
              <tr key={`g-${dept}`}><td colSpan={9} className="bg-muted/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{DEPARTMENTS[dept] ?? dept}</td></tr>,
              ...list.map((s) => {
                const total = days.reduce((acc, d) => { const p = byCell.get(`${s.id}:${d}`); return acc + (p ? planMinutes(p.startTime, p.endTime) : 0); }, 0);
                return (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1.5"><div className="font-medium">{s.name}</div>{s.position && <div className="text-xs text-muted-foreground">{s.position}</div>}</td>
                    {days.map((d) => {
                      const p = byCell.get(`${s.id}:${d}`);
                      return (
                        <td key={d} className={`p-1 ${d === today ? "bg-primary/5" : ""}`}>
                          <button type="button" disabled={!isAdmin} onClick={() => openCell(s.id, d)} title={p?.note ?? undefined}
                            className={`relative h-11 w-full rounded-md border text-xs transition-colors ${p ? STATUS_CLS[p.status] : "border-dashed border-transparent text-muted-foreground hover:border-border"} ${isAdmin ? "cursor-pointer" : "cursor-default"}`}>
                            {p ? <><div className="font-medium">{p.startTime}–{p.endTime}</div>{p.status === "done" && <div className="text-[10px] opacity-70">{fmtMin(p.workedMin)}</div>}</> : isAdmin ? "+" : ""}
                            {p && p.lateMin > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" title={`Опоздание ${p.lateMin} мин`} />}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 text-right tabular-nums text-muted-foreground">{total ? Math.round(total / 6) / 10 : "—"}</td>
                  </tr>
                );
              }),
            ])}
            {!!data?.staff.length && (
              <tr className="border-t bg-muted/30 text-xs text-muted-foreground">
                <td className="sticky left-0 bg-muted/30 px-3 py-2">На смене</td>
                {days.map((d) => <td key={d} className="text-center">{data.plans.filter((p) => p.date === d).length || "—"}</td>)}
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Dialog open={!!cell} onOpenChange={(o) => !o && setCell(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{staffName} · {cell && `${DOW[(new Date(`${cell.date}T00:00:00Z`).getUTCDay() + 6) % 7]}, ${label(cell.date)}`}</DialogTitle></DialogHeader>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(([a, b]) => <Button key={a + b} type="button" size="sm" variant={start === a && end === b ? "default" : "outline"} onClick={() => { setStart(a); setEnd(b); }}>{a}–{b}</Button>)}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Начало</Label><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Конец</Label><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <p className="text-xs text-muted-foreground">{start && end && start !== end ? `Смена ${fmtMin(planMinutes(start, end))}${end <= start ? ", заканчивается на следующий день" : ""}` : ""}</p>
          <div className="space-y-1.5"><Label>Заметка</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: банкет, подмена" /></div>
          <div className="flex justify-between gap-2 pt-1">
            {cell?.plan ? <Button variant="ghost" className="text-destructive" onClick={() => save(true)}><Trash2 className="mr-1.5 h-4 w-4" />Выходной</Button> : <span />}
            <div className="flex gap-2"><Button variant="outline" onClick={() => setCell(null)}>Отмена</Button><Button onClick={() => save()} disabled={!start || !end || start === end}>Сохранить</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
