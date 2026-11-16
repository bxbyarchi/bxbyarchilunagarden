import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, useListLocations } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit, KeyRound, Search, CircleDot } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { ROLE_LABELS } from "@/lib/roles";
import { DEPARTMENTS, PERSONNEL_ADMIN, PERSONNEL_VIEW, errMsg, fmtTime } from "@/lib/personnel";

export interface StaffRow {
  id: number; name: string; position: string | null; phone: string | null; isActive: boolean; locationId: number | null; locationName: string | null;
  department: string | null; userClerkId: string | null; hourlyRate: number | null; shiftRate: number | null; hasPin: boolean;
  hireDate: string | null; notes: string | null; photoConsentAt: string | null; accountName: string | null; accountLogin: string | null; openSince: string | null;
}
interface Account { clerkUserId: string; login: string; firstName: string | null; lastName: string | null; role: string }
type Form = { name: string; position: string; department: string; phone: string; locationId: string; userClerkId: string; hourlyRate: string; shiftRate: string; pin: string; hireDate: string; notes: string; isActive: boolean; photoConsent: boolean };

const empty: Form = { name: "", position: "", department: "", phone: "", locationId: "", userClerkId: "", hourlyRate: "", shiftRate: "", pin: "", hireDate: "", notes: "", isActive: true, photoConsent: false };

