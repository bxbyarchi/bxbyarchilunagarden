import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Plus, Trash2, Printer, Pencil, ArrowLeft, AlertTriangle, ChevronsUpDown, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import AccessDenied from "@/components/AccessDenied";
import { UNITS, compatibleUnits, convert, recipeUnit, fmtMoney, fmtQty } from "@/lib/units";

// ─── Types ───────────────────────────────────────────────────────────────────

type Kind = "dish" | "semi";
const KIND_LABEL: Record<Kind, string> = { dish: "Блюдо / напиток", semi: "Полуфабрикат" };

interface CardSummary {
  id: number; name: string; kind: Kind; category: string | null; isActive: boolean;
  departmentId: number | null; departmentName: string | null;
  outputQty: number; outputUnit: string; salePrice: number | null;
  cost: number; markupPct: number | null; foodCostPct: number | null; margin: number | null;
  ingredientCount: number; portionsAvailable: number | null; hasErrors: boolean;
}

interface CardLine {
  itemId: number | null; semiCardId: number | null; name: string; grossQty: number; unit: string;
  coldLossPct: number; hotLossPct: number; net: number; output: number; cost: number;
  error: string | null; sourceUnit: string | null; stock: number | null;
}

interface CardDetail extends Omit<CardSummary, "ingredientCount" | "hasErrors"> {
  technology: string | null; lines: CardLine[]; errors: string[];
  limitingItems: { id: number; name: string }[];
  requirements: { itemId: number; name: string; unit: string; qty: number; stock: number | null }[];
  usedIn: { id: number; name: string }[];
}

interface ItemOption { id: number; name: string; unit: string; pricePerUnit: string | number }
interface LocationOption { id: number; name: string; isActive: boolean }

const errMsg = (e: unknown, fallback: string) => (e as { data?: { error?: string } })?.data?.error ?? fallback;

function useLocations() {
  return useQuery<LocationOption[]>({ queryKey: ["/api/locations"], queryFn: () => customFetch<LocationOption[]>("/api/locations") });
}

function FoodCostBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground">—</span>;
  // Typical targets: up to ~30% good, 30–40% watch, above 40% expensive.
  const tone = pct <= 30 ? "bg-emerald-100 text-emerald-800" : pct <= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${tone}`}>{fmtQty(pct, 1)}%</span>;
}

function PortionsBadge({ portions }: { portions: number | null }) {
  if (portions == null) return <span className="text-muted-foreground text-xs">нет подразделения</span>;
  if (portions === 0) return <Badge variant="destructive">нет в наличии</Badge>;
  return <span className={portions < 10 ? "text-amber-700 font-semibold" : "font-medium"}>{portions.toLocaleString("ru-RU")} порц.</span>;
}

// ─── List ────────────────────────────────────────────────────────────────────

export function TechCardsList() {
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const [, setLocation] = useLocation();
  const { data: locations } = useLocations();
  const [department, setDepartment] = useState("all");
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");

  const params = new URLSearchParams();
  if (department !== "all") params.set("departmentId", department);
  if (kind !== "all") params.set("kind", kind);
  const { data: cards, isLoading } = useQuery<CardSummary[]>({
    queryKey: ["/api/tech-cards", department, kind],
    queryFn: () => customFetch<CardSummary[]>(`/api/tech-cards?${params}`),
  });

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (cards ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || (c.category ?? "").toLowerCase().includes(s));
  }, [cards, q]);

  if (roleLoading) return null;
  if (!canDo("warehouse")) return <AccessDenied />;
  const canEdit = canDo("manager");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Тех-карты</h1>
          <p className="text-muted-foreground">Рецептуры блюд, напитков и полуфабрикатов: выход, себестоимость, наценка и сколько порций можно приготовить из остатков.</p>
        </div>
        {canEdit && <Button onClick={() => setLocation("/tech-cards/new")}><Plus className="mr-2 h-4 w-4" />Новая тех-карта</Button>}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Поиск по названию или категории" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все подразделения</SelectItem>
            {locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Блюда и полуфабрикаты</SelectItem>
            <SelectItem value="dish">Только блюда / напитки</SelectItem>
            <SelectItem value="semi">Только полуфабрикаты</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="py-12 text-center text-muted-foreground">Загрузка…</div> : !shown.length ? (
            <div className="py-12 text-center text-muted-foreground">
              {cards?.length ? "Ничего не найдено." : "Тех-карт пока нет."}
              {canEdit && !cards?.length && <div className="mt-3"><Button variant="outline" onClick={() => setLocation("/tech-cards/new")}><Plus className="mr-2 h-4 w-4" />Создать первую</Button></div>}
            </div>
          ) : (
            <div className="table-scroll-mobile">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Название</TableHead>
                    <TableHead>Подразделение</TableHead>
                    <TableHead className="text-right">Выход</TableHead>
                    <TableHead className="text-right">Себестоимость</TableHead>
                    <TableHead className="text-right">Цена</TableHead>
                    <TableHead className="text-right">Наценка</TableHead>
                    <TableHead className="text-right">Фудкост</TableHead>
                    <TableHead className="text-right">Можно приготовить</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => setLocation(`/tech-cards/${c.id}`)}>
                      <TableCell>
                        <div className="font-medium flex items-center gap-2">
                          {c.name}
                          {c.hasErrors && <AlertTriangle className="h-4 w-4 text-amber-600" aria-label="Есть ошибки в составе" />}
                          {!c.isActive && <Badge variant="outline">архив</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{KIND_LABEL[c.kind]}{c.category ? ` · ${c.category}` : ""}</div>
                      </TableCell>
                      <TableCell>{c.departmentName ?? "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(c.outputQty)} {c.outputUnit}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(c.cost)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{c.kind === "semi" ? "—" : fmtMoney(c.salePrice)}</TableCell>
                      <TableCell className="text-right">{c.markupPct == null ? "—" : `${fmtQty(c.markupPct, 1)}%`}</TableCell>
                      <TableCell className="text-right"><FoodCostBadge pct={c.foodCostPct} /></TableCell>
                      <TableCell className="text-right whitespace-nowrap"><PortionsBadge portions={c.portionsAvailable} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Detail (print-friendly) ─────────────────────────────────────────────────

export function TechCardDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: card, isLoading, error } = useQuery<CardDetail>({
    queryKey: ["/api/tech-cards", id],
    queryFn: () => customFetch<CardDetail>(`/api/tech-cards/${id}`),
  });

  if (roleLoading || isLoading) return <div className="py-12 text-center text-muted-foreground">Загрузка…</div>;
  if (!canDo("warehouse")) return <AccessDenied />;
  if (error || !card) return <div className="py-12 text-center text-muted-foreground">Тех-карта не найдена. <Link href="/tech-cards" className="underline">К списку</Link></div>;
  const canEdit = canDo("manager");

  async function remove() {
    if (!window.confirm(`Удалить тех-карту «${card!.name}»?`)) return;
    try {
      await customFetch(`/api/tech-cards/${card!.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["/api/tech-cards"] });
      toast({ title: "Тех-карта удалена" });
      setLocation("/tech-cards");
    } catch (e) {
      toast({ title: "Не удалось удалить", description: errMsg(e, ""), variant: "destructive" });
    }
  }

  // Weight/volume totals only make sense when every line is in the output unit's family
  // (e.g. all grams); with mixed г + мл + шт a sum would silently drop lines.
  const sameFamily = card.lines.every((l) => convert(1, l.unit, card.outputUnit) != null);
  const totalNet = sameFamily ? card.lines.reduce((s, l) => s + convert(l.net, l.unit, card.outputUnit)!, 0) : 0;
  const totalOut = sameFamily ? card.lines.reduce((s, l) => s + convert(l.output, l.unit, card.outputUnit)!, 0) : 0;

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" onClick={() => setLocation("/tech-cards")}><ArrowLeft className="mr-2 h-4 w-4" />Все тех-карты</Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.print()}><Printer className="mr-2 h-4 w-4" />Печать</Button>
          {canEdit && <Button variant="outline" onClick={() => setLocation(`/tech-cards/${card.id}/edit`)}><Pencil className="mr-2 h-4 w-4" />Редактировать</Button>}
          {canEdit && <Button variant="ghost" className="text-destructive" onClick={remove}><Trash2 className="h-4 w-4" /></Button>}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Технологическая карта · {KIND_LABEL[card.kind]}</div>
          <h1 className="text-2xl font-bold tracking-tight mt-1">{card.name}</h1>
          <p className="text-muted-foreground mt-1">{[card.departmentName, card.category].filter(Boolean).join(" · ") || "Подразделение не указано"}</p>
        </div>
        <img src={`${import.meta.env.BASE_URL}brand/logo-horizontal.svg`} alt="" className="hidden print:block h-12" />
      </div>

      {card.errors.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 print:hidden">
          <div className="font-semibold flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Часть состава не посчитана</div>
          <ul className="mt-1 list-disc pl-5">{card.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Выход порции" value={`${fmtQty(card.outputQty)} ${card.outputUnit}`} />
        <Stat label="Себестоимость" value={fmtMoney(card.cost)} />
        <Stat label="Цена продажи" value={card.kind === "semi" ? "—" : fmtMoney(card.salePrice)} />
        <Stat label="Наценка / фудкост" value={card.markupPct == null ? "—" : `${fmtQty(card.markupPct, 1)}% / ${fmtQty(card.foodCostPct, 1)}%`} />
        <Stat label="Можно приготовить" value={card.portionsAvailable == null ? "—" : `${card.portionsAvailable} порц.`} tone={card.portionsAvailable === 0 ? "bad" : undefined} />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Состав на 1 порцию</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="table-scroll-mobile">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ингредиент</TableHead>
                  <TableHead className="text-right">Брутто</TableHead>
                  <TableHead className="text-right">Хол. потери</TableHead>
                  <TableHead className="text-right">Нетто</TableHead>
                  <TableHead className="text-right">Тепл. потери</TableHead>
                  <TableHead className="text-right">Выход</TableHead>
                  <TableHead className="text-right">Стоимость</TableHead>
                  <TableHead className="text-right print:hidden">Остаток</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {card.lines.map((l, i) => {
                  const limiting = l.itemId != null && card.limitingItems.some((x) => x.id === l.itemId);
                  return (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="font-medium">{l.name}</div>
                        {l.semiCardId != null && <Link href={`/tech-cards/${l.semiCardId}`} className="text-xs text-primary underline print:no-underline">полуфабрикат</Link>}
                        {l.error && <div className="text-xs text-destructive">{l.error}</div>}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(l.grossQty)} {l.unit}</TableCell>
                      <TableCell className="text-right">{l.coldLossPct ? `${fmtQty(l.coldLossPct, 1)}%` : "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(l.net)} {l.unit}</TableCell>
                      <TableCell className="text-right">{l.hotLossPct ? `${fmtQty(l.hotLossPct, 1)}%` : "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtQty(l.output)} {l.unit}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtMoney(l.cost)}</TableCell>
                      <TableCell className={`text-right whitespace-nowrap print:hidden ${limiting ? "text-destructive font-semibold" : ""}`}>
                        {l.stock == null ? "—" : `${fmtQty(l.stock)} ${l.sourceUnit ?? ""}`}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="font-semibold">
                  <TableCell>Итого</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right whitespace-nowrap">{totalNet ? `${fmtQty(totalNet)} ${card.outputUnit}` : ""}</TableCell>
                  <TableCell />
                  <TableCell className="text-right whitespace-nowrap">{totalOut ? `${fmtQty(totalOut)} ${card.outputUnit}` : ""}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{fmtMoney(card.cost)}</TableCell>
                  <TableCell className="print:hidden" />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {card.limitingItems.length > 0 && card.portionsAvailable !== null && (
        <p className="text-sm text-muted-foreground print:hidden">
          {card.portionsAvailable === 0 ? "Не хватает: " : "Первым закончится: "}
          <span className="font-medium text-foreground">{card.limitingItems.map((i) => i.name).join(", ")}</span>
          {card.departmentName ? ` (остатки подразделения «${card.departmentName}»)` : ""}
        </p>
      )}

      {card.technology && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Технология приготовления</CardTitle></CardHeader>
          <CardContent><p className="whitespace-pre-wrap text-sm leading-relaxed">{card.technology}</p></CardContent>
        </Card>
      )}

      {card.usedIn.length > 0 && (
        <p className="text-sm text-muted-foreground print:hidden">
          Используется в: {card.usedIn.map((u, i) => <span key={u.id}>{i > 0 && ", "}<Link href={`/tech-cards/${u.id}`} className="text-primary underline">{u.name}</Link></span>)}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "bad" ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────────

interface Row {
  key: number;
  source: { type: "item" | "semi"; id: number } | null;
  grossQty: string; unit: string; coldLossPct: string; hotLossPct: string;
}

let rowKey = 0;
const emptyRow = (): Row => ({ key: ++rowKey, source: null, grossQty: "", unit: "г", coldLossPct: "", hotLossPct: "" });
const toNum = (s: string) => { const n = Number(s.replace(",", ".")); return Number.isFinite(n) ? n : 0; };

function SourcePicker({ value, items, semis, onChange }: {
  value: Row["source"]; items: ItemOption[]; semis: CardSummary[];
  onChange: (src: NonNullable<Row["source"]>, unit: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value == null ? "Выберите ингредиент"
    : value.type === "item" ? items.find((i) => i.id === value.id)?.name ?? "—"
    : `${semis.find((s) => s.id === value.id)?.name ?? "—"} (п/ф)`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className={`truncate ${value == null ? "text-muted-foreground" : ""}`}>{label}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск…" />
          <CommandList>
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {semis.length > 0 && (
              <CommandGroup heading="Полуфабрикаты">
                {semis.map((s) => (
                  <CommandItem key={`s${s.id}`} value={`п/ф ${s.name} ${s.id}`} onSelect={() => { onChange({ type: "semi", id: s.id }, recipeUnit(s.outputUnit)); setOpen(false); }}>
                    {s.name}<span className="ml-auto text-xs text-muted-foreground">{s.outputUnit}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Склад">
              {items.map((i) => (
                <CommandItem key={`i${i.id}`} value={`${i.name} ${i.id}`} onSelect={() => { onChange({ type: "item", id: i.id }, recipeUnit(i.unit)); setOpen(false); }}>
                  {i.name}<span className="ml-auto text-xs text-muted-foreground">{fmtMoney(Number(i.pricePerUnit))}/{i.unit}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function TechCardEditor() {
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number(params.id) : null;
  const [, setLocation] = useLocation();
  const { canDo, isLoading: roleLoading } = useCurrentUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: locations } = useLocations();
  const { data: items } = useQuery<ItemOption[]>({ queryKey: ["/api/items", "all"], queryFn: () => customFetch<ItemOption[]>("/api/items") });
  const { data: allCards } = useQuery<CardSummary[]>({ queryKey: ["/api/tech-cards", "all", "all"], queryFn: () => customFetch<CardSummary[]>("/api/tech-cards") });
  const { data: existing } = useQuery<CardDetail>({
    queryKey: ["/api/tech-cards", String(editingId)],
    queryFn: () => customFetch<CardDetail>(`/api/tech-cards/${editingId}`),
    enabled: editingId != null,
  });

  const [form, setForm] = useState({ name: "", kind: "dish" as Kind, departmentId: "none", category: "", outputQty: "", outputUnit: "г", salePrice: "", technology: "" });
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(editingId == null);

  useEffect(() => {
    if (!existing || loaded) return;
    setForm({
      name: existing.name, kind: existing.kind, departmentId: existing.departmentId == null ? "none" : String(existing.departmentId),
      category: existing.category ?? "", outputQty: String(existing.outputQty), outputUnit: existing.outputUnit,
      salePrice: existing.salePrice == null ? "" : String(existing.salePrice), technology: existing.technology ?? "",
    });
    setRows(existing.lines.map((l) => ({
      key: ++rowKey,
      source: l.itemId != null ? { type: "item", id: l.itemId } : { type: "semi", id: l.semiCardId! },
      grossQty: String(l.grossQty), unit: l.unit,
      coldLossPct: l.coldLossPct ? String(l.coldLossPct) : "", hotLossPct: l.hotLossPct ? String(l.hotLossPct) : "",
    })));
    setLoaded(true);
  }, [existing, loaded]);

  const semis = useMemo(() => (allCards ?? []).filter((c) => c.kind === "semi" && c.id !== editingId), [allCards, editingId]);
  const itemList = items ?? [];

  /** Live preview: cost per line (server recomputes on save). */
  function lineCalc(r: Row) {
    const gross = toNum(r.grossQty);
    const net = gross * (1 - Math.min(toNum(r.coldLossPct), 99) / 100);
    const out = net * (1 - Math.min(toNum(r.hotLossPct), 99) / 100);
    let cost: number | null = null;
    let sourceUnit = "";
    if (r.source?.type === "item") {
      const it = itemList.find((i) => i.id === r.source!.id);
      if (it) { sourceUnit = it.unit; const q = convert(gross, r.unit, it.unit); cost = q == null ? null : q * Number(it.pricePerUnit); }
    } else if (r.source?.type === "semi") {
      const s = semis.find((x) => x.id === r.source!.id);
      if (s) { sourceUnit = s.outputUnit; const q = convert(gross, r.unit, s.outputUnit); cost = q == null || !s.outputQty ? null : (s.cost / s.outputQty) * q; }
    }
    return { net, out, cost, sourceUnit };
  }
  const calcs = rows.map(lineCalc);
  const totalCost = calcs.reduce((s, c) => s + (c.cost ?? 0), 0);
  const filled = rows.filter((r) => r.source && r.grossQty);
  const totalOut = filled.length && filled.every((r) => convert(1, r.unit, form.outputUnit) != null)
    ? rows.reduce((s, r, i) => s + (r.source && r.grossQty ? convert(calcs[i].out, r.unit, form.outputUnit)! : 0), 0)
    : 0;
  const price = toNum(form.salePrice);
  const foodCost = price > 0 ? (totalCost / price) * 100 : null;
  const markup = price > 0 && totalCost > 0 ? ((price - totalCost) / totalCost) * 100 : null;

  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setF = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: form.name, kind: form.kind, departmentId: form.departmentId === "none" ? null : Number(form.departmentId),
        category: form.category, outputQty: form.outputQty, outputUnit: form.outputUnit,
        salePrice: form.kind === "semi" ? null : form.salePrice || null, technology: form.technology,
        ingredients: rows.filter((r) => r.source || r.grossQty).map((r) => ({
          itemId: r.source?.type === "item" ? r.source.id : null,
          semiCardId: r.source?.type === "semi" ? r.source.id : null,
          grossQty: r.grossQty, unit: r.unit, coldLossPct: r.coldLossPct || 0, hotLossPct: r.hotLossPct || 0,
        })),
      };
      const res = await customFetch<{ id: number }>(editingId ? `/api/tech-cards/${editingId}` : "/api/tech-cards", {
        method: editingId ? "PUT" : "POST", body: JSON.stringify(body),
      });
      await qc.invalidateQueries({ queryKey: ["/api/tech-cards"] });
      toast({ title: editingId ? "Тех-карта сохранена" : "Тех-карта создана" });
      setLocation(`/tech-cards/${res.id}`);
    } catch (e) {
      toast({ title: "Не удалось сохранить", description: errMsg(e, "Проверьте поля"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (roleLoading) return null;
  if (!canDo("manager")) return <AccessDenied />;
  if (!loaded) return <div className="py-12 text-center text-muted-foreground">Загрузка…</div>;

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => setLocation(editingId ? `/tech-cards/${editingId}` : "/tech-cards")}><ArrowLeft className="mr-2 h-4 w-4" />Назад</Button>
      </div>
      <h1 className="text-2xl font-bold tracking-tight">{editingId ? "Редактирование тех-карты" : "Новая тех-карта"}</h1>

      <Card>
        <CardContent className="pt-6 grid gap-4 md:grid-cols-6">
          <div className="space-y-1.5 md:col-span-3"><Label>Название *</Label><Input value={form.name} onChange={(e) => setF("name")(e.target.value)} placeholder="Например, Стейк рибай" /></div>
          <div className="space-y-1.5 md:col-span-3"><Label>Тип</Label>
            <Select value={form.kind} onValueChange={(v) => setF("kind")(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="dish">Блюдо / напиток (продаётся)</SelectItem><SelectItem value="semi">Полуфабрикат (входит в другие тех-карты)</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2"><Label>Подразделение</Label>
            <Select value={form.departmentId} onValueChange={setF("departmentId")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Не указано</SelectItem>
                {locations?.filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Из остатков этого подразделения считается, сколько порций можно приготовить.</p>
          </div>
          <div className="space-y-1.5 md:col-span-2"><Label>Категория</Label><Input value={form.category} onChange={(e) => setF("category")(e.target.value)} placeholder="Горячее, Коктейли, Десерты…" /></div>
          <div className="space-y-1.5 md:col-span-2"><Label>{form.kind === "semi" ? "Выход закладки *" : "Выход порции *"}</Label>
            <div className="flex gap-2">
              <Input inputMode="decimal" value={form.outputQty} onChange={(e) => setF("outputQty")(e.target.value)} placeholder="250" />
              <Select value={form.outputUnit} onValueChange={setF("outputUnit")}>
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {totalOut > 0 && <p className="text-xs text-muted-foreground">По составу выходит ≈ {fmtQty(totalOut, 1)} {form.outputUnit}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Состав на {form.kind === "semi" ? "закладку" : "1 порцию"}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="hidden md:grid grid-cols-[minmax(0,2.5fr)_1fr_5.5rem_1fr_1fr_1fr_2.5rem] gap-2 text-xs text-muted-foreground px-1">
            <div>Ингредиент</div><div>Брутто</div><div>Ед.</div><div>Хол. потери %</div><div>Тепл. потери %</div><div className="text-right">Стоимость</div><div />
          </div>
          {rows.map((r, i) => {
            const c = calcs[i];
            const units = c.sourceUnit ? compatibleUnits(c.sourceUnit) : [...UNITS];
            return (
              <div key={r.key} className="grid grid-cols-2 md:grid-cols-[minmax(0,2.5fr)_1fr_5.5rem_1fr_1fr_1fr_2.5rem] gap-2 items-center rounded-lg border p-2 md:border-0 md:p-0">
                <div className="col-span-2 md:col-span-1">
                  <SourcePicker value={r.source} items={itemList} semis={semis} onChange={(source, unit) => setRow(r.key, { source, unit })} />
                </div>
                <Input inputMode="decimal" placeholder="Брутто" value={r.grossQty} onChange={(e) => setRow(r.key, { grossQty: e.target.value })} />
                <Select value={r.unit} onValueChange={(unit) => setRow(r.key, { unit })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                </Select>
                <Input inputMode="decimal" placeholder="Хол. %" value={r.coldLossPct} onChange={(e) => setRow(r.key, { coldLossPct: e.target.value })} />
                <Input inputMode="decimal" placeholder="Тепл. %" value={r.hotLossPct} onChange={(e) => setRow(r.key, { hotLossPct: e.target.value })} />
                <div className="text-right text-sm whitespace-nowrap">
                  {c.cost == null ? <span className="text-muted-foreground">—</span> : fmtMoney(c.cost)}
                  {r.grossQty && (toNum(r.coldLossPct) > 0 || toNum(r.hotLossPct) > 0) && (
                    <div className="text-xs text-muted-foreground">нетто {fmtQty(c.net, 1)} · выход {fmtQty(c.out, 1)}</div>
                  )}
                </div>
                <Button variant="ghost" size="icon" aria-label="Удалить строку" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [emptyRow()]))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            );
          })}
          <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, emptyRow()])}><Plus className="mr-2 h-4 w-4" />Добавить ингредиент</Button>
          {itemList.length === 0 && <p className="text-sm text-muted-foreground">На складе пока нет позиций — сначала добавьте продукты в разделе «Склад».</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Технология приготовления</CardTitle></CardHeader>
        <CardContent><Textarea rows={5} value={form.technology} onChange={(e) => setF("technology")(e.target.value)} placeholder="Порядок приготовления, подача, температура, сроки хранения…" /></CardContent>
      </Card>

      <div className="fixed bottom-0 left-0 right-0 md:left-64 z-10 border-t bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="text-sm"><span className="text-muted-foreground">Себестоимость: </span><span className="font-semibold">{fmtMoney(totalCost)}</span></div>
          {form.kind === "dish" && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Цена продажи:</span>
                <Input className="h-9 w-28" inputMode="decimal" value={form.salePrice} onChange={(e) => setF("salePrice")(e.target.value)} placeholder="0" />
                <span className="text-muted-foreground">сом</span>
              </div>
              <div className="text-sm"><span className="text-muted-foreground">Наценка: </span><span className="font-semibold">{markup == null ? "—" : `${fmtQty(markup, 1)}%`}</span></div>
              <div className="text-sm flex items-center gap-1"><span className="text-muted-foreground">Фудкост: </span><FoodCostBadge pct={foodCost == null ? null : Math.round(foodCost * 10) / 10} /></div>
            </>
          )}
          <Button className="ml-auto" onClick={save} disabled={saving || !form.name.trim()}>{saving ? "Сохранение…" : "Сохранить"}</Button>
        </div>
      </div>
    </div>
  );
}
