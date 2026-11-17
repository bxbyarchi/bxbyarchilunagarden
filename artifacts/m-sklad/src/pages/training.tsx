import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GraduationCap, CheckCircle2, Circle, Plus, Pencil, UserPlus, Trash2, X, Trophy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { DEPARTMENTS, errMsg, fmtDayTime } from "@/lib/personnel";

const EDITORS = ["super_admin", "warehouse_chief", "location_admin", "manager"];
interface MyItem { assignmentId: number; courseId: number; title: string; description: string | null; passPercent: number; status: string; bestScore: number | null; attempts: number; dueDate: string | null; passedAt: string | null; lessons: { id: number; title: string; read: boolean }[]; quiz: { q: string; options: string[] }[]; canTakeQuiz: boolean }
interface Q { q: string; options: string[]; correct: number }
interface Course { id: number; title: string; description: string | null; department: string | null; articleIds: number[]; quiz: Q[]; passPercent: number; isActive: boolean; assigned: number; passed: number }
interface Prog { id: number; staffId: number; staffName: string; department: string | null; courseId: number; course: string; status: string; bestScore: number | null; attempts: number; dueDate: string | null; passedAt: string | null; hasAccount: boolean; lessonsRead: number; lessonsTotal: number }
const ST: Record<string, { label: string; cls: string }> = { assigned: { label: "Назначен", cls: "bg-sky-100 text-sky-900" }, failed: { label: "Тест не сдан", cls: "bg-amber-100 text-amber-900" }, passed: { label: "Пройден", cls: "bg-emerald-100 text-emerald-900" } };

