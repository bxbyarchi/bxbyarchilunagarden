import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Search, Plus, Pin, CheckCircle2, Pencil, Trash2, Sparkles, ArrowLeft, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import Markdown from "@/components/Markdown";
import { errMsg, fmtDayTime } from "@/lib/personnel";

export const KB_CATEGORY: Record<string, string> = {
  general: "Общее", crm: "Работа в CRM", kitchen: "Кухня", bar: "Бар", pastry: "Кондитерка", hall: "Зал и сервис", admin: "Администрация", tech: "Техперсонал", safety: "Безопасность и санитария",
};
const EDITORS = ["super_admin", "warehouse_chief", "location_admin", "manager"];
interface Row { id: number; title: string; excerpt: string; category: string; tags: string[]; status: string; pinned: boolean; version: number; updatedAt: string; readByMe: boolean; updatedSinceRead: boolean }
interface Article extends Omit<Row, "excerpt"> { body: string; readAt: string | null; updatedByName: string | null; canEdit: boolean; readers: { name: string; readAt: string | null; oldVersion: boolean }[] | null }
type Form = { id?: number; title: string; category: string; tags: string; body: string; pinned: boolean; status: string; minor: boolean };

function Editor({ f, setF, onSave, onCancel }: { f: Form; setF: (f: Form) => void; onSave: () => void; onCancel: () => void }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2"><Label>Заголовок</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Например: Стандарт подачи блюд" /></div>
        <div className="space-y-1.5"><Label>Раздел</Label><Select value={f.category} onValueChange={(v) => setF({ ...f, category: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(KB_CATEGORY).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
      </div>
      <div className="flex items-center justify-between"><Label>Текст</Label><div className="flex rounded-md border p-0.5 text-xs">{["Текст", "Как увидят"].map((l, i) => <button key={l} type="button" className={`rounded px-2 py-0.5 ${preview === !!i ? "bg-primary text-primary-foreground" : ""}`} onClick={() => setPreview(!!i)}>{l}</button>)}</div></div>
      {preview ? <div className="min-h-[300px] rounded-md border p-3 text-sm"><Markdown text={f.body || "_пусто_"} /></div>
        : <Textarea rows={14} className="font-mono text-sm" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={"## Заголовок\nОбычный текст.\n\n1. Шаг первый\n2. Шаг второй\n\n- пункт списка\n**жирный текст**\n\n| Блюдо | Граммовка |\n|---|---|\n| Цезарь | 250 г |"} />}
      <p className="text-xs text-muted-foreground">Оформление: «## » — заголовок, «1. » и «- » — списки, **жирный**, таблицы через «|».</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 space-y-1.5"><Label>Метки через запятую</Label><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="подача, стандарт, зал" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Закрепить сверху</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.status === "draft"} onChange={(e) => setF({ ...f, status: e.target.checked ? "draft" : "published" })} />Черновик (видят только управляющие)</label>
        {f.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.minor} onChange={(e) => setF({ ...f, minor: e.target.checked })} />Мелкая правка (не просить перечитать)</label>}
      </div>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onCancel}>Отмена</Button><Button onClick={onSave} disabled={!f.title.trim()}>Сохранить</Button></div>
    </div>
  );
}

