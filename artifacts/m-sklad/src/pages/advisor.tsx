import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Plus, Send, Trash2, FileBarChart, AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import Markdown from "@/components/Markdown";
import { errMsg, fmtDayTime } from "@/lib/personnel";

interface ChatRow { id: number; title: string; updatedAt: string }
interface ChatList { chats: ChatRow[]; used: number; limit: number; configured: boolean }
interface Msg { id: number; role: "user" | "assistant"; text: string; actions: { report: string; params: Record<string, string | null>; ok: boolean }[] | null; error: string | null; costUsd: number | null; createdAt: string }

const REPORT_RU: Record<string, string> = {
  sales_margin: "продажи и маржа", kassa_summary: "аналитика касс", cash_report: "деньги в кассах", stock_items: "остатки", low_stock: "низкие остатки", stock_movement: "движение товаров",
  purchases: "закупки", top_write_offs: "списания", tech_cards: "тех-карты", bookings: "брони", timesheet: "табель", schedule: "график смен", tasks_efficiency: "эффективность задач",
  tasks_overdue: "просроченные задачи", tasks_open: "открытые задачи", money_summary: "запросы денег", money_advances: "подотчёт", money_requests: "запросы денег", ai_agent_stats: "ИИ-агент",
};
const ddmm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");
const SUGGEST = [
  "Как прошла прошлая неделя по продажам? Сравни с позапрошлой",
  "Какие блюда самые и наименее маржинальные в этом месяце?",
  "Что заканчивается на складе и что нужно заказать?",
  "Где мы теряем деньги: списания, перерасход, недостачи?",
  "Кто в этом месяце опаздывает и у кого больше переработок?",
  "Как оформить списание разбитой посуды?",
];

