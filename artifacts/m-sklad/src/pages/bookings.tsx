import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, ChevronRight, Plus, Settings2, Users, Crown, Bot, Phone, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney } from "@/lib/units";

export interface BookingRow {
  id: number; startsAt: string; durationMin: number; partySize: number; tableIds: number[]; status: string;
  occasion: string | null; comment: string | null; depositAmount: number | null; depositStatus: string; depositMethod: string | null;
  channel: string | null; cancelReason: string | null; createdAt: string; createdByName: string | null;
  guestId: number; guestName: string; guestPhone: string | null; guestVip: boolean; guestNotes: string | null;
}
interface TableRow { id: number; name: string; zone: string | null; seats: number; sortOrder: number; isActive: boolean }

export const STATUS: Record<string, { label: string; cls: string }> = {
  new: { label: "Новая", cls: "bg-sky-100 text-sky-900 border-sky-300" },
  confirmed: { label: "Подтверждена", cls: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  seated: { label: "В зале", cls: "bg-primary text-primary-foreground border-primary" },
  completed: { label: "Завершена", cls: "bg-muted text-muted-foreground border-border" },
  cancelled: { label: "Отменена", cls: "bg-muted text-muted-foreground border-border line-through" },
  no_show: { label: "Не пришли", cls: "bg-red-100 text-red-900 border-red-300" },
};
const DEPOSIT: Record<string, string> = { none: "без предоплаты", requested: "предоплата ожидается", paid: "предоплата получена", refunded: "предоплата возвращена" };
const METHOD: Record<string, string> = { qr: "QR", transfer: "перевод", cash: "наличные" };
const CHANNEL: Record<string, string> = { phone: "звонок", whatsapp: "WhatsApp", instagram: "Instagram", walk_in: "лично", crm: "CRM", ai: "ИИ" };
const OPEN_H = 10, CLOSE_H = 24, HOUR_PX = 88;

const errMsg = (e: unknown, f = "") => (e as { data?: { error?: string } })?.data?.error ?? f;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (s: string | Date) => new Date(s).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
export const fmtPhone = (p: string | null) => { if (!p) return ""; const m = /^996(\d{3})(\d{3})(\d{3})$/.exec(p); return m ? `+996 ${m[1]} ${m[2]} ${m[3]}` : `+${p}`; };

// ─── Booking form ────────────────────────────────────────────────────────────

function BookingDialog({ open, onOpenChange, date, editing, tables, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; date: Date; editing: BookingRow | null; tables: TableRow[]; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [f, setF] = useState({ phone: "", name: "", day: isoDay(date), time: "19:00", partySize: "2", durationMin: "120", tableIds: [] as number[], occasion: "", comment: "", deposit: "", channel: "phone" });
  const [found, setFound] = useState<{ id: number; name: string; isVip: boolean; notes: string | null } | null>(null);
  const [suggest, setSuggest] = useState<{ ids: number[]; free: number[]; configured: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!open) return;
    if (editing) {
      const d = new Date(editing.startsAt);
      setF({ phone: fmtPhone(editing.guestPhone), name: editing.guestName, day: isoDay(d), time: hhmm(d), partySize: String(editing.partySize), durationMin: String(editing.durationMin), tableIds: editing.tableIds, occasion: editing.occasion ?? "", comment: editing.comment ?? "", deposit: editing.depositAmount ? String(editing.depositAmount) : "", channel: editing.channel ?? "phone" });
      setFound({ id: editing.guestId, name: editing.guestName, isVip: editing.guestVip, notes: editing.guestNotes });
    } else {
      setF((s) => ({ ...s, phone: "", name: "", day: isoDay(date), tableIds: [], occasion: "", comment: "", deposit: "" }));
      setFound(null);
    }
  }, [open, editing, date]);

  // Guest lookup by phone as it's typed.
  useEffect(() => {
    if (!open || editing) return;
    const digits = f.phone.replace(/\D/g, "");
    if (digits.length < 9) { setFound(null); return; }
    const t = setTimeout(async () => {
      const g = await customFetch<{ id: number; name: string; isVip: boolean; notes: string | null } | null>(`/api/guests-lookup?phone=${encodeURIComponent(f.phone)}`).catch(() => null);
      setFound(g);
      if (g) setF((s) => ({ ...s, name: s.name || g.name }));
    }, 300);
    return () => clearTimeout(t);
  }, [f.phone, open, editing]);

  const startsAt = useMemo(() => new Date(`${f.day}T${f.time || "00:00"}:00`), [f.day, f.time]);
  // Free tables for the chosen slot.
  useEffect(() => {
    if (!open || Number.isNaN(startsAt.getTime())) return;
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ startsAt: startsAt.toISOString(), partySize: f.partySize || "1", durationMin: f.durationMin || "120" });
      if (editing) q.set("exceptId", String(editing.id));
      const r = await customFetch<{ free: TableRow[]; suggestion: TableRow[] | null; tablesConfigured: boolean }>(`/api/bookings/availability?${q}`).catch(() => null);
      if (r) setSuggest({ ids: r.suggestion?.map((t) => t.id) ?? [], free: r.free.map((t) => t.id), configured: r.tablesConfigured });
    }, 250);
    return () => clearTimeout(t);
  }, [open, startsAt, f.partySize, f.durationMin, editing]);

  const toggleTable = (id: number) => setF((s) => ({ ...s, tableIds: s.tableIds.includes(id) ? s.tableIds.filter((x) => x !== id) : [...s.tableIds, id] }));
  const chosen = f.tableIds.length ? f.tableIds : suggest?.ids ?? [];
  const seats = tables.filter((t) => chosen.includes(t.id)).reduce((n, t) => n + t.seats, 0);

  async function save() {
    setSaving(true);
    try {
      const body = {
        startsAt: startsAt.toISOString(), partySize: Number(f.partySize), durationMin: Number(f.durationMin),
        tableIds: f.tableIds.length ? f.tableIds : null, occasion: f.occasion, comment: f.comment, depositAmount: f.deposit || null, channel: f.channel,
      };
      if (editing) await customFetch(`/api/bookings/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...body, tableIds: f.tableIds.length ? f.tableIds : undefined }) });
      else await customFetch("/api/bookings", { method: "POST", body: JSON.stringify({ ...body, ...(found ? { guestId: found.id } : { guest: { name: f.name, phone: f.phone } }) }) });
      toast({ title: editing ? "Бронь изменена" : "Бронь создана", description: editing ? undefined : "Менеджеры получили уведомление в Telegram" });
      onOpenChange(false); onSaved();
    } catch (e) { toast({ title: "Не удалось сохранить", description: errMsg(e), variant: "destructive" }); } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? `Бронь №${editing.id}` : "Новая бронь"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label className="text-xs">Телефон</Label><Input type="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="0555 123 456" disabled={!!editing} autoFocus={!editing} /></div>
            <div className="space-y-1.5"><Label className="text-xs">Имя гостя *</Label><Input value={f.name} onChange={(e) => set("name")(e.target.value)} disabled={!!found} /></div>
          </div>
          {found && (
            <div className="rounded-lg border bg-muted/40 p-2.5 text-sm">
              <Link href={`/guests/${found.id}`} className="font-medium text-primary hover:underline">{found.name}</Link>{found.isVip && <Badge className="ml-2">VIP</Badge>}
              {!editing && <span className="ml-2 text-muted-foreground">— постоянный гость</span>}
              {found.notes && <div className="mt-1 text-xs text-muted-foreground">{found.notes}</div>}
            </div>
          )}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="space-y-1.5 col-span-2 sm:col-span-1"><Label className="text-xs">Дата</Label><Input type="date" value={f.day} onChange={(e) => set("day")(e.target.value)} /></div>
            <div className="space-y-1.5"><Label className="text-xs">Время</Label><Input type="time" step={900} value={f.time} onChange={(e) => set("time")(e.target.value)} /></div>
            <div className="space-y-1.5"><Label className="text-xs">Гостей</Label><Input type="number" min={1} value={f.partySize} onChange={(e) => set("partySize")(e.target.value)} /></div>
            <div className="space-y-1.5"><Label className="text-xs">На сколько</Label>
              <Select value={f.durationMin} onValueChange={set("durationMin")}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{[60, 90, 120, 180, 240, 300, 360].map((m) => <SelectItem key={m} value={String(m)}>{m < 120 ? `${m} мин` : `${m / 60} ч`}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {suggest?.configured !== false && (
            <div className="space-y-1.5">
              <Label className="text-xs">Столы {f.tableIds.length ? "(выбраны вручную)" : suggest?.ids.length ? "(подобраны автоматически — можно выбрать свои)" : ""}</Label>
              <div className="flex flex-wrap gap-1.5">
                {tables.filter((t) => t.isActive).map((t) => {
                  const free = suggest?.free.includes(t.id) ?? true;
                  const on = chosen.includes(t.id);
                  return (
                    <button key={t.id} type="button" disabled={!free && !f.tableIds.includes(t.id)} onClick={() => toggleTable(t.id)}
                      className={`rounded-md border px-2.5 py-1 text-sm transition-colors disabled:opacity-35 disabled:line-through ${on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                      {t.name}<span className="ml-1 text-xs opacity-70">{t.seats}</span>
                    </button>
                  );
                })}
              </div>
              {chosen.length > 0 && <p className={`text-xs ${seats < Number(f.partySize) ? "text-destructive" : "text-muted-foreground"}`}>Мест: {seats} на {f.partySize} гостей</p>}
              {suggest && !suggest.ids.length && !f.tableIds.length && <p className="text-xs text-destructive">Нет свободных столов под такую компанию на это время.</p>}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label className="text-xs">Повод</Label><Input value={f.occasion} onChange={(e) => set("occasion")(e.target.value)} placeholder="День рождения, деловая встреча…" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Предоплата, сом</Label><Input type="number" min={0} value={f.deposit} onChange={(e) => set("deposit")(e.target.value)} placeholder="без предоплаты" /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="space-y-1.5"><Label className="text-xs">Комментарий</Label><Textarea rows={2} value={f.comment} onChange={(e) => set("comment")(e.target.value)} placeholder="Торт, детский стул, у окна…" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Откуда</Label>
              <Select value={f.channel} onValueChange={set("channel")}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["phone", "whatsapp", "instagram", "walk_in", "crm"].map((c) => <SelectItem key={c} value={c}>{CHANNEL[c]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
            <Button onClick={save} disabled={saving || !f.name.trim() || !(Number(f.partySize) > 0)}>{saving ? "Сохранение…" : editing ? "Сохранить" : "Забронировать"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Booking details ─────────────────────────────────────────────────────────

function BookingCard({ b, tables, onClose, onEdit, onChanged }: { b: BookingRow | null; tables: TableRow[]; onClose: () => void; onEdit: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [method, setMethod] = useState("qr");
  if (!b) return null;
  const tnames = tables.filter((t) => b.tableIds.includes(t.id)).map((t) => t.name).join(" + ");
  async function call(path: string, body: object, ok: string) {
    try { await customFetch(`/api/bookings/${b!.id}/${path}`, { method: "POST", body: JSON.stringify(body) }); toast({ title: ok }); onChanged(); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  const st = STATUS[b.status];
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2">Бронь №{b.id} <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${st?.cls}`}>{st?.label}</span></DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Link href={`/guests/${b.guestId}`} className="text-base font-semibold text-primary hover:underline">{b.guestName}</Link>{b.guestVip && <Badge className="ml-2">VIP</Badge>}
            {b.guestPhone && <div><a className="inline-flex items-center gap-1 text-primary" href={`tel:+${b.guestPhone}`}><Phone className="h-3.5 w-3.5" />{fmtPhone(b.guestPhone)}</a></div>}
            {b.guestNotes && <div className="mt-1 rounded bg-amber-50 p-2 text-xs text-amber-900">{b.guestNotes}</div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><div className="text-xs text-muted-foreground">Когда</div>{new Date(b.startsAt).toLocaleString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · {b.durationMin / 60} ч</div>
            <div><div className="text-xs text-muted-foreground">Гостей / стол</div>{b.partySize} · {tnames || "без стола"}</div>
            {b.occasion && <div><div className="text-xs text-muted-foreground">Повод</div>{b.occasion}</div>}
            <div><div className="text-xs text-muted-foreground">Создал</div>{b.createdByName ?? "—"}{b.channel ? ` · ${CHANNEL[b.channel] ?? b.channel}` : ""}</div>
          </div>
          {b.comment && <div className="rounded bg-muted/50 p-2">{b.comment}</div>}
          {b.cancelReason && <div className="text-xs text-muted-foreground">Причина отмены: {b.cancelReason}</div>}

          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2 font-medium"><Wallet className="h-4 w-4" />{b.depositAmount ? `${fmtMoney(b.depositAmount)} — ` : ""}{DEPOSIT[b.depositStatus]}{b.depositMethod ? ` (${METHOD[b.depositMethod]})` : ""}</div>
            {b.depositStatus === "requested" && (
              <div className="flex gap-2">
                <Select value={method} onValueChange={setMethod}><SelectTrigger className="w-36 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="qr">QR</SelectItem><SelectItem value="transfer">Перевод</SelectItem><SelectItem value="cash">Наличные</SelectItem></SelectContent>
                </Select>
                <Button size="sm" onClick={() => call("deposit", { status: "paid", method }, "Предоплата отмечена")}>Предоплата получена</Button>
              </div>
            )}
            {b.depositStatus === "paid" && ["cancelled", "no_show"].includes(b.status) && <Button size="sm" variant="outline" onClick={() => call("deposit", { status: "refunded" }, "Отмечен возврат предоплаты")}>Вернули предоплату</Button>}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {b.status === "new" && <Button size="sm" onClick={() => call("status", { status: "confirmed" }, "Бронь подтверждена")}>Подтвердить</Button>}
            {["new", "confirmed"].includes(b.status) && <Button size="sm" onClick={() => call("status", { status: "seated" }, "Гости в зале")}>Гости пришли</Button>}
            {b.status === "seated" && <Button size="sm" onClick={() => call("status", { status: "completed" }, "Визит завершён")}>Завершить визит</Button>}
            {["new", "confirmed"].includes(b.status) && <Button size="sm" variant="outline" onClick={() => call("status", { status: "no_show" }, "Отмечено: не пришли")}>Не пришли</Button>}
            {["new", "confirmed"].includes(b.status) && <Button size="sm" variant="outline" onClick={onEdit}>Изменить</Button>}
            {["new", "confirmed"].includes(b.status) && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { const r = window.prompt("Причина отмены"); if (r !== null) void call("status", { status: "cancelled", reason: r }, "Бронь отменена"); }}>Отменить</Button>}
            {["cancelled", "no_show"].includes(b.status) && <Button size="sm" variant="outline" onClick={() => call("status", { status: "new" }, "Бронь восстановлена")}>Восстановить</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tables setup ────────────────────────────────────────────────────────────

function TablesDialog({ open, onOpenChange, tables, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; tables: TableRow[]; onSaved: () => void }) {
  const { toast } = useToast();
  const [n, setN] = useState({ name: "", zone: "Зал", seats: "4" });
  async function add() {
    try { await customFetch("/api/dining-tables", { method: "POST", body: JSON.stringify({ ...n, seats: Number(n.seats), sortOrder: tables.length }) }); setN((s) => ({ ...s, name: "" })); onSaved(); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  async function patch(id: number, body: object) {
    try { await customFetch(`/api/dining-tables/${id}`, { method: "PATCH", body: JSON.stringify(body) }); onSaved(); } catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Столы зала</DialogTitle></DialogHeader>
        <div className="space-y-1">
          {tables.map((t) => (
            <div key={t.id} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-sm ${t.isActive ? "" : "opacity-50"}`}>
              <span className="w-20 font-medium">{t.name}</span><span className="flex-1 text-muted-foreground">{t.zone}</span>
              <Input className="h-8 w-16" type="number" defaultValue={t.seats} onBlur={(e) => Number(e.target.value) !== t.seats && patch(t.id, { seats: Number(e.target.value) })} aria-label="Мест" />
              <span className="text-xs text-muted-foreground">мест</span>
              <Button size="sm" variant="ghost" onClick={() => patch(t.id, { isActive: !t.isActive })}>{t.isActive ? "Скрыть" : "Вернуть"}</Button>
            </div>
          ))}
          {!tables.length && <p className="text-sm text-muted-foreground">Добавьте столы — система будет сама подбирать свободные под размер компании.</p>}
        </div>
        <div className="flex gap-2 pt-2">
          <Input placeholder="Номер" className="w-24" value={n.name} onChange={(e) => setN((s) => ({ ...s, name: e.target.value }))} />
          <Input placeholder="Зона" value={n.zone} onChange={(e) => setN((s) => ({ ...s, zone: e.target.value }))} />
          <Input type="number" className="w-20" value={n.seats} onChange={(e) => setN((s) => ({ ...s, seats: e.target.value }))} aria-label="Мест" />
          <Button onClick={add} disabled={!n.name.trim()}><Plus className="h-4 w-4" /></Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Bookings() {
  const { user, isLoading: roleLoading } = useCurrentUser();
  const qc = useQueryClient();
  const [day, setDay] = useState(dayStart(new Date()));
  const [view, setView] = useState<"timeline" | "list">("timeline");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BookingRow | null>(null);
  const [opened, setOpened] = useState<BookingRow | null>(null);
  const [tablesOpen, setTablesOpen] = useState(false);

  const next = new Date(day.getTime() + 24 * 3600 * 1000);
  const bookingsKey = ["/api/bookings", isoDay(day)];
  const { data: bookings } = useQuery<BookingRow[]>({ queryKey: bookingsKey, queryFn: () => customFetch(`/api/bookings?from=${day.toISOString()}&to=${next.toISOString()}`), refetchInterval: 30_000 });
  const { data: tables } = useQuery<TableRow[]>({ queryKey: ["/api/dining-tables"], queryFn: () => customFetch("/api/dining-tables") });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["/api/bookings"] }); void qc.invalidateQueries({ queryKey: ["/api/dining-tables"] }); };
  useEffect(() => { if (opened && bookings) setOpened(bookings.find((b) => b.id === opened.id) ?? null); }, [bookings]); // eslint-disable-line react-hooks/exhaustive-deps

  if (roleLoading) return null;
  if (!user || !["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"].includes(user.role)) return <AccessDenied />;

  const activeTables = (tables ?? []).filter((t) => t.isActive);
  const list = bookings ?? [];
  const live = list.filter((b) => !["cancelled", "no_show"].includes(b.status));
  const guestsToday = live.reduce((n, b) => n + b.partySize, 0);
  const unseated = list.filter((b) => !b.tableIds.length && !["cancelled", "no_show"].includes(b.status));
  const isToday = isoDay(day) === isoDay(new Date());
  const nowX = ((Date.now() - day.getTime()) / 3600000 - OPEN_H) * HOUR_PX;

  const block = (b: BookingRow) => {
    const start = new Date(b.startsAt);
    const left = ((start.getTime() - day.getTime()) / 3600000 - OPEN_H) * HOUR_PX;
    const st = STATUS[b.status];
    return (
      <button key={b.id} type="button" onClick={() => setOpened(b)} title={`${b.guestName}, ${b.partySize} чел.`}
        className={`absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 text-left text-xs leading-tight shadow-sm hover:z-10 hover:ring-2 hover:ring-primary/40 ${st?.cls}`}
        style={{ left: Math.max(left, 0), width: Math.max((b.durationMin / 60) * HOUR_PX - 4, 40) }}>
        <div className="flex items-center gap-1 font-semibold truncate">{b.guestVip && <Crown className="h-3 w-3 shrink-0" />}{b.createdByName === "ИИ-агент" && <Bot className="h-3 w-3 shrink-0" />}{b.guestName}</div>
        <div className="truncate opacity-80">{hhmm(start)} · {b.partySize} чел.{b.depositStatus === "requested" ? " · 💳?" : b.depositStatus === "paid" ? " · 💳✓" : ""}</div>
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Брони</h1>
          <p className="text-muted-foreground">Календарь столов, предоплаты и статусы визитов. Новые брони приходят менеджерам в Telegram.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setTablesOpen(true)}><Settings2 className="mr-2 h-4 w-4" />Столы</Button>
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="mr-2 h-4 w-4" />Новая бронь</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => setDay(new Date(day.getTime() - 24 * 3600 * 1000))} aria-label="Предыдущий день"><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" className="w-40" value={isoDay(day)} onChange={(e) => e.target.value && setDay(dayStart(new Date(`${e.target.value}T00:00:00`)))} />
          <Button variant="outline" size="icon" onClick={() => setDay(next)} aria-label="Следующий день"><ChevronRight className="h-4 w-4" /></Button>
          {!isToday && <Button variant="ghost" onClick={() => setDay(dayStart(new Date()))}>Сегодня</Button>}
        </div>
        <span className="text-sm font-medium capitalize">{day.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</span>
        <span className="flex items-center gap-1 text-sm text-muted-foreground"><Users className="h-4 w-4" />{live.length} броней · {guestsToday} гостей</span>
        <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="ml-auto"><TabsList><TabsTrigger value="timeline">По столам</TabsTrigger><TabsTrigger value="list">Списком</TabsTrigger></TabsList></Tabs>
      </div>

      {view === "timeline" ? (
        <Card><CardContent className="p-0 overflow-x-auto">
          <div style={{ minWidth: 112 + (CLOSE_H - OPEN_H) * HOUR_PX }}>
            <div className="flex border-b text-xs text-muted-foreground">
              <div className="w-28 shrink-0 px-3 py-2">Стол</div>
              <div className="relative flex">{Array.from({ length: CLOSE_H - OPEN_H }, (_, i) => <div key={i} style={{ width: HOUR_PX }} className="border-l px-1 py-2">{String(OPEN_H + i).padStart(2, "0")}:00</div>)}</div>
            </div>
            {[...activeTables.map((t) => ({ key: `t${t.id}`, label: t.name, sub: `${t.zone ?? ""} · ${t.seats}`, items: list.filter((b) => b.tableIds.includes(t.id)) })),
              ...(unseated.length || !activeTables.length ? [{ key: "none", label: "Без стола", sub: "", items: unseated }] : [])].map((row) => (
              <div key={row.key} className="flex border-b last:border-b-0">
                <div className="w-28 shrink-0 px-3 py-2"><div className="font-medium text-sm">{row.label}</div><div className="text-[11px] text-muted-foreground">{row.sub}</div></div>
                <div className="relative h-14" style={{ width: (CLOSE_H - OPEN_H) * HOUR_PX }}>
                  {Array.from({ length: CLOSE_H - OPEN_H }, (_, i) => <div key={i} className="absolute top-0 bottom-0 border-l border-dashed border-border/60" style={{ left: i * HOUR_PX }} />)}
                  {isToday && nowX > 0 && nowX < (CLOSE_H - OPEN_H) * HOUR_PX && <div className="absolute top-0 bottom-0 w-0.5 bg-primary/70" style={{ left: nowX }} />}
                  {row.items.map(block)}
                </div>
              </div>
            ))}
          </div>
        </CardContent></Card>
      ) : (
        <Card><CardContent className="p-0 divide-y">
          {!list.length && <div className="py-12 text-center text-muted-foreground">На этот день броней нет.</div>}
          {list.map((b) => (
            <button key={b.id} type="button" onClick={() => setOpened(b)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40">
              <div className="w-14 text-lg font-semibold tabular-nums">{hhmm(b.startsAt)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{b.guestVip && <Crown className="inline mr-1 h-3.5 w-3.5 text-amber-500" />}{b.guestName} · {b.partySize} чел.</div>
                <div className="text-xs text-muted-foreground truncate">{[activeTables.filter((t) => b.tableIds.includes(t.id)).map((t) => t.name).join(" + ") || "без стола", b.occasion, b.depositAmount ? `${fmtMoney(b.depositAmount)} — ${DEPOSIT[b.depositStatus]}` : null, b.createdByName].filter(Boolean).join(" · ")}</div>
              </div>
              <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS[b.status]?.cls}`}>{STATUS[b.status]?.label}</span>
            </button>
          ))}
        </CardContent></Card>
      )}

      <BookingDialog open={formOpen} onOpenChange={setFormOpen} date={day} editing={editing} tables={tables ?? []} onSaved={refresh} />
      <BookingCard b={opened} tables={tables ?? []} onClose={() => setOpened(null)} onEdit={() => { setEditing(opened); setOpened(null); setFormOpen(true); }} onChanged={refresh} />
      <TablesDialog open={tablesOpen} onOpenChange={setTablesOpen} tables={tables ?? []} onSaved={refresh} />
    </div>
  );
}