export default function Knowledge() {
  const { user } = useCurrentUser();
  const editor = EDITORS.includes(user?.role ?? "");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  // Opened from a training lesson link.
  const [openId, setOpenId] = useState<number | null>(() => { try { const v = sessionStorage.getItem("kb-open"); sessionStorage.removeItem("kb-open"); return v ? Number(v) : null; } catch { return null; } });
  const [form, setForm] = useState<Form | null>(null);
  const [showReaders, setShowReaders] = useState(false);
  const params = new URLSearchParams({ ...(cat !== "all" ? { category: cat } : {}), ...(q.trim() ? { search: q.trim() } : {}) }).toString();
  const { data: rows } = useQuery<Row[]>({ queryKey: ["/api/kb/articles", params], queryFn: () => customFetch(`/api/kb/articles?${params}`), enabled: !!user });
  const { data: a } = useQuery<Article>({ queryKey: ["/api/kb/articles", openId], queryFn: () => customFetch(`/api/kb/articles/${openId}`), enabled: openId != null });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/kb/articles"] }); void qc.invalidateQueries({ queryKey: ["/api/training/my"] }); };

  async function save() {
    if (!form) return;
    try {
      const body = { title: form.title, category: form.category, tags: form.tags, body: form.body, pinned: form.pinned, status: form.status, minor: form.minor };
      if (form.id) await customFetch(`/api/kb/articles/${form.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else { const r = await customFetch<{ id: number }>("/api/kb/articles", { method: "POST", body: JSON.stringify(body) }); setOpenId(r.id); }
      setForm(null); refresh(); toast({ title: "Статья сохранена" });
    } catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  async function markRead() {
    if (!a) return;
    await customFetch(`/api/kb/articles/${a.id}/read`, { method: "POST" }); refresh();
    toast({ title: "Отмечено: ознакомлен(а)" });
  }
  async function remove() {
    if (!a || !confirm(`Удалить статью «${a.title}»?`)) return;
    await customFetch(`/api/kb/articles/${a.id}`, { method: "DELETE" }); setOpenId(null); refresh();
  }
  async function starter() {
    try { const r = await customFetch<{ articles: number }>("/api/kb/starter", { method: "POST" }); refresh(); void qc.invalidateQueries({ queryKey: ["/api/training/courses"] }); toast({ title: `Стартовые статьи готовы: ${r.articles}`, description: "И курс «Старт: работа в CRM» в разделе «Обучение»." }); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  const unread = (rows ?? []).filter((r) => r.status === "published" && !r.readByMe).length;

  if (openId != null && a && !form) {
    const readCount = a.readers?.filter((r) => r.readAt).length ?? 0;
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <button type="button" className="flex items-center gap-1 text-sm text-primary" onClick={() => { setOpenId(null); setShowReaders(false); }}><ArrowLeft className="h-4 w-4" />База знаний</button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{KB_CATEGORY[a.category]}{a.status === "draft" && " · черновик"}</div>
            <h1 className="text-2xl font-bold tracking-tight">{a.title}</h1>
            <div className="text-xs text-muted-foreground">Обновлено {fmtDayTime(a.updatedAt)}{a.updatedByName && ` · ${a.updatedByName}`} · версия {a.version}</div>
          </div>
          {a.canEdit && <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => setShowReaders((v) => !v)}><Users className="mr-1.5 h-4 w-4" />Ознакомились {readCount}/{a.readers?.length ?? 0}</Button>
            <Button variant="outline" size="sm" onClick={() => setForm({ id: a.id, title: a.title, category: a.category, tags: a.tags.join(", "), body: a.body, pinned: a.pinned, status: a.status, minor: false })}><Pencil className="mr-1.5 h-4 w-4" />Изменить</Button>
            <Button variant="ghost" size="sm" onClick={remove} aria-label="Удалить"><Trash2 className="h-4 w-4" /></Button>
          </div>}
        </div>
        {showReaders && a.readers && <Card><CardContent className="grid gap-x-6 gap-y-1 p-4 text-sm sm:grid-cols-2">{a.readers.map((r) => <div key={r.name} className="flex justify-between gap-2"><span>{r.name}</span><span className={r.readAt ? "text-emerald-700" : r.oldVersion ? "text-amber-700" : "text-muted-foreground"}>{r.readAt ? fmtDayTime(r.readAt) : r.oldVersion ? "читал(а) старую версию" : "не читал(а)"}</span></div>)}</CardContent></Card>}
        <Card><CardContent className="p-6 text-[15px]"><Markdown text={a.body || "_Статья пока пустая._"} /></CardContent></Card>
        {a.tags.length > 0 && <div className="flex flex-wrap gap-1">{a.tags.map((t) => <Badge key={t} variant="secondary">#{t}</Badge>)}</div>}
        {a.status === "published" && (a.readByMe
          ? <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />Вы ознакомились {a.readAt && fmtDayTime(a.readAt)}</div>
          : <Button size="lg" className="w-full" onClick={markRead}><CheckCircle2 className="mr-2 h-5 w-5" />Я прочитал(а) и ознакомлен(а)</Button>)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><BookOpen className="h-6 w-6 text-primary" />База знаний</h1>
          <p className="text-muted-foreground">Регламенты, стандарты и инструкции ресторана. Новые и изменённые статьи нужно прочитать и подтвердить.</p>
        </div>
        {editor && <div className="flex gap-2">
          {!rows?.some((r) => r.category === "crm") && <Button variant="outline" onClick={starter}><Sparkles className="mr-2 h-4 w-4" />Стартовые статьи о CRM</Button>}
          <Button onClick={() => setForm({ title: "", category: cat !== "all" ? cat : "general", tags: "", body: "", pinned: false, status: "published", minor: false })}><Plus className="mr-2 h-4 w-4" />Новая статья</Button>
        </div>}
      </div>
      {unread > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Непрочитанных статей: <b>{unread}</b> — откройте и подтвердите, что ознакомились.</div>}

      <div className="flex flex-col gap-4 md:flex-row">
        <aside className="flex flex-wrap gap-1 md:w-56 md:flex-col">
          {[["all", "Все разделы"], ...Object.entries(KB_CATEGORY)].map(([k, v]) => <button key={k} type="button" onClick={() => setCat(k)} className={`rounded-md px-3 py-1.5 text-left text-sm ${cat === k ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{v}</button>)}
        </aside>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Поиск по статьям: «опоздание», «списание», «подача»…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {!rows?.length ? <Card><CardContent className="py-12 text-center text-muted-foreground">{q ? "Ничего не найдено" : editor ? "Статей пока нет. Нажмите «Стартовые статьи о CRM» или «Новая статья»." : "Статей пока нет"}</CardContent></Card> : (
            <div className="grid gap-3 lg:grid-cols-2">
              {rows.map((r) => (
                <button key={r.id} type="button" onClick={() => setOpenId(r.id)} className="rounded-xl border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-sm">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">{r.pinned && <Pin className="h-3 w-3 text-primary" />}{KB_CATEGORY[r.category]}{r.status === "draft" && <Badge variant="outline" className="text-[10px]">черновик</Badge>}
                    <span className="ml-auto">{r.readByMe ? <span className="text-emerald-700">✓ прочитано</span> : r.updatedSinceRead ? <span className="font-medium text-amber-700">обновлено</span> : r.status === "published" ? <span className="font-medium text-primary">новое</span> : null}</span></div>
                  <div className="mt-1 font-semibold">{r.title}</div>
                  <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.excerpt}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>{form?.id ? "Изменить статью" : "Новая статья"}</DialogTitle></DialogHeader>
          {form && <Editor f={form} setF={setForm} onSave={save} onCancel={() => setForm(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
