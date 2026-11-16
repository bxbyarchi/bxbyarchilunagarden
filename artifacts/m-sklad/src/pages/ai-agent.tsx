import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bot, AlertTriangle, MessageSquarePlus, Send, UserCheck, RotateCcw, CheckCircle2, XCircle, Wrench, Phone, Instagram, MessageCircle, FlaskConical, Crown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtPhone, STATUS as BOOKING_STATUS } from "./bookings";

interface ConvRow {
  id: number; channel: string; externalId: string; contactName: string | null; status: "ai" | "human" | "closed";
  needsAttention: boolean; attentionKind: string | null; attentionReason: string | null; lastMessageAt: string;
  guestId: number | null; guestName: string | null; guestPhone: string | null; last: string | null; lastRole: string | null;
  stats: { messages: number; errors: number; cost: number };
}
interface Msg { id: number; role: "guest" | "ai" | "staff" | "note"; text: string; actions: { tool: string; input: unknown; ok: boolean; result: string }[] | null; error: string | null; model: string | null; costUsd: number | null; authorName: string | null; createdAt: string }
interface ConvDetail extends Omit<ConvRow, "guestName" | "guestPhone" | "last" | "lastRole" | "stats"> {
  messages: Msg[];
  guest: { id: number; name: string; phone: string | null; isVip: boolean; notes: string | null; tags: string[] } | null;
  bookings: { id: number; startsAt: string; partySize: number; status: string; depositAmount: string | null; depositStatus: string }[];
}
interface Stats { days: number; guestMessages: number; aiReplies: number; staffReplies: number; errors: number; cost: number; conversations: number; aiBookings: { bookings: number; guests: number; cancelled: number }; needsAttention: number }
interface Settings { enabled: boolean; model: string; models: string[]; apiKeyConfigured: boolean; restaurantInfo: string | null; tone: string | null; depositRules: string | null; paymentDetails: string | null; knowledge: string | null; maxPartyForAi: number; depositMinParty: number | null; depositPerGuest: number | null }

const CHANNEL: Record<string, { label: string; icon: typeof Bot }> = {
  test: { label: "Тест", icon: FlaskConical }, whatsapp: { label: "WhatsApp", icon: MessageCircle }, instagram: { label: "Instagram", icon: Instagram }, phone: { label: "Звонок", icon: Phone },
};
const KIND: Record<string, string> = { complaint: "Жалоба", large_event: "Банкет / большая компания", human_request: "Просит человека", error: "Ошибка ИИ", other: "Нужен менеджер" };
const TOOL: Record<string, string> = { get_menu: "смотрел меню", check_availability: "проверил столы", create_booking: "создал бронь", my_bookings: "смотрел брони гостя", change_booking: "изменил бронь", cancel_booking: "отменил бронь", save_guest_note: "записал заметку о госте", escalate_to_manager: "позвал менеджера" };
const MODEL: Record<string, string> = { "claude-opus-5-5": "Claude Opus 5.5 — умнее всех, дороже", "claude-sonnet-5-5": "Claude Sonnet 5.5 — баланс", "claude-haiku-5-5": "Claude Haiku 5.5 — быстрый и дешёвый" };
const errMsg = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;
const time = (s: string) => new Date(s).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const usd = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;