function QuizDialog({ item, onDone }: { item: MyItem; onDone: () => void }) {
  const { toast } = useToast();
  const [ans, setAns] = useState<(number | null)[]>(() => item.quiz.map(() => null));
  const [result, setResult] = useState<{ score: number; passed: boolean; wrong: number[]; passPercent: number } | null>(null);
  async function submit() {
    try { setResult(await customFetch(`/api/training/assignments/${item.assignmentId}/attempt`, { method: "POST", body: JSON.stringify({ answers: ans }) })); onDone(); }
    catch (e) { toast({ title: "Не отправлено", description: errMsg(e), variant: "destructive" }); }
  }
  return (
    <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle>Тест: {item.title}</DialogTitle></DialogHeader>
      {result && <div className={`rounded-lg p-4 text-center ${result.passed ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
        {result.passed ? <Trophy className="mx-auto h-8 w-8" /> : null}
        <div className="text-2xl font-bold">{result.score}%</div>
        <div>{result.passed ? "Тест сдан — молодец!" : `Нужно ${result.passPercent}%. Перечитайте уроки и попробуйте ещё раз.`}</div>
        {result.wrong.length > 0 && <div className="mt-1 text-sm">Ошибки в вопросах: {result.wrong.map((i) => i + 1).join(", ")}</div>}
      </div>}
      <div className="space-y-4">
        {item.quiz.map((q, i) => (
          <div key={i} className={`rounded-lg border p-3 ${result?.wrong.includes(i) ? "border-amber-300 bg-amber-50/50" : ""}`}>
            <div className="font-medium">{i + 1}. {q.q}</div>
            <div className="mt-2 space-y-1">{q.options.map((o, j) => (
              <label key={j} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50"><input type="radio" name={`q${i}`} checked={ans[i] === j} onChange={() => { setAns(ans.map((x, k) => (k === i ? j : x))); setResult(null); }} />{o}</label>
            ))}</div>
          </div>
        ))}
      </div>
      <Button size="lg" onClick={submit} disabled={ans.some((x) => x == null)}>{result ? "Отправить ещё раз" : "Проверить"}</Button>
    </DialogContent>
  );
}

function CourseEditor({ course, onClose }: { course: Partial<Course> | null; onClose: (saved: boolean) => void }) {
  const { toast } = useToast();
  const { data: arts } = useQuery<{ id: number; title: string; category: string }[]>({ queryKey: ["/api/kb/articles", "all-for-course"], queryFn: () => customFetch("/api/kb/articles") });
  const [f, setF] = useState<Partial<Course>>(() => ({ title: "", description: "", department: null, articleIds: [], quiz: [], passPercent: 80, isActive: true, ...course }));
  const quiz = f.quiz ?? [];
  const setQ = (i: number, q: Q) => setF({ ...f, quiz: quiz.map((x, k) => (k === i ? q : x)) });
  async function save() {
    try {
      const body = { title: f.title, description: f.description, department: f.department, articleIds: f.articleIds, quiz, passPercent: f.passPercent, isActive: f.isActive };
      if (f.id) await customFetch(`/api/training/courses/${f.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await customFetch("/api/training/courses", { method: "POST", body: JSON.stringify(body) });
      onClose(true);
    } catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  return (
    <DialogContent className="max-h-[94dvh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{f.id ? "Курс" : "Новый курс"}</DialogTitle></DialogHeader>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2"><Label>Название</Label><Input value={f.title ?? ""} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Например: Бармен — стандарты бара" /></div>
        <div className="space-y-1.5"><Label>Отдел</Label><Select value={f.department ?? "none"} onValueChange={(v) => setF({ ...f, department: v === "none" ? null : v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Для всех</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5 sm:col-span-3"><Label>Описание</Label><Textarea rows={2} value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      </div>
      <div className="space-y-1.5">
        <Label>Уроки — статьи из базы знаний, по порядку</Label>
        {(f.articleIds ?? []).map((id, i) => <div key={id} className="flex items-center gap-2 text-sm"><span className="w-5 text-muted-foreground">{i + 1}.</span><span className="flex-1">{arts?.find((a) => a.id === id)?.title ?? `Статья №${id}`}</span><button type="button" aria-label="Убрать урок" onClick={() => setF({ ...f, articleIds: f.articleIds!.filter((x) => x !== id) })}><X className="h-4 w-4 text-muted-foreground" /></button></div>)}
        <Select value="" onValueChange={(v) => setF({ ...f, articleIds: [...(f.articleIds ?? []), Number(v)] })}><SelectTrigger><SelectValue placeholder="+ Добавить урок" /></SelectTrigger>
          <SelectContent>{arts?.filter((a) => !f.articleIds?.includes(a.id)).map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.title}</SelectItem>)}</SelectContent></Select>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><Label>Тест ({quiz.length} вопросов)</Label><div className="flex items-center gap-2 text-sm">Проходной балл <Input className="w-20" type="number" value={f.passPercent ?? 80} onChange={(e) => setF({ ...f, passPercent: Number(e.target.value) })} />%</div></div>
        {quiz.map((q, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border p-3">
            <div className="flex gap-2"><Input value={q.q} onChange={(e) => setQ(i, { ...q, q: e.target.value })} placeholder={`Вопрос ${i + 1}`} /><Button variant="ghost" size="icon" aria-label="Удалить вопрос" onClick={() => setF({ ...f, quiz: quiz.filter((_, k) => k !== i) })}><Trash2 className="h-4 w-4" /></Button></div>
            {q.options.map((o, j) => <div key={j} className="flex items-center gap-2"><input type="radio" title="Правильный ответ" checked={q.correct === j} onChange={() => setQ(i, { ...q, correct: j })} /><Input className="h-8" value={o} onChange={(e) => setQ(i, { ...q, options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} placeholder={`Вариант ${j + 1}`} />
              {q.options.length > 2 && <button type="button" aria-label="Убрать вариант" onClick={() => setQ(i, { ...q, options: q.options.filter((_, k) => k !== j), correct: q.correct >= j && q.correct > 0 ? q.correct - 1 : q.correct })}><X className="h-4 w-4 text-muted-foreground" /></button>}</div>)}
            {q.options.length < 6 && <button type="button" className="text-xs text-primary" onClick={() => setQ(i, { ...q, options: [...q.options, ""] })}>+ вариант</button>}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Кружком отметьте правильный ответ. Сотрудник не видит правильные ответы — только номера вопросов с ошибками.</p>
        <Button variant="outline" size="sm" onClick={() => setF({ ...f, quiz: [...quiz, { q: "", options: ["", ""], correct: 0 }] })}><Plus className="mr-1 h-4 w-4" />Вопрос</Button>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive !== false} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Курс активен</label>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onClose(false)}>Отмена</Button><Button onClick={save} disabled={!f.title?.trim()}>Сохранить</Button></div>
    </DialogContent>
  );
}

function AssignDialog({ course, onClose }: { course: Course; onClose: () => void }) {
  const { toast } = useToast();
  const { data: staff } = useQuery<{ id: number; name: string; department: string | null; isActive: boolean }[]>({ queryKey: ["/api/personnel/staff"], queryFn: () => customFetch("/api/personnel/staff") });
  const [mode, setMode] = useState<"all" | "department" | "people">(course.department ? "department" : "all");
  const [dept, setDept] = useState(course.department ?? "kitchen");
  const [ids, setIds] = useState<number[]>([]);
  const [due, setDue] = useState("");
  async function go() {
    try {
      const r = await customFetch<{ assigned: number; skipped: number; noAccount: number }>(`/api/training/courses/${course.id}/assign`, { method: "POST", body: JSON.stringify({ ...(mode === "all" ? { all: true } : mode === "department" ? { department: dept } : { staffIds: ids }), dueDate: due || null }) });
      toast({ title: `Назначено: ${r.assigned}`, description: [r.skipped && `уже было назначено: ${r.skipped}`, r.noAccount && `без аккаунта CRM (не смогут пройти, пока не привяжете): ${r.noAccount}`].filter(Boolean).join(" · ") || undefined });
      onClose();
    } catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  return (
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Назначить «{course.title}»</DialogTitle></DialogHeader>
      <div className="flex rounded-lg border p-0.5 text-sm">{([["all", "Всем"], ["department", "Отделу"], ["people", "Выбрать"]] as const).map(([v, l]) => <button key={v} type="button" className={`flex-1 rounded-md px-2 py-1 ${mode === v ? "bg-primary text-primary-foreground" : ""}`} onClick={() => setMode(v)}>{l}</button>)}</div>
      {mode === "department" && <Select value={dept} onValueChange={setDept}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>}
      {mode === "people" && <div className="max-h-60 space-y-1 overflow-y-auto rounded border p-2">{staff?.filter((s) => s.isActive).map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />{s.name}</label>)}</div>}
      <div className="space-y-1.5"><Label>Пройти до</Label><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <p className="text-xs text-muted-foreground">Сотрудники получат сообщение в Telegram (если привязали бота).</p>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Отмена</Button><Button onClick={go} disabled={mode === "people" && !ids.length}>Назначить</Button></div>
    </DialogContent>
  );
}

export default function Training() {
  const { user } = useCurrentUser();
  const editor = EDITORS.includes(user?.role ?? "");
  const qc = useQueryClient();
  const [tab, setTab] = useState("my");
  const { data: my } = useQuery<{ hasStaffCard: boolean; items: MyItem[] }>({ queryKey: ["/api/training/my"], queryFn: () => customFetch("/api/training/my"), enabled: !!user });
  const { data: courses } = useQuery<Course[]>({ queryKey: ["/api/training/courses"], queryFn: () => customFetch("/api/training/courses"), enabled: editor });
  const { data: progress } = useQuery<Prog[]>({ queryKey: ["/api/training/progress"], queryFn: () => customFetch("/api/training/progress"), enabled: editor && tab === "team" });
  const [quiz, setQuiz] = useState<MyItem | null>(null);
  const [edit, setEdit] = useState<Partial<Course> | null>(null);
  const [assign, setAssign] = useState<Course | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/training/my"] }); void qc.invalidateQueries({ queryKey: ["/api/training/courses"] }); void qc.invalidateQueries({ queryKey: ["/api/training/progress"] }); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><GraduationCap className="h-6 w-6 text-primary" />Обучение</h1>
          <p className="text-muted-foreground">Курсы для новых и действующих сотрудников: прочитать уроки из базы знаний и сдать тест.</p>
        </div>
        {editor && tab === "courses" && <Button onClick={() => setEdit({})}><Plus className="mr-2 h-4 w-4" />Новый курс</Button>}
      </div>
      {editor && <Tabs value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="my">Моё обучение</TabsTrigger><TabsTrigger value="courses">Курсы</TabsTrigger><TabsTrigger value="team">Прогресс команды</TabsTrigger></TabsList></Tabs>}

      {tab === "my" && (my && !my.hasStaffCard ? <Card><CardContent className="py-10 text-center text-muted-foreground">Ваш аккаунт не привязан к карточке сотрудника — курсы назначаются по карточкам.</CardContent></Card>
        : !my?.items.length ? <Card><CardContent className="py-10 text-center text-muted-foreground">Вам пока не назначено обучение.</CardContent></Card> : (
          <div className="grid gap-4 lg:grid-cols-2">
            {my.items.map((it) => { const read = it.lessons.filter((l) => l.read).length; return (
              <Card key={it.assignmentId}><CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-2"><div><div className="text-lg font-semibold">{it.title}</div>{it.description && <div className="text-sm text-muted-foreground">{it.description}</div>}</div><span className={`shrink-0 rounded px-2 py-0.5 text-xs ${ST[it.status].cls}`}>{ST[it.status].label}{it.bestScore != null ? ` · ${it.bestScore}%` : ""}</span></div>
                {it.dueDate && it.status !== "passed" && <div className="text-sm text-amber-800">Пройти до {new Date(it.dueDate).toLocaleDateString("ru-RU")}</div>}
                <div><div className="mb-1 flex justify-between text-sm"><span>Уроки</span><span>{read}/{it.lessons.length}</span></div><div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-emerald-500" style={{ width: `${it.lessons.length ? (read / it.lessons.length) * 100 : 100}%` }} /></div></div>
                <ol className="space-y-1">{it.lessons.map((l, i) => <li key={l.id}><Link href="/knowledge" onClick={() => sessionStorage.setItem("kb-open", String(l.id))} className="flex items-center gap-2 text-sm hover:underline">{l.read ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-muted-foreground" />}{i + 1}. {l.title}</Link></li>)}</ol>
                {it.quiz.length > 0 && (it.status === "passed" ? <div className="text-sm text-emerald-700">Тест сдан {it.passedAt && fmtDayTime(it.passedAt)}</div>
                  : <Button className="w-full" disabled={!it.canTakeQuiz} onClick={() => setQuiz(it)}>{it.canTakeQuiz ? `Пройти тест (${it.quiz.length} вопросов, нужно ${it.passPercent}%)` : "Тест откроется после чтения всех уроков"}</Button>)}
              </CardContent></Card>); })}
          </div>
        ))}

      {tab === "courses" && (!courses?.length ? <Card><CardContent className="py-10 text-center text-muted-foreground">Курсов нет. В «Базе знаний» нажмите «Стартовые статьи о CRM» — появится стартовый курс, или создайте свой.</CardContent></Card> : (
        <Card><CardContent className="overflow-x-auto p-0"><Table>
          <TableHeader><TableRow><TableHead>Курс</TableHead><TableHead>Отдел</TableHead><TableHead className="text-right">Уроков</TableHead><TableHead className="text-right">Вопросов</TableHead><TableHead className="text-right">Прошли</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>{courses.map((c) => (
            <TableRow key={c.id} className={c.isActive ? "" : "opacity-50"}><TableCell><div className="font-medium">{c.title}</div><div className="text-xs text-muted-foreground">проходной балл {c.passPercent}%</div></TableCell><TableCell>{c.department ? DEPARTMENTS[c.department] : "Все"}</TableCell><TableCell className="text-right">{c.articleIds.length}</TableCell><TableCell className="text-right">{c.quiz.length}</TableCell><TableCell className="text-right">{c.passed}/{c.assigned}</TableCell>
              <TableCell className="whitespace-nowrap text-right"><Button size="sm" variant="outline" onClick={() => setAssign(c)}><UserPlus className="mr-1.5 h-4 w-4" />Назначить</Button><Button size="icon" variant="ghost" aria-label="Изменить" onClick={() => setEdit(c)}><Pencil className="h-4 w-4" /></Button></TableCell></TableRow>
          ))}</TableBody>
        </Table></CardContent></Card>
      ))}

      {tab === "team" && (
        <Card><CardContent className="overflow-x-auto p-0"><Table>
          <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead>Курс</TableHead><TableHead className="text-right">Уроки</TableHead><TableHead className="text-right">Попыток</TableHead><TableHead className="text-right">Балл</TableHead><TableHead>Статус</TableHead><TableHead>Срок</TableHead></TableRow></TableHeader>
          <TableBody>{!progress?.length ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Курсы ещё никому не назначены</TableCell></TableRow> : progress.map((p) => {
            const late = p.dueDate && p.status !== "passed" && p.dueDate < new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
            return (
              <TableRow key={p.id}><TableCell><div className="font-medium">{p.staffName}</div><div className="text-xs text-muted-foreground">{p.department ? DEPARTMENTS[p.department] : ""}{!p.hasAccount && <span className="text-amber-700"> · нет аккаунта CRM</span>}</div></TableCell>
                <TableCell className="text-sm">{p.course}</TableCell><TableCell className="text-right tabular-nums">{p.lessonsRead}/{p.lessonsTotal}</TableCell><TableCell className="text-right">{p.attempts || "—"}</TableCell><TableCell className="text-right tabular-nums">{p.bestScore != null ? `${p.bestScore}%` : "—"}</TableCell>
                <TableCell><span className={`rounded px-2 py-0.5 text-xs ${ST[p.status].cls}`}>{ST[p.status].label}</span></TableCell>
                <TableCell className={`text-sm ${late ? "font-medium text-red-700" : "text-muted-foreground"}`}>{p.status === "passed" && p.passedAt ? `сдан ${fmtDayTime(p.passedAt)}` : p.dueDate ? new Date(p.dueDate).toLocaleDateString("ru-RU") + (late ? " — просрочен" : "") : "—"}</TableCell></TableRow>
            ); })}</TableBody>
        </Table></CardContent></Card>
      )}

      <Dialog open={!!quiz} onOpenChange={(o) => !o && setQuiz(null)}>{quiz && <QuizDialog item={quiz} onDone={refresh} />}</Dialog>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>{edit && <CourseEditor course={edit} onClose={(s) => { setEdit(null); if (s) refresh(); }} />}</Dialog>
      <Dialog open={!!assign} onOpenChange={(o) => !o && setAssign(null)}>{assign && <AssignDialog course={assign} onClose={() => { setAssign(null); refresh(); }} />}</Dialog>
    </div>
  );
}
