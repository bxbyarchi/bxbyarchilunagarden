import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Search, ArrowLeft, Pencil, Crown, Ban, Phone, Instagram, Cake } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney } from "@/lib/units";
import { STATUS, fmtPhone } from "./bookings";

interface GuestRow { id: number; name: string; phone: string | null; instagram: string | null; tags: string[]; isVip: boolean; isBlacklisted: boolean; source: string | null; birthday: string | null; visits: number; noShows: number; lastVisit: string | null; nextBooking: string | null }
interface GuestDetail extends GuestRow {
  whatsapp: string | null; telegram: string | null; email: string | null; notes: string | null; createdAt: string;
  stats: { visits: number; noShows: number; cancelled: number; depositsPaid: number };
  bookings: { id: number; startsAt: string; partySize: number; status: string; occasion: string | null; depositAmount: string | null; depositStatus: string; channel: string | null }[];
}
const FOH = ["super_admin", "location_admin", "manager", "cashier", "warehouse_chief"];
const errMsg = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;
const fmtDay = (s: string | null) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");

function useDebounced<T>(v: T, ms = 250) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }

function GuestDialog({ open, onOpenChange, guest, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; guest?: GuestDetail | null; onSaved: (id: number) => void }) {
  const { toast } = useToast();
  const empty = { name: "", phone: "", whatsapp: "", instagram: "", telegram: "", email: "", birthday: "", tags: "", notes: "", isVip: false, isBlacklisted: false };
  const [f, setF] = useState(empty);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF(guest ? { name: guest.name, phone: fmtPhone(guest.phone), whatsapp: guest.whatsapp ?? "", instagram: guest.instagram ?? "", telegram: guest.telegram ?? "", email: guest.email ?? "", birthday: guest.birthday ?? "", tags: guest.tags.join(", "), notes: guest.notes ?? "", isVip: guest.isVip, isBlacklisted: guest.isBlacklisted } : empty);
  }, [open, guest]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function save() {
    setSaving(true);
    try {
      const body = { ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), birthday: f.birthday || null };
      const g = await customFetch<{ id: number }>(guest ? `/api/guests/${guest.id}` : "/api/guests", { method: guest ? "PATCH" : "POST", body: JSON.stringify(body) });
      onOpenChange(false); onSaved(g.id);
    } catch (e) { toast({ title: "Не удалось сохранить", description: errMsg(e), variant: "destructive" }); } finally { setSaving(false); }
  }
  const field = (k: keyof typeof empty, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1.5"><Label className="text-xs">{label}</Label><Input value={f[k] as string} onChange={set(k)} {...props} /></div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{guest ? "Карточка гостя" : "Новый гость"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {field("name", "Имя *", { autoFocus: true })}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("phone", "Телефон", { type: "tel", placeholder: "0555 123 456" })}
            {field("whatsapp", "WhatsApp (если другой)", { type: "tel" })}
            {field("instagram", "Instagram", { placeholder: "@username" })}
            {field("telegram", "Telegram")}
            {field("email", "Email", { type: "email" })}
            {field("birthday", "День рождения", { type: "date" })}
          </div>
          {field("tags", "Метки через запятую", { placeholder: "постоянный, банкет, вегетарианец" })}
          <div className="space-y-1.5"><Label className="text-xs">Заметки (видны при брони)</Label><Textarea rows={3} value={f.notes} onChange={set("notes")} placeholder="Аллергия на орехи, любит стол у окна…" /></div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.isVip} onChange={(e) => setF((s) => ({ ...s, isVip: e.target.checked }))} />VIP</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.isBlacklisted} onChange={(e) => setF((s) => ({ ...s, isBlacklisted: e.target.checked }))} />Чёрный список</label>
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button><Button onClick={save} disabled={saving || !f.name.trim()}>{saving ? "Сохранение…" : "Сохранить"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Guests() {
  const { user, isLoading } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [vip, setVip] = useState(false);
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q);
  const params = new URLSearchParams(); if (dq.trim()) params.set("q", dq.trim()); if (vip) params.set("vip", "1");
  const { data: rows, isLoading: loading } = useQuery<GuestRow[]>({ queryKey: ["/api/guests", dq, vip], queryFn: () => customFetch(`/api/guests?${params}`) });
  if (isLoading) return null;
  if (!user || !FOH.includes(user.role)) return <AccessDenied />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight">Гости</h1><p className="text-muted-foreground">Клиентская база: контакты, визиты, брони, предоплаты и заметки о предпочтениях.</p></div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Новый гость</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-80"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="Имя, телефон, Instagram, заметки…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} />Только VIP</label>
      </div>
      <Card><CardContent className="p-0">
        {loading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !rows?.length ? <div className="py-12 text-center text-muted-foreground">{q ? "Никого не нашли." : "Гостей пока нет — они появятся с первыми бронями."}</div> : (
          <div className="table-scroll-mobile"><Table>
            <TableHeader><TableRow><TableHead>Гость</TableHead><TableHead>Контакты</TableHead><TableHead className="text-right">Визитов</TableHead><TableHead className="text-right">Последний визит</TableHead><TableHead className="text-right">Ближайшая бронь</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((g) => (
              <TableRow key={g.id} className="cursor-pointer" onClick={() => setLocation(`/guests/${g.id}`)}>
                <TableCell><div className="flex items-center gap-1.5 font-medium">{g.isVip && <Crown className="h-4 w-4 text-amber-500" />}{g.isBlacklisted && <Ban className="h-4 w-4 text-destructive" />}{g.name}</div>
                  {g.tags.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{g.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">{t}</span>)}</div>}</TableCell>
                <TableCell className="text-sm">{fmtPhone(g.phone)}{g.instagram && <div className="text-muted-foreground">{g.instagram}</div>}</TableCell>
                <TableCell className="text-right">{g.visits}{g.noShows > 0 && <div className="text-xs text-destructive">не пришёл: {g.noShows}</div>}</TableCell>
                <TableCell className="text-right">{fmtDay(g.lastVisit)}</TableCell>
                <TableCell className="text-right">{g.nextBooking ? new Date(g.nextBooking).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></div>
        )}
      </CardContent></Card>
      <GuestDialog open={open} onOpenChange={setOpen} onSaved={(id) => setLocation(`/guests/${id}`)} />
    </div>
  );
}

export function GuestCard() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading } = useCurrentUser();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const key = ["/api/guests", "detail", id];
  const { data: g, error } = useQuery<GuestDetail>({ queryKey: key, queryFn: () => customFetch(`/api/guests/${id}`) });
  if (isLoading) return null;
  if (!user || !FOH.includes(user.role)) return <AccessDenied />;
  if (error) return <div className="py-12 text-center text-muted-foreground">{errMsg(error) ?? "Гость не найден"}</div>;
  if (!g) return <div className="py-12 text-center text-muted-foreground">Загрузка…</div>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => setLocation("/guests")}><ArrowLeft className="mr-2 h-4 w-4" />Все гости</Button>
        <Button variant="outline" onClick={() => setEdit(true)}><Pencil className="mr-2 h-4 w-4" />Редактировать</Button>
      </div>
      <div>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">{g.name}{g.isVip && <Badge><Crown className="mr-1 h-3 w-3" />VIP</Badge>}{g.isBlacklisted && <Badge variant="destructive">чёрный список</Badge>}</h1>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          {g.phone && <a href={`tel:+${g.phone}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 hover:bg-muted"><Phone className="h-4 w-4 text-primary" />{fmtPhone(g.phone)}</a>}
          {(g.whatsapp || g.phone) && <a href={`https://wa.me/${(g.whatsapp || g.phone)!.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 hover:bg-muted">WhatsApp</a>}
          {g.instagram && <a href={`https://instagram.com/${g.instagram.replace(/^@/, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 hover:bg-muted"><Instagram className="h-4 w-4 text-primary" />{g.instagram}</a>}
          {g.birthday && <span className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5"><Cake className="h-4 w-4 text-primary" />{new Date(`${g.birthday}T00:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</span>}
        </div>
        {g.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{g.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}</div>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Визитов</div><div className="mt-1 text-xl font-semibold">{g.stats.visits}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Не пришёл</div><div className={`mt-1 text-xl font-semibold ${g.stats.noShows ? "text-destructive" : ""}`}>{g.stats.noShows}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Отменял</div><div className="mt-1 text-xl font-semibold">{g.stats.cancelled}</div></div>
        <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Внёс предоплат</div><div className="mt-1 text-xl font-semibold">{fmtMoney(g.stats.depositsPaid)}</div></div>
      </div>
      {g.notes && <Card><CardHeader className="pb-2"><CardTitle className="text-base">Заметки</CardTitle></CardHeader><CardContent className="whitespace-pre-wrap text-sm">{g.notes}</CardContent></Card>}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Брони</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!g.bookings.length ? <div className="py-8 text-center text-muted-foreground">Броней пока нет.</div> : (
            <Table><TableHeader><TableRow><TableHead>Когда</TableHead><TableHead className="text-right">Гостей</TableHead><TableHead>Повод</TableHead><TableHead>Предоплата</TableHead><TableHead>Статус</TableHead></TableRow></TableHeader>
              <TableBody>{g.bookings.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{new Date(b.startsAt).toLocaleString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell className="text-right">{b.partySize}</TableCell>
                  <TableCell>{b.occasion ?? "—"}</TableCell>
                  <TableCell>{b.depositAmount ? `${fmtMoney(Number(b.depositAmount))} · ${b.depositStatus === "paid" ? "получена" : b.depositStatus === "refunded" ? "возвращена" : "ожидается"}` : "—"}</TableCell>
                  <TableCell><span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS[b.status]?.cls}`}>{STATUS[b.status]?.label}</span></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <GuestDialog open={edit} onOpenChange={setEdit} guest={g} onSaved={() => qc.invalidateQueries({ queryKey: ["/api/guests"] })} />
    </div>
  );
}