function ActionChips({ actions }: { actions: Msg["actions"] }) {
  const [open, setOpen] = useState(false);
  if (!actions?.length) return null;
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex flex-wrap gap-1 text-left">
        {actions.map((a, i) => (
          <span key={i} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${a.ok ? "bg-black/5 text-foreground/70" : "bg-red-100 text-red-800"}`}>
            <Wrench className="h-3 w-3" />{TOOL[a.tool] ?? a.tool}{a.ok ? "" : " — ошибка"}
          </span>
        ))}
      </button>
      {open && <div className="mt-1 space-y-1">{actions.map((a, i) => (
        <pre key={i} className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px] leading-snug">{a.tool}({JSON.stringify(a.input)})\n→ {a.result}</pre>
      ))}</div>}
    </div>
  );
}

function Conversation({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ["/api/ai/conversations", id];
  const { data: c } = useQuery<ConvDetail>({ queryKey: key, queryFn: () => customFetch(`/api/ai/conversations/${id}`), refetchInterval: 5000 });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [c?.messages.length]);
  if (!c) return <div className="p-8 text-center text-muted-foreground">Загрузка…</div>;
  const isTest = c.channel === "test";
  const asGuest = isTest && c.status !== "human";

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await customFetch(`/api/ai/conversations/${id}/${asGuest ? "guest-message" : "staff-reply"}`, { method: "POST", body: JSON.stringify({ text }) });
      setText(""); await qc.invalidateQueries({ queryKey: key }); onChanged();
    } catch (e) { toast({ title: "Не отправлено", description: errMsg(e), variant: "destructive" }); } finally { setSending(false); }
  }
  async function act(action: string) {
    try { await customFetch(`/api/ai/conversations/${id}/status`, { method: "POST", body: JSON.stringify({ action }) }); await qc.invalidateQueries({ queryKey: key }); onChanged(); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  const Ch = CHANNEL[c.channel] ?? CHANNEL.test;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Ch.icon className="h-4 w-4 text-muted-foreground" />
          <div className="font-semibold">{c.guest?.name ?? c.contactName ?? c.externalId}</div>
          <Badge variant={c.status === "human" ? "default" : "secondary"}>{c.status === "ai" ? "отвечает ИИ" : c.status === "human" ? "у менеджера" : "закрыт"}</Badge>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {c.status !== "human" ? <Button size="sm" variant="outline" onClick={() => act("takeover")}><UserCheck className="mr-1.5 h-4 w-4" />Взять диалог</Button>
              : <Button size="sm" variant="outline" onClick={() => act("release")}><RotateCcw className="mr-1.5 h-4 w-4" />Вернуть ИИ</Button>}
            {c.needsAttention && <Button size="sm" onClick={() => act("resolve")}><CheckCircle2 className="mr-1.5 h-4 w-4" />Решено</Button>}
            {c.status !== "closed" && <Button size="sm" variant="ghost" onClick={() => act("close")}><XCircle className="mr-1.5 h-4 w-4" />Закрыть</Button>}
          </div>
        </div>
        {c.needsAttention && (
          <div className="flex gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><b>{KIND[c.attentionKind ?? ""] ?? "Нужен менеджер"}:</b> {c.attentionReason}</div>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/20 px-4 py-4">
          {c.messages.map((m) => m.role === "note" ? (
            <div key={m.id} className="text-center text-xs text-muted-foreground">{m.text}{m.authorName ? ` · ${m.authorName}` : ""} · {time(m.createdAt)}</div>
          ) : (
            <div key={m.id} className={`flex ${m.role === "guest" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.role === "guest" ? "rounded-bl-sm bg-card border" : m.role === "staff" ? "rounded-br-sm bg-sky-100 text-sky-950" : m.error ? "rounded-br-sm bg-red-50 border border-red-200" : "rounded-br-sm bg-primary/10"}`}>
                <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {m.role === "ai" && <Bot className="h-3 w-3" />}
                  {m.role === "guest" ? "Гость" : m.role === "staff" ? `Менеджер${m.authorName ? ` · ${m.authorName}` : ""}` : "ИИ"} · {time(m.createdAt)}
                  {m.costUsd != null && <span>· {usd(m.costUsd)}</span>}
                </div>
                <div className="whitespace-pre-wrap">{m.text}</div>
                {m.error && <div className="mt-1.5 rounded bg-red-100 px-2 py-1 text-xs text-red-800"><b>Ошибка:</b> {m.error}</div>}
                <ActionChips actions={m.actions} />
              </div>
            </div>
          ))}
          <div ref={end} />
        </div>
        <div className="border-t p-3">
          {isTest && <p className="mb-1.5 text-xs text-muted-foreground">{asGuest ? "Тестовый чат: вы пишете как гость — ИИ отвечает так же, как в WhatsApp. Брони создаются настоящие." : "Диалог у менеджера — вы пишете от имени ресторана."}</p>}
          <div className="flex gap-2">
            <Textarea rows={2} className="min-h-0 resize-none" placeholder={asGuest ? "Сообщение от гостя…" : "Ответ гостю от менеджера…"} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <Button onClick={send} disabled={sending || !text.trim()} className="self-end" aria-label="Отправить">{sending ? "…" : <Send className="h-4 w-4" />}</Button>
          </div>
          {!isTest && <p className="mt-1 text-xs text-muted-foreground">Ответ менеджера переводит диалог на человека — ИИ перестаёт отвечать, пока вы его не вернёте.</p>}
        </div>
      </div>
      <aside className="w-full shrink-0 border-t p-4 text-sm lg:w-72 lg:border-l lg:border-t-0 overflow-y-auto">
        <div className="mb-2 font-semibold">Гость</div>
        {c.guest ? (
          <div className="space-y-1.5">
            <Link href={`/guests/${c.guest.id}`} className="font-medium text-primary hover:underline">{c.guest.isVip && <Crown className="mr-1 inline h-3.5 w-3.5 text-amber-500" />}{c.guest.name}</Link>
            {c.guest.phone && <div className="text-muted-foreground">{fmtPhone(c.guest.phone)}</div>}
            {c.guest.notes && <div className="whitespace-pre-wrap rounded bg-amber-50 p-2 text-xs text-amber-900">{c.guest.notes}</div>}
          </div>
        ) : <p className="text-muted-foreground">Ещё не определён — появится, когда гость оставит телефон или забронирует.</p>}
        {c.bookings.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <div className="font-semibold">Брони</div>
            {c.bookings.map((b) => (
              <div key={b.id} className="rounded border p-2">
                <div>{time(b.startsAt)} · {b.partySize} чел.</div>
                <div className="flex items-center gap-1.5 text-xs"><span className={`rounded border px-1.5 ${BOOKING_STATUS[b.status]?.cls}`}>{BOOKING_STATUS[b.status]?.label}</span>{b.depositAmount && <span className="text-muted-foreground">предоплата {Number(b.depositAmount)} · {b.depositStatus === "paid" ? "оплачена" : "ждём"}</span>}</div>
              </div>
            ))}
            <Link href="/bookings" className="text-xs text-primary hover:underline">Открыть календарь броней</Link>
          </div>
        )}
      </aside>
    </div>
  );
}

function SettingsForm() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { canDo, user } = useCurrentUser();
  const { data: s } = useQuery<Settings>({ queryKey: ["/api/ai/settings"], queryFn: () => customFetch("/api/ai/settings") });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => { if (s) setF(s); }, [s]);
  if (!f) return null;
  const canEdit = ["super_admin", "location_admin", "manager"].includes(user?.role ?? "") || canDo("manager");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  async function save() {
    try { await customFetch("/api/ai/settings", { method: "PUT", body: JSON.stringify(f) }); await qc.invalidateQueries({ queryKey: ["/api/ai/settings"] }); toast({ title: "Настройки агента сохранены" }); }
    catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); }
  }
  const area = (k: "restaurantInfo" | "tone" | "depositRules" | "paymentDetails" | "knowledge", label: string, rows: number, ph: string) => (
    <div className="space-y-1.5"><Label>{label}</Label><Textarea rows={rows} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={ph} disabled={!canEdit} /></div>
  );
  return (
    <div className="space-y-4 max-w-3xl">
      {!s?.apiKeyConfigured && <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />Ключ Anthropic API не задан на сервере (переменная ANTHROPIC_API_KEY в .env) — агент отвечает гостям только «передал менеджеру».</div>}
      <Card><CardContent className="space-y-4 pt-6">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} disabled={!canEdit} />Агент включён (если выключить — сообщения копятся для менеджеров)</label>
        <div className="space-y-1.5"><Label>Модель</Label>
          <Select value={f.model} onValueChange={(v) => set("model", v)} disabled={!canEdit}><SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{f.models.map((m) => <SelectItem key={m} value={m}>{MODEL[m] ?? m}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {area("restaurantInfo", "О ресторане", 4, "Адрес, часы работы, парковка, как добраться, телефон, детская комната…")}
        {area("tone", "Как общаться", 2, "Например: дружелюбно, на «вы», можно эмодзи в меру")}
        {area("knowledge", "База знаний", 8, "Акции, банкетное меню, правила (дресс-код, пробковый сбор), частые вопросы и ответы…")}
      </CardContent></Card>
      <Card><CardHeader className="pb-2"><CardTitle className="text-base">Брони и предоплата</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>ИИ бронирует до … гостей</Label><Input type="number" value={f.maxPartyForAi} onChange={(e) => set("maxPartyForAi", Number(e.target.value))} disabled={!canEdit} /><p className="text-xs text-muted-foreground">Больше — передаёт менеджеру</p></div>
          <div className="space-y-1.5"><Label>Предоплата от … гостей</Label><Input type="number" value={f.depositMinParty ?? ""} onChange={(e) => set("depositMinParty", e.target.value ? Number(e.target.value) : null)} placeholder="не нужна" disabled={!canEdit} /></div>
          <div className="space-y-1.5"><Label>Сом за гостя</Label><Input type="number" value={f.depositPerGuest ?? ""} onChange={(e) => set("depositPerGuest", e.target.value ? Number(e.target.value) : null)} disabled={!canEdit} /></div>
        </div>
        <p className="text-xs text-muted-foreground">Сумму предоплаты считает система, а не ИИ — он только сообщает её гостю.</p>
        {area("paymentDetails", "Куда платить предоплату", 2, "QR Mbank, номер для перевода, получатель…")}
        {area("depositRules", "Условия предоплаты для гостей", 2, "Например: возвращается при отмене не позднее чем за 24 часа")}
      </CardContent></Card>
      {canEdit && <Button onClick={save}>Сохранить</Button>}
    </div>
  );
}

export default function AiAgent() {
  const { user, isLoading } = useCurrentUser();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"dialogs" | "settings">("dialogs");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<number | null>(null);
  const { data: rows } = useQuery<ConvRow[]>({ queryKey: ["/api/ai/conversations", filter], queryFn: () => customFetch(`/api/ai/conversations?filter=${filter}`), refetchInterval: 10_000 });
  const { data: stats } = useQuery<Stats>({ queryKey: ["/api/ai/stats"], queryFn: () => customFetch("/api/ai/stats?days=30"), refetchInterval: 30_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/ai/conversations", filter] }); void qc.invalidateQueries({ queryKey: ["/api/ai/stats"] }); };

  if (isLoading) return null;
  if (!user || !["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"].includes(user.role)) return <AccessDenied />;

  async function newTest() {
    try { const c = await customFetch<{ id: number }>("/api/ai/test-chat", { method: "POST", body: JSON.stringify({}) }); setFilter("all"); setTab("dialogs"); setSelected(c.id); refresh(); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">ИИ-агент</h1>
          <p className="text-muted-foreground">Переписки и звонки, которые ведёт ИИ: брони, консультации, ошибки и всё, где нужен менеджер.</p>
        </div>
        <Button onClick={newTest}><MessageSquarePlus className="mr-2 h-4 w-4" />Тестовый чат</Button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Диалогов за 30 дней</div><div className="mt-0.5 text-lg font-semibold">{stats.conversations}</div><div className="text-xs text-muted-foreground">{stats.guestMessages} сообщений гостей</div></div>
          <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Броней от ИИ</div><div className="mt-0.5 text-lg font-semibold">{stats.aiBookings.bookings}</div><div className="text-xs text-muted-foreground">{stats.aiBookings.guests} гостей · отмен {stats.aiBookings.cancelled}</div></div>
          <div className={`rounded-xl border p-3 ${stats.needsAttention ? "border-amber-300 bg-amber-50" : "bg-card"}`}><div className="text-xs text-muted-foreground">Ждут менеджера</div><div className="mt-0.5 text-lg font-semibold">{stats.needsAttention}</div></div>
          <div className={`rounded-xl border p-3 ${stats.errors ? "border-red-200 bg-red-50" : "bg-card"}`}><div className="text-xs text-muted-foreground">Ошибок ИИ</div><div className="mt-0.5 text-lg font-semibold">{stats.errors}</div></div>
          <div className="rounded-xl border bg-card p-3"><div className="text-xs text-muted-foreground">Расход на ИИ</div><div className="mt-0.5 text-lg font-semibold">{usd(stats.cost)}</div><div className="text-xs text-muted-foreground">ответов: {stats.aiReplies}</div></div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}><TabsList><TabsTrigger value="dialogs">Диалоги</TabsTrigger><TabsTrigger value="settings">Настройки агента</TabsTrigger></TabsList></Tabs>

      {tab === "settings" ? <SettingsForm /> : (
        <Card className="overflow-hidden">
          <div className="flex h-[calc(100dvh-22rem)] min-h-[520px]">
            <div className={`w-full shrink-0 border-r md:w-80 ${selected ? "hidden md:flex" : "flex"} flex-col`}>
              <div className="flex flex-wrap gap-1 border-b p-2">
                {[["all", "Все"], ["attention", "Важное"], ["errors", "Ошибки"], ["human", "У менеджера"]].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setFilter(v)} className={`rounded-full px-2.5 py-1 text-xs ${filter === v ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{l}</button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto divide-y">
                {!rows?.length && <div className="p-6 text-center text-sm text-muted-foreground">Диалогов нет. Откройте «Тестовый чат», чтобы проверить агента.</div>}
                {rows?.map((r) => {
                  const Ch = CHANNEL[r.channel] ?? CHANNEL.test;
                  return (
                    <button key={r.id} type="button" onClick={() => setSelected(r.id)} className={`block w-full px-3 py-2.5 text-left hover:bg-muted/50 ${selected === r.id ? "bg-muted" : ""}`}>
                      <div className="flex items-center gap-1.5">
                        <Ch.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium text-sm">{r.guestName ?? r.contactName ?? r.externalId}</span>
                        {r.needsAttention && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />}
                        {r.stats.errors > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Есть ошибки" />}
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{time(r.lastMessageAt)}</span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.lastRole === "ai" ? "ИИ: " : r.lastRole === "staff" ? "Менеджер: " : ""}{r.last}</div>
                      {(r.status === "human" || r.attentionKind) && <div className="mt-1 flex gap-1">{r.status === "human" && <Badge variant="secondary" className="text-[10px]">у менеджера</Badge>}{r.needsAttention && r.attentionKind && <Badge variant="outline" className="text-[10px]">{KIND[r.attentionKind]}</Badge>}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className={`min-w-0 flex-1 ${selected ? "flex" : "hidden md:flex"} flex-col`}>
              {selected ? (
                <>
                  <button type="button" className="border-b px-4 py-2 text-left text-sm text-primary md:hidden" onClick={() => setSelected(null)}>← Все диалоги</button>
                  <div className="min-h-0 flex-1"><Conversation id={selected} onChanged={refresh} /></div>
                </>
              ) : <div className="m-auto p-8 text-center text-muted-foreground"><Bot className="mx-auto mb-2 h-8 w-8 opacity-40" />Выберите диалог слева</div>}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
