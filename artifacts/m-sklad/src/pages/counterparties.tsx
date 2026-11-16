import { useEffect, useMemo, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Search, Phone, Send, Mail, ArrowLeft, Pencil, Archive, Star, Building2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { fmtMoney, fmtQty } from "@/lib/units";

export const ROLE_LABEL: Record<string, string> = { supplier: "Поставщик", client: "Клиент", service: "Услуги", specialist: "Специалист" };
const ROLE_TABS = [["all", "Все"], ["supplier", "Поставщики"], ["client", "Клиенты"], ["service", "Услуги"], ["specialist", "Специалисты"]] as const;

interface CpRow {
  id: number; kind: "company" | "person"; roles: string[]; name: string; category: string | null; contactPerson: string | null;
  phone: string | null; telegram: string | null; rating: number | null; isActive: boolean;
  receiptsCount: number; receiptsTotal: number; lastReceiptAt: string | null;
}
interface CpDetail extends CpRow {
  phone2: string | null; email: string | null; address: string | null; taxId: string | null; bankDetails: string | null;
  paymentTerms: string | null; notes: string | null; createdAt: string;
  stats: { receiptsCount: number; receiptsTotal: number; firstReceiptAt: string | null; lastReceiptAt: string | null };
  items: { itemId: number; name: string | null; unit: string | null; qty: number; total: number; lastPrice: number; lastAt: string }[];
  recentReceipts: { id: number; itemName: string | null; unit: string | null; quantity: number; pricePerUnit: number; totalCost: number; createdAt: string }[];
}

const errMsg = (e: unknown, f: string) => (e as { data?: { error?: string } })?.data?.error ?? f;
const fmtDay = (s: string | null) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, "")}`;
const tgHref = (t: string) => `https://t.me/${t.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "")}`;

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function Stars({ value }: { value: number | null }) {
  if (!value) return null;
  return <span className="inline-flex items-center gap-0.5 text-amber-500" aria-label={`Оценка ${value} из 5`}>{Array.from({ length: value }, (_, i) => <Star key={i} className="h-3 w-3 fill-current" />)}</span>;
}

// ─── Form ────────────────────────────────────────────────────────────────────

const emptyForm = { kind: "company", roles: ["supplier"] as string[], name: "", category: "", contactPerson: "", phone: "", phone2: "", email: "", telegram: "", address: "", taxId: "", bankDetails: "", paymentTerms: "", rating: "", notes: "" };
type FormState = typeof emptyForm;