export default function Advisor() {
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: list } = useQuery<ChatList>({ queryKey: ["/api/advisor/chats"], queryFn: () => customFetch("/api/advisor/chats"), enabled: !!user });
  const [chatId, setChatId] = useState<number | null>(null);
  const { data: chat } = useQuery<{ id: number; title: string; messages: Msg[] }>({ queryKey: ["/api/advisor/chats", chatId], queryFn: () => customFetch(`/api/advisor/chats/${chatId}`), enabled: chatId != null });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat?.messages.length, pending]);

  async function send(q = text) {
    const question = q.trim();
    if (!question || pending) return;
    setPending(question); setText("");
    try {
      let id = chatId;
      if (id == null) { const c = await customFetch<{ id: number }>("/api/advisor/chats", { method: "POST" }); id = c.id; setChatId(id); }
      await customFetch(`/api/advisor/chats/${id}/messages`, { method: "POST", body: JSON.stringify({ text: question }) });
      await qc.invalidateQueries({ queryKey: ["/api/advisor/chats"] });
    } catch (e) { toast({ title: "Советник не ответил", description: errMsg(e), variant: "destructive" }); setText(question); }
    finally { setPending(null); }
  }
  async function remove(id: number) {
    if (!confirm("Удалить этот разговор?")) return;
    await customFetch(`/api/advisor/chats/${id}`, { method: "DELETE" });
    if (chatId === id) setChatId(null);
    void qc.invalidateQueries({ queryKey: ["/api/advisor/chats"] });
  }
  const messages = chat?.messages ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Sparkles className="h-6 w-6 text-primary" />ИИ-советник</h1>
          <p className="text-muted-foreground">Спросите про работу ресторана или про CRM. Советник смотрит отчёты с вашими правами доступа — только то, что видно вам.</p>
        </div>
        {list && <div className="text-sm text-muted-foreground">Вопросов за сутки: {list.used} из {list.limit}</div>}
      </div>
      {list && !list.configured && <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />На сервере не задан ключ Anthropic API (ANTHROPIC_API_KEY) — советник не сможет отвечать.</div>}

      <Card className="overflow-hidden">
        <div className="flex h-[calc(100dvh-14rem)] min-h-[520px]">
          <aside className={`w-full shrink-0 flex-col border-r md:flex md:w-64 ${chatId == null && !pending ? "flex" : "hidden"}`}>
            <div className="border-b p-2"><Button variant="outline" className="w-full" onClick={() => { setChatId(null); setText(""); }}><Plus className="mr-2 h-4 w-4" />Новый вопрос</Button></div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!list?.chats.length && <p className="p-4 text-sm text-muted-foreground">Здесь будут ваши разговоры. Их видите только вы.</p>}
              {list?.chats.map((c) => (
                <div key={c.id} className={`group flex items-center gap-1 border-b px-3 py-2 text-sm ${chatId === c.id ? "bg-muted" : "hover:bg-muted/50"}`}>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setChatId(c.id)}><div className="truncate">{c.title}</div><div className="text-[11px] text-muted-foreground">{fmtDayTime(c.updatedAt)}</div></button>
                  <button type="button" aria-label="Удалить разговор" className="opacity-0 group-hover:opacity-100" onClick={() => remove(c.id)}><Trash2 className="h-4 w-4 text-muted-foreground" /></button>
                </div>
              ))}
            </div>
          </aside>

          <section className={`min-w-0 flex-1 flex-col ${chatId == null && !pending ? "hidden md:flex" : "flex"}`}>
            <button type="button" className="border-b px-4 py-2 text-left text-sm text-primary md:hidden" onClick={() => setChatId(null)}>← Разговоры</button>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/20 p-4">
              {!messages.length && !pending && (
                <div className="mx-auto max-w-2xl pt-6 text-center">
                  <Sparkles className="mx-auto h-10 w-10 text-primary/60" />
                  <div className="mt-2 text-lg font-medium">Чем помочь?</div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {SUGGEST.map((s) => <button key={s} type="button" onClick={() => send(s)} className="rounded-lg border bg-card px-3 py-2 text-left text-sm hover:border-primary/50 hover:bg-primary/5">{s}</button>)}
                  </div>
                </div>
              )}
              {messages.map((m) => m.role === "user" ? (
                <div key={m.id} className="flex justify-end"><div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">{m.text}</div></div>
              ) : (
                <div key={m.id} className="flex">
                  <div className={`max-w-[92%] rounded-2xl rounded-bl-sm border px-4 py-3 text-sm shadow-sm ${m.error ? "border-red-200 bg-red-50" : "bg-card"}`}>
                    {m.error ? <div className="text-red-800"><b>Не получилось ответить:</b> {m.error}</div> : <Markdown text={m.text} />}
                    {!!m.actions?.length && (
                      <div className="mt-2 flex flex-wrap gap-1 border-t pt-2">
                        {m.actions.map((a, i) => (
                          <span key={i} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${a.ok ? "bg-muted text-muted-foreground" : "bg-amber-100 text-amber-900"}`} title={a.ok ? "" : "Нет доступа или ошибка"}>
                            <FileBarChart className="h-3 w-3" />{REPORT_RU[a.report] ?? a.report}{a.params.from ? ` ${ddmm(a.params.from)}–${ddmm(a.params.to)}` : ""}{a.ok ? "" : " — недоступно"}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {pending && <>
                <div className="flex justify-end"><div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">{pending}</div></div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Смотрю отчёты и думаю… обычно 10–40 секунд</div>
              </>}
              <div ref={end} />
            </div>
            <div className="border-t p-3">
              <div className="flex gap-2">
                <Textarea rows={2} className="min-h-0 resize-none" value={text} disabled={!!pending} onChange={(e) => setText(e.target.value)} placeholder="Например: почему упала выручка в эти выходные?"
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <Button className="self-end" onClick={() => send()} disabled={!text.trim() || !!pending} aria-label="Спросить"><Send className="h-4 w-4" /></Button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Советник только смотрит и советует — ничего не меняет в системе. Проверяйте важные цифры в отчётах.</p>
            </div>
          </section>
        </div>
      </Card>
    </div>
  );
}