export default function Staff() {
  const { user, isLoading: userLoading } = useCurrentUser();
  const isAdmin = PERSONNEL_ADMIN.includes(user?.role ?? "");
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: staff, isLoading } = useQuery<StaffRow[]>({ queryKey: ["/api/personnel/staff"], queryFn: () => customFetch("/api/personnel/staff"), enabled: !!user });
  const { data: accounts } = useQuery<Account[]>({ queryKey: ["/api/personnel/accounts"], queryFn: () => customFetch("/api/personnel/accounts"), enabled: isAdmin });
  const { data: locations } = useListLocations();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<StaffRow | "new" | null>(null);
  const [f, setF] = useState<Form>(empty);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => (staff ?? []).filter((s) => (showInactive || s.isActive) && (dept === "all" || s.department === dept)
    && (!q || `${s.name} ${s.position ?? ""} ${s.phone ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [staff, q, dept, showInactive]);
  const onShift = (staff ?? []).filter((s) => s.openSince).length;

  if (userLoading) return null;
  if (!PERSONNEL_VIEW.includes(user?.role ?? "")) return <AccessDenied />;

  function open(s: StaffRow | "new") {
    setEditing(s);
    setF(s === "new" ? empty : {
      name: s.name, position: s.position ?? "", department: s.department ?? "", phone: s.phone ?? "", locationId: s.locationId ? String(s.locationId) : "",
      userClerkId: s.userClerkId ?? "", hourlyRate: s.hourlyRate == null ? "" : String(s.hourlyRate), shiftRate: s.shiftRate == null ? "" : String(s.shiftRate),
      pin: "", hireDate: s.hireDate ?? "", notes: s.notes ?? "", isActive: s.isActive, photoConsent: !!s.photoConsentAt,
    });
  }
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { ...f, locationId: f.locationId || null, userClerkId: f.userClerkId || null, department: f.department || null, hireDate: f.hireDate || null };
    if (!f.pin) delete body.pin;
    try {
      if (editing === "new") await customFetch("/api/personnel/staff", { method: "POST", body: JSON.stringify(body) });
      else if (editing) await customFetch(`/api/personnel/staff/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: ["/api/personnel/staff"] });
      toast({ title: editing === "new" ? "Сотрудник добавлен" : "Сохранено" }); setEditing(null);
    } catch (e) { toast({ title: "Не сохранено", description: errMsg(e), variant: "destructive" }); } finally { setSaving(false); }
  }
  async function removePin() {
    if (!editing || editing === "new" || !confirm("Удалить PIN? Сотрудник не сможет отмечаться в киоске.")) return;
    try { await customFetch(`/api/personnel/staff/${editing.id}`, { method: "PATCH", body: JSON.stringify({ pin: null }) }); await qc.invalidateQueries({ queryKey: ["/api/personnel/staff"] }); setEditing({ ...editing, hasPin: false }); }
    catch (e) { toast({ title: "Ошибка", description: errMsg(e), variant: "destructive" }); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Сотрудники</h1>
          <p className="text-muted-foreground">Карточки персонала: отдел, ставка, PIN для отметок, привязка к аккаунту CRM. Сейчас на смене: <b>{onShift}</b></p>
        </div>
        {isAdmin && <Button onClick={() => open("new")}><Plus className="mr-2 h-4 w-4" />Добавить</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="w-64 pl-8" placeholder="Имя, должность, телефон" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select value={dept} onValueChange={setDept}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Все отделы</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Показать уволенных</label>
      </div>

      <Card><CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead>Отдел</TableHead><TableHead>Ставка</TableHead><TableHead>Отметки</TableHead><TableHead>Аккаунт CRM</TableHead><TableHead>Сейчас</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Загрузка…</TableCell></TableRow>
              : !rows.length ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Нет сотрудников</TableCell></TableRow>
              : rows.map((s) => (
                <TableRow key={s.id} className={s.isActive ? "" : "opacity-50"}>
                  <TableCell><div className="font-medium">{s.name}</div><div className="text-xs text-muted-foreground">{[s.position, s.phone].filter(Boolean).join(" · ") || "—"}</div></TableCell>
                  <TableCell>{s.department ? DEPARTMENTS[s.department] : "—"}</TableCell>
                  <TableCell className="text-sm">{[s.hourlyRate != null && `${s.hourlyRate} сом/ч`, s.shiftRate != null && `${s.shiftRate} сом/смена`].filter(Boolean).join(", ") || <span className="text-muted-foreground">не задана</span>}</TableCell>
                  <TableCell>{s.hasPin ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700"><KeyRound className="mr-1 h-3 w-3" />PIN есть</Badge> : <span className="text-xs text-muted-foreground">нет PIN</span>}
                    {s.hasPin && !s.photoConsentAt && <div className="mt-1 text-xs text-amber-700">нет согласия на фото</div>}</TableCell>
                  <TableCell className="text-sm">{s.accountLogin ? <>{s.accountName ?? s.accountLogin}<div className="text-xs text-muted-foreground">{s.accountLogin}</div></> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{!s.isActive ? <span className="text-xs text-muted-foreground">уволен</span> : s.openSince ? <span className="inline-flex items-center gap-1 text-sm text-emerald-700"><CircleDot className="h-3.5 w-3.5" />на смене с {fmtTime(s.openSince)}</span> : <span className="text-xs text-muted-foreground">не на смене</span>}</TableCell>
                  {isAdmin && <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={() => open(s)} aria-label="Изменить"><Edit className="h-4 w-4" /></Button></TableCell>}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{editing === "new" ? "Новый сотрудник" : "Карточка сотрудника"}</DialogTitle></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label>Имя и фамилия *</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Должность</Label><Input value={f.position} onChange={(e) => set("position", e.target.value)} placeholder="Повар горячего цеха" /></div>
            <div className="space-y-1.5"><Label>Отдел</Label>
              <Select value={f.department || "none"} onValueChange={(v) => set("department", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Не указан</SelectItem>{Object.entries(DEPARTMENTS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Телефон</Label><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="0555 12 34 56" /></div>
            <div className="space-y-1.5"><Label>Дата приёма</Label><Input type="date" value={f.hireDate} onChange={(e) => set("hireDate", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Ставка в час, сом</Label><Input type="number" min={0} value={f.hourlyRate} onChange={(e) => set("hourlyRate", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Ставка за смену, сом</Label><Input type="number" min={0} value={f.shiftRate} onChange={(e) => set("shiftRate", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Склад / площадка</Label>
              <Select value={f.locationId || "none"} onValueChange={(v) => set("locationId", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Весь ресторан</SelectItem>{locations?.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Аккаунт в CRM</Label>
              <Select value={f.userClerkId || "none"} onValueChange={(v) => set("userClerkId", v === "none" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Нет аккаунта</SelectItem>{accounts?.map((a) => <SelectItem key={a.clerkUserId} value={a.clerkUserId}>{[a.firstName, a.lastName].filter(Boolean).join(" ") || a.login} · {ROLE_LABELS[a.role] ?? a.role}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5 sm:col-span-2 rounded-lg border p-3">
              <Label>PIN для киоска отметок</Label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Input className="w-40" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} placeholder={editing !== "new" && editing?.hasPin ? "•••• (не менять)" : "4–6 цифр"} />
                {editing !== "new" && editing?.hasPin && <Button type="button" variant="ghost" size="sm" onClick={removePin}>Удалить PIN</Button>}
              </div>
              <label className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={f.photoConsent} onChange={(e) => set("photoConsent", e.target.checked)} />
                <span>Сотрудник подписал согласие на фотографирование при отметке прихода и ухода{editing !== "new" && editing?.photoConsentAt ? ` (отмечено ${new Date(editing.photoConsentAt).toLocaleDateString("ru-RU")})` : ""}</span></label>
            </div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Заметки</Label><Textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Медкнижка до…, размер формы…" /></div>
            {editing !== "new" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!f.isActive} onChange={(e) => set("isActive", !e.target.checked)} />Уволен (скрыть из графика и киоска)</label>}
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={() => setEditing(null)}>Отмена</Button><Button onClick={save} disabled={saving || !f.name.trim()}>{saving ? "…" : "Сохранить"}</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