export function CounterpartyDialog({ open, onOpenChange, initial, defaultRole, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void; initial?: Partial<CpDetail> | null; defaultRole?: string; onSaved?: (row: { id: number; name: string }) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const { data: categories } = useQuery<{ category: string; count: number }[]>({ queryKey: ["/api/counterparties/categories"], queryFn: () => customFetch("/api/counterparties/categories"), enabled: open });

  useEffect(() => {
    if (!open) return;
    if (initial?.id) {
      const s = (v: string | null | undefined) => v ?? "";
      setF({ kind: initial.kind ?? "company", roles: initial.roles ?? [], name: s(initial.name), category: s(initial.category), contactPerson: s(initial.contactPerson), phone: s(initial.phone), phone2: s(initial.phone2), email: s(initial.email), telegram: s(initial.telegram), address: s(initial.address), taxId: s(initial.taxId), bankDetails: s(initial.bankDetails), paymentTerms: s(initial.paymentTerms), rating: initial.rating ? String(initial.rating) : "", notes: s(initial.notes) });
    } else setF({ ...emptyForm, name: initial?.name ?? "", roles: [defaultRole && defaultRole !== "all" ? defaultRole : "supplier"] });
  }, [open, initial, defaultRole]);

  const set = (k: keyof FormState) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const toggleRole = (r: string) => setF((s) => ({ ...s, roles: s.roles.includes(r) ? s.roles.filter((x) => x !== r) : [...s.roles, r] }));

  async function save() {
    setSaving(true);
    try {
      const body = { ...f, rating: f.rating ? Number(f.rating) : null };
      const row = await customFetch<{ id: number; name: string }>(initial?.id ? `/api/counterparties/${initial.id}` : "/api/counterparties", { method: initial?.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: ["/api/counterparties"] });
      toast({ title: initial?.id ? "Сохранено" : "Контрагент добавлен" });
      onOpenChange(false);
      onSaved?.(row);
    } catch (e) { toast({ title: "Не удалось сохранить", description: errMsg(e, ""), variant: "destructive" }); } finally { setSaving(false); }
  }

  const field = (k: keyof FormState, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1.5"><Label className="text-xs">{label}</Label><Input value={f[k] as string} onChange={(e) => set(k)(e.target.value)} {...props} /></div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initial?.id ? "Редактирование контрагента" : "Новый контрагент"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(ROLE_LABEL).map(([r, label]) => (
              <button key={r} type="button" onClick={() => toggleRole(r)} aria-pressed={f.roles.includes(r)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${f.roles.includes(r) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{label}</button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5"><Label className="text-xs">Тип</Label>
              <Select value={f.kind} onValueChange={set("kind")}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="company">Компания</SelectItem><SelectItem value="person">Человек</SelectItem></SelectContent>
              </Select>
            </div>
            {field("name", f.kind === "person" ? "Имя и фамилия *" : "Название *", { placeholder: f.kind === "person" ? "Азамат Токтогулов" : "ОсОО «Мясной двор»", autoFocus: true })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label className="text-xs">Категория</Label>
              <Input list="cp-categories" value={f.category} onChange={(e) => set("category")(e.target.value)} placeholder="Мясо, Овощи, Электрик, Химчистка…" />
              <datalist id="cp-categories">{categories?.map((c) => <option key={c.category} value={c.category} />)}</datalist>
            </div>
            {f.kind === "company" ? field("contactPerson", "Контактное лицо") : field("paymentTerms", "Условия оплаты", { placeholder: "почасовая, за выезд…" })}
            {field("phone", "Телефон", { type: "tel", placeholder: "+996 555 123 456" })}
            {field("phone2", "Доп. телефон", { type: "tel" })}
            {field("telegram", "Telegram", { placeholder: "@username" })}
            {field("email", "Email", { type: "email" })}
          </div>
          {field("address", "Адрес")}
          {f.kind === "company" && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field("taxId", "ИНН")}
              {field("paymentTerms", "Условия оплаты", { placeholder: "предоплата, отсрочка 7 дней…" })}
            </div>
          )}
          {f.kind === "company" && <div className="space-y-1.5"><Label className="text-xs">Банковские реквизиты</Label><Textarea rows={2} value={f.bankDetails} onChange={(e) => set("bankDetails")(e.target.value)} /></div>}
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5"><Label className="text-xs">Оценка</Label>
              <Select value={f.rating || "none"} onValueChange={(v) => set("rating")(v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Без оценки</SelectItem>{[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}>{"★".repeat(n)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Заметки</Label><Textarea rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Качество, сроки доставки, договорённости…" /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
            <Button onClick={save} disabled={saving || !f.name.trim() || !f.roles.length}>{saving ? "Сохранение…" : "Сохранить"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

export default function Counterparties() {
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const [, setLocation] = useLocation();
  const [role, setRole] = useState("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const dq = useDebounced(q);

  const params = new URLSearchParams();
  if (role !== "all") params.set("role", role);
  if (category !== "all") params.set("category", category);
  if (dq.trim()) params.set("q", dq.trim());
  if (archived) params.set("includeInactive", "1");
  const { data: rows, isLoading } = useQuery<CpRow[]>({ queryKey: ["/api/counterparties", role, category, dq, archived], queryFn: () => customFetch<CpRow[]>(`/api/counterparties?${params}`) });
  const { data: categories } = useQuery<{ category: string; count: number }[]>({ queryKey: ["/api/counterparties/categories"], queryFn: () => customFetch("/api/counterparties/categories") });

  if (roleLoading) return null;
  if (!canDo("warehouse")) return <AccessDenied />;
  const canEdit = canDo("manager");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Контрагенты</h1>
          <p className="text-muted-foreground">Поставщики, клиенты, подрядчики и специалисты — с контактами, категориями и историей поставок.</p>
        </div>
        {canEdit && <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Добавить</Button>}
      </div>

      <Tabs value={role} onValueChange={setRole}>
        <TabsList className="flex-wrap h-auto">{ROLE_TABS.map(([v, l]) => <TabsTrigger key={v} value={v}>{l}</TabsTrigger>)}</TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Название, телефон, ИНН, заметки…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все категории</SelectItem>
            {categories?.map((c) => <SelectItem key={c.category} value={c.category}>{c.category} ({c.count})</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Показать архив</label>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !rows?.length ? (
            <div className="py-12 text-center text-muted-foreground">{q || category !== "all" || role !== "all" ? "Ничего не найдено." : "Справочник пока пуст."}</div>
          ) : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Контрагент</TableHead><TableHead>Категория</TableHead><TableHead>Контакты</TableHead>
                  <TableHead className="text-right">Поставки</TableHead><TableHead className="text-right">Последняя</TableHead>
                </TableRow></TableHeader>
                <TableBody>{rows.map((r) => (
                  <TableRow key={r.id} className={`cursor-pointer ${r.isActive ? "" : "opacity-50"}`} onClick={() => setLocation(`/counterparties/${r.id}`)}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        {r.kind === "person" ? <User className="h-4 w-4 text-muted-foreground" /> : <Building2 className="h-4 w-4 text-muted-foreground" />}
                        {r.name}<Stars value={r.rating} />{!r.isActive && <Badge variant="outline">архив</Badge>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">{r.roles.map((x) => <span key={x} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{ROLE_LABEL[x] ?? x}</span>)}</div>
                    </TableCell>
                    <TableCell>{r.category ?? "—"}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="text-sm">{r.contactPerson}</div>
                      <div className="flex flex-wrap gap-x-3 text-sm">
                        {r.phone && <a className="text-primary hover:underline whitespace-nowrap" href={telHref(r.phone)}>{r.phone}</a>}
                        {r.telegram && <a className="text-primary hover:underline" href={tgHref(r.telegram)} target="_blank" rel="noreferrer">{r.telegram}</a>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">{r.receiptsCount ? <><div>{fmtMoney(r.receiptsTotal)}</div><div className="text-xs text-muted-foreground">{r.receiptsCount} поступл.</div></> : "—"}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{fmtDay(r.lastReceiptAt)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <CounterpartyDialog open={createOpen} onOpenChange={setCreateOpen} defaultRole={role} onSaved={(row) => setLocation(`/counterparties/${row.id}`)} />
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function CounterpartyCard() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const key = ["/api/counterparties", "detail", id];
  const { data: cp, isLoading, error } = useQuery<CpDetail>({ queryKey: key, queryFn: () => customFetch<CpDetail>(`/api/counterparties/${id}`) });
  const contacts = useMemo(() => {
    if (!cp) return [];
    const out: { icon: typeof Phone; label: string; href?: string }[] = [];
    if (cp.phone) out.push({ icon: Phone, label: cp.phone, href: telHref(cp.phone) });
    if (cp.phone2) out.push({ icon: Phone, label: cp.phone2, href: telHref(cp.phone2) });
    if (cp.telegram) out.push({ icon: Send, label: cp.telegram, href: tgHref(cp.telegram) });
    if (cp.email) out.push({ icon: Mail, label: cp.email, href: `mailto:${cp.email}` });
    return out;
  }, [cp]);

  if (roleLoading || isLoading) return <div className="py-12 text-center text-muted-foreground">Загрузка…</div>;
  if (!canDo("warehouse")) return <AccessDenied />;
  if (error || !cp) return <div className="py-12 text-center text-muted-foreground">{errMsg(error, "Контрагент не найден")}</div>;
  const canEdit = canDo("manager");

  async function archive() {
    if (!window.confirm(cp!.stats.receiptsCount ? "У контрагента есть поступления — он будет перенесён в архив. Продолжить?" : "Удалить контрагента?")) return;
    try {
      await customFetch(`/api/counterparties/${cp!.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["/api/counterparties"] });
      setLocation("/counterparties");
    } catch (e) { toast({ title: "Ошибка", description: errMsg(e, ""), variant: "destructive" }); }
  }
  async function restore() {
    await customFetch(`/api/counterparties/${cp!.id}`, { method: "PATCH", body: JSON.stringify({ isActive: true }) }).catch((e) => toast({ title: "Ошибка", description: errMsg(e, ""), variant: "destructive" }));
    await qc.invalidateQueries({ queryKey: ["/api/counterparties"] });
  }

  const info: Array<[string, string | null]> = [
    ["Контактное лицо", cp.contactPerson], ["Адрес", cp.address], ["ИНН", cp.taxId], ["Условия оплаты", cp.paymentTerms], ["Реквизиты", cp.bankDetails],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => setLocation("/counterparties")}><ArrowLeft className="mr-2 h-4 w-4" />Все контрагенты</Button>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditOpen(true)}><Pencil className="mr-2 h-4 w-4" />Редактировать</Button>
            {cp.isActive ? <Button variant="ghost" className="text-destructive" onClick={archive}><Archive className="mr-2 h-4 w-4" />{cp.stats.receiptsCount ? "В архив" : "Удалить"}</Button>
              : <Button variant="outline" onClick={restore}>Вернуть из архива</Button>}
          </div>
        )}
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{cp.name}</h1><Stars value={cp.rating} />{!cp.isActive && <Badge variant="outline">архив</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5 text-sm text-muted-foreground">
          <span>{cp.kind === "person" ? "Человек" : "Компания"}</span>
          {cp.category && <span>· {cp.category}</span>}
          {cp.roles.map((r) => <Badge key={r} variant="secondary">{ROLE_LABEL[r] ?? r}</Badge>)}
        </div>
        {contacts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">{contacts.map((c) => (
            <a key={c.label} href={c.href} target={c.href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-sm hover:bg-muted"><c.icon className="h-4 w-4 text-primary" />{c.label}</a>
          ))}</div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2"><CardTitle className="text-base">Сведения</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {info.filter(([, v]) => v).map(([k, v]) => <div key={k}><div className="text-xs text-muted-foreground">{k}</div><div className="whitespace-pre-wrap">{v}</div></div>)}
            {cp.notes && <div><div className="text-xs text-muted-foreground">Заметки</div><div className="whitespace-pre-wrap">{cp.notes}</div></div>}
            {!info.some(([, v]) => v) && !cp.notes && <div className="text-muted-foreground">Дополнительных сведений нет.</div>}
          </CardContent>
        </Card>
        <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
          <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Поставлено на сумму</div><div className="mt-1 text-xl font-semibold">{fmtMoney(cp.stats.receiptsTotal)}</div><div className="text-xs text-muted-foreground">{cp.stats.receiptsCount} поступлений</div></div>
          <div className="rounded-xl border bg-card p-4"><div className="text-xs text-muted-foreground">Работаем</div><div className="mt-1 text-xl font-semibold">{cp.stats.firstReceiptAt ? `с ${fmtDay(cp.stats.firstReceiptAt)}` : "—"}</div><div className="text-xs text-muted-foreground">последняя поставка {fmtDay(cp.stats.lastReceiptAt)}</div></div>
        </div>
      </div>

      {cp.items.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Что поставляет</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Позиция</TableHead><TableHead className="text-right">Всего</TableHead><TableHead className="text-right">Сумма</TableHead><TableHead className="text-right">Последняя цена</TableHead><TableHead className="text-right">Когда</TableHead></TableRow></TableHeader>
              <TableBody>{cp.items.map((i) => (
                <TableRow key={i.itemId}><TableCell className="font-medium">{i.name}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtQty(i.qty)} {i.unit}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(i.total)}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(i.lastPrice)}/{i.unit}</TableCell><TableCell className="text-right">{fmtDay(i.lastAt)}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {cp.recentReceipts.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Последние поступления</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Дата</TableHead><TableHead>Позиция</TableHead><TableHead className="text-right">Кол-во</TableHead><TableHead className="text-right">Цена</TableHead><TableHead className="text-right">Сумма</TableHead></TableRow></TableHeader>
              <TableBody>{cp.recentReceipts.map((r) => (
                <TableRow key={r.id}><TableCell>{fmtDay(r.createdAt)}</TableCell><TableCell>{r.itemName}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtQty(r.quantity)} {r.unit}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(r.pricePerUnit)}</TableCell><TableCell className="text-right whitespace-nowrap">{fmtMoney(r.totalCost)}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CounterpartyDialog open={editOpen} onOpenChange={setEditOpen} initial={cp} onSaved={() => qc.invalidateQueries({ queryKey: key })} />
    </div>
  );
}
