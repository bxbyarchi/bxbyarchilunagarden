import { useState } from "react";
import { useLocation as useWouterLocation } from "wouter";
import {
  useListHouses, useCreateHouse, useUpdateHouse, useDeleteHouse,
  useListLocations, getListHousesQueryKey,
  useListProducts, getListProductsQueryKey, customFetch,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Edit, Trash2, KeyRound, UtensilsCrossed, Landmark } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";

const houseSchema = z.object({
  name: z.string().min(1, "Название обязательно"),
  locationId: z.string().min(1, "Площадка обязательна"),
});
type HouseFormData = z.infer<typeof houseSchema>;

type House = { id: number; name: string; isActive: boolean; locationId: number; locationName?: string | null; registerCount: number };

export default function Houses() {
  const { user, canDoVenue, isVenueAdmin } = useCurrentUser();
  const isAdmin = isVenueAdmin;
  const canManage = canDoVenue("location_admin");
  const [, setLocation] = useWouterLocation();
  const [locationFilter, setLocationFilter] = useState("");
  const listParams = { locationId: locationFilter ? Number(locationFilter) : undefined };
  const { data: houses, isLoading } = useListHouses(listParams, { query: { queryKey: getListHousesQueryKey(listParams) } });
  const { data: allLocations } = useListLocations();
  const venues = allLocations?.filter((l) => l.isVenue);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<House | null>(null);
  const [menuHouse, setMenuHouse] = useState<House | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const create = useCreateHouse();
  const update = useUpdateHouse();
  const remove = useDeleteHouse();

  const form = useForm<HouseFormData>({
    resolver: zodResolver(houseSchema),
    defaultValues: { name: "", locationId: "" },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ name: "", locationId: isAdmin ? "" : String(user?.locationId ?? "") });
    setOpen(true);
  }

  function openEdit(h: House) {
    setEditing(h);
    form.reset({ name: h.name, locationId: String(h.locationId) });
    setOpen(true);
  }

  function onSubmit(data: HouseFormData) {
    const invalidate = () => { queryClient.invalidateQueries({ queryKey: getListHousesQueryKey() }); setOpen(false); };
    if (editing) {
      update.mutate({ id: editing.id, data: { name: data.name } }, {
        onSuccess: () => { toast({ title: "Точка продаж обновлена" }); invalidate(); },
        onError: () => toast({ title: "Ошибка", variant: "destructive" }),
      });
    } else {
      create.mutate({ data: { name: data.name, locationId: Number(data.locationId) } }, {
        onSuccess: () => { toast({ title: "Точка продаж добавлена" }); invalidate(); },
        onError: () => toast({ title: "Ошибка", variant: "destructive" }),
      });
    }
  }

  function handleDelete(id: number) {
    if (!confirm("Удалить точку продаж? Это возможно, только если в ней нет касс.")) return;
    remove.mutate({ id }, {
      onSuccess: () => { toast({ title: "Точка продаж удалена" }); queryClient.invalidateQueries({ queryKey: getListHousesQueryKey() }); },
      onError: () => toast({ title: "Ошибка", description: "Возможно, в точке продаж ещё есть кассы", variant: "destructive" }),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Точки продаж</h1>
          <p className="text-muted-foreground text-sm">Зал, бар, веранда, доставка — где принимают оплату. У каждой точки своё меню и кассы.</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Select value={locationFilter || "all"} onValueChange={(v) => setLocationFilter(v === "all" ? "" : v)}>
              <SelectTrigger className="w-[200px]" data-testid="select-filter-house-location"><SelectValue placeholder="Все площадки" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все площадки</SelectItem>
                {venues?.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {canManage && (
            <Button onClick={openCreate} data-testid="btn-create-house">
              <Plus className="mr-2 h-4 w-4" /> Добавить
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название</TableHead>
                <TableHead>Площадка</TableHead>
                <TableHead>Касс</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Загрузка...</TableCell></TableRow>
              ) : !houses?.length ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Нет точек продаж</TableCell></TableRow>
              ) : (
                houses.map((h) => (
                  <TableRow
                    key={h.id}
                    data-testid={`row-house-${h.id}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setLocation(`/registers?houseId=${h.id}`)}
                    title={`Показать кассы точки продаж «${h.name}»`}
                  >
                    <TableCell className="font-medium flex items-center gap-2"><KeyRound className="h-3.5 w-3.5 text-muted-foreground" />{h.name}</TableCell>
                    <TableCell className="text-muted-foreground">{h.locationName ?? "—"}</TableCell>
                    <TableCell>{h.registerCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={h.isActive ? "text-emerald-700 bg-emerald-50 border-emerald-200" : "text-muted-foreground"}>
                        {h.isActive ? "Активен" : "Неактивен"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" onClick={() => setMenuHouse(h)} data-testid={`btn-menu-house-${h.id}`}>
                        <UtensilsCrossed className="mr-1.5 h-3.5 w-3.5" /> Меню
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setLocation(`/registers?houseId=${h.id}`)} data-testid={`btn-registers-house-${h.id}`}>
                        <Landmark className="mr-1.5 h-3.5 w-3.5" /> Кассы
                      </Button>
                      {canManage && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => openEdit(h)} data-testid={`btn-edit-house-${h.id}`}><Edit className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(h.id)} data-testid={`btn-delete-house-${h.id}`}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? "Редактировать точку продаж" : "Новая точка продаж"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Название *</FormLabel><FormControl><Input placeholder="Точка продаж 1" {...field} data-testid="input-house-name" /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="locationId" render={({ field }) => (
                <FormItem><FormLabel>Площадка *</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={!!editing}>
                    <FormControl><SelectTrigger data-testid="select-house-location"><SelectValue placeholder="Выбрать" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {venues?.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                <FormMessage /></FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Отмена</Button>
                <Button type="submit" disabled={create.isPending || update.isPending} data-testid="btn-submit-house">
                  {editing ? "Сохранить" : "Добавить"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {menuHouse && (
        <HouseMenuDialog house={menuHouse} canManage={canManage} onClose={() => setMenuHouse(null)} />
      )}
    </div>
  );
}

type Product = {
  id: number; houseId: number; category: string; name: string; price: string; isActive: boolean; sortOrder: number;
  techCardId: number | null; itemId: number | null; itemQty: string; writeOffLocationId: number | null; barcode: string | null;
};
type MenuCard = { id: number; name: string; kind: string; category: string | null; salePrice: number | null; cost: number; foodCostPct: number | null; departmentName: string | null; isActive: boolean };
type StockItem = { id: number; name: string; unit: string };
type Loc = { id: number; name: string; isActive: boolean };
type Source = "card" | "item" | "none";

const emptyForm = { category: "", name: "", price: "", source: "card" as Source, techCardId: "", itemId: "", itemQty: "1", writeOffLocationId: "auto", barcode: "" };

function HouseMenuDialog({ house, canManage, onClose }: { house: House; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = { houseId: house.id };
  const { data: products, isLoading } = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params) } });
  const { data: cards } = useQuery<MenuCard[]>({ queryKey: ["/api/tech-cards", "all", "dish"], queryFn: () => customFetch<MenuCard[]>("/api/tech-cards?kind=dish"), enabled: canManage });
  const { data: stockItems } = useQuery<StockItem[]>({ queryKey: ["/api/items", "all"], queryFn: () => customFetch<StockItem[]>("/api/items"), enabled: canManage });
  const { data: locations } = useQuery<Loc[]>({ queryKey: ["/api/locations"], queryFn: () => customFetch<Loc[]>("/api/locations"), enabled: canManage });

  const [editing, setEditing] = useState<Product | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof emptyForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const list = (products as Product[] | undefined) ?? [];
  const cardById = new Map((cards ?? []).map((c) => [c.id, c]));
  const itemById = new Map((stockItems ?? []).map((i) => [i.id, i]));
  const productsByCategory = list.reduce<Record<string, Product[]>>((acc, p) => { (acc[p.category] ??= []).push(p); return acc; }, {});
  const onMenu = new Set(list.map((p) => p.techCardId).filter((v): v is number => v != null));
  const importable = (cards ?? []).filter((c) => c.isActive && !onMenu.has(c.id));
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListProductsQueryKey(params) });
  const errText = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;

  function openCreate() { setEditing(null); setForm(emptyForm); setFormOpen(true); }
  function openEdit(p: Product) {
    setEditing(p);
    setForm({
      category: p.category, name: p.name, price: String(Number(p.price)),
      source: p.techCardId != null ? "card" : p.itemId != null ? "item" : "none",
      techCardId: p.techCardId ? String(p.techCardId) : "", itemId: p.itemId ? String(p.itemId) : "",
      itemQty: String(Number(p.itemQty) || 1), writeOffLocationId: p.writeOffLocationId ? String(p.writeOffLocationId) : "auto", barcode: p.barcode ?? "",
    });
    setFormOpen(true);
  }
  function pickCard(id: string) {
    const c = cardById.get(Number(id));
    setForm((f) => ({ ...f, techCardId: id, name: f.name || c?.name || "", category: f.category || c?.category || "", price: f.price || (c?.salePrice != null ? String(c.salePrice) : "") }));
  }

  async function save() {
    if (!form.category.trim() || !form.name.trim() || !(Number(form.price) >= 0) || form.price === "") { toast({ title: "Заполните категорию, название и цену", variant: "destructive" }); return; }
    setSaving(true);
    const body = {
      houseId: house.id, category: form.category.trim(), name: form.name.trim(), price: Number(form.price),
      techCardId: form.source === "card" && form.techCardId ? Number(form.techCardId) : null,
      itemId: form.source === "item" && form.itemId ? Number(form.itemId) : null,
      itemQty: form.source === "item" ? form.itemQty : "1",
      writeOffLocationId: form.writeOffLocationId === "auto" ? null : Number(form.writeOffLocationId),
      barcode: form.barcode,
    };
    try {
      await customFetch(editing ? `/api/products/${editing.id}` : "/api/products", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      toast({ title: editing ? "Позиция обновлена" : "Позиция добавлена" });
      setFormOpen(false); await refresh();
    } catch (e) { toast({ title: "Ошибка", description: errText(e), variant: "destructive" }); } finally { setSaving(false); }
  }

  async function remove(id: number) {
    if (!confirm("Убрать позицию из меню?")) return;
    try { await customFetch(`/api/products/${id}`, { method: "DELETE" }); toast({ title: "Позиция убрана из меню" }); await refresh(); }
    catch (e) { toast({ title: "Ошибка", description: errText(e), variant: "destructive" }); }
  }

  async function importCards() {
    try {
      const r = await customFetch<{ added: number; noPrice: string[] }>("/api/products/from-tech-cards", { method: "POST", body: JSON.stringify({ houseId: house.id, techCardIds: [...picked] }) });
      toast({ title: `Добавлено в меню: ${r.added}`, description: r.noPrice.length ? `Без цены продажи: ${r.noPrice.join(", ")} — укажите цену` : undefined });
      setImportOpen(false); setPicked(new Set()); await refresh();
    } catch (e) { toast({ title: "Ошибка", description: errText(e), variant: "destructive" }); }
  }

  function sourceLabel(p: Product) {
    if (p.techCardId != null) {
      const c = cardById.get(p.techCardId);
      return <span className="text-[11px] text-muted-foreground">тех-карта{c?.foodCostPct != null ? ` · фудкост ${Math.round((c.cost / Number(p.price || 1)) * 1000) / 10}%` : ""}</span>;
    }
    if (p.itemId != null) return <span className="text-[11px] text-muted-foreground">со склада: {itemById.get(p.itemId)?.name ?? "позиция"} × {Number(p.itemQty)}</span>;
    return <span className="text-[11px] text-amber-700">без списания со склада</span>;
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Меню точки «{house.name}»</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Загрузка...</p>
            : !list.length ? <p className="text-sm text-muted-foreground">В меню пока нет позиций. Быстрее всего — добавить блюда из тех-карт.</p>
            : Object.entries(productsByCategory).map(([category, items]) => (
              <div key={category} className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{category}</div>
                <div className="space-y-1">
                  {items.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
                      <div className="min-w-0"><div className="truncate">{p.name}{p.barcode && <span className="ml-2 text-[11px] text-muted-foreground font-mono">{p.barcode}</span>}</div>{sourceLabel(p)}</div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-medium">{Number(p.price).toLocaleString("ru-RU")} сом</span>
                        {canManage && (<>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => openEdit(p)} data-testid={`btn-edit-product-${p.id}`}><Edit className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => remove(p.id)} data-testid={`btn-delete-product-${p.id}`}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                        </>)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

          {canManage && !formOpen && !importOpen && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setImportOpen(true)} disabled={!importable.length}><Plus className="mr-1.5 h-3.5 w-3.5" />Из тех-карт{importable.length ? ` (${importable.length})` : ""}</Button>
              <Button variant="outline" size="sm" onClick={openCreate} data-testid="btn-add-product"><Plus className="mr-1.5 h-3.5 w-3.5" />Добавить вручную</Button>
            </div>
          )}

          {canManage && importOpen && (
            <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
              <div className="flex items-center justify-between text-sm font-medium">
                <span>Блюда и напитки из тех-карт</span>
                <button type="button" className="text-xs text-primary underline" onClick={() => setPicked(picked.size === importable.length ? new Set() : new Set(importable.map((c) => c.id)))}>{picked.size === importable.length ? "Снять все" : "Выбрать все"}</button>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1">
                {importable.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50 text-sm cursor-pointer">
                    <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                    <span className="flex-1">{c.name}<span className="ml-1 text-xs text-muted-foreground">{[c.departmentName, c.category].filter(Boolean).join(" · ")}</span></span>
                    <span className="text-xs">{c.salePrice != null ? `${c.salePrice.toLocaleString("ru-RU")} сом` : <span className="text-amber-700">нет цены</span>}</span>
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>Отмена</Button>
                <Button size="sm" onClick={importCards} disabled={!picked.size}>Добавить {picked.size || ""}</Button>
              </div>
            </div>
          )}

          {canManage && formOpen && (
            <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
              <div className="space-y-1.5"><Label className="text-xs">Списание со склада при продаже</Label>
                <Select value={form.source} onValueChange={(v) => set("source")(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="card">По тех-карте (блюдо, коктейль)</SelectItem>
                    <SelectItem value="item">Готовый товар со склада (вода, сок в бутылке)</SelectItem>
                    <SelectItem value="none">Не списывать (услуга, депозит)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.source === "card" && (
                <div className="space-y-1.5"><Label className="text-xs">Тех-карта</Label>
                  <Select value={form.techCardId} onValueChange={pickCard}>
                    <SelectTrigger><SelectValue placeholder="Выберите блюдо" /></SelectTrigger>
                    <SelectContent>{(cards ?? []).filter((c) => c.isActive).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              {form.source === "item" && (
                <div className="grid grid-cols-[1fr_7rem] gap-2">
                  <div className="space-y-1.5"><Label className="text-xs">Позиция склада</Label>
                    <Select value={form.itemId} onValueChange={(v) => { set("itemId")(v); if (!form.name) set("name")(itemById.get(Number(v))?.name ?? ""); }}>
                      <SelectTrigger><SelectValue placeholder="Выберите товар" /></SelectTrigger>
                      <SelectContent>{(stockItems ?? []).map((i) => <SelectItem key={i.id} value={String(i.id)}>{i.name} ({i.unit})</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5"><Label className="text-xs">Списать, {itemById.get(Number(form.itemId))?.unit ?? "ед."}</Label><Input inputMode="decimal" value={form.itemQty} onChange={(e) => set("itemQty")(e.target.value)} /></div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label className="text-xs">Категория *</Label><Input value={form.category} onChange={(e) => set("category")(e.target.value)} placeholder="Горячее, Коктейли…" data-testid="input-product-category" /></div>
                <div className="space-y-1.5"><Label className="text-xs">Цена (сом) *</Label><Input type="number" step="0.01" value={form.price} onChange={(e) => set("price")(e.target.value)} data-testid="input-product-price" /></div>
              </div>
              <div className="space-y-1.5"><Label className="text-xs">Название в меню и чеке *</Label><Input value={form.name} onChange={(e) => set("name")(e.target.value)} data-testid="input-product-name" /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label className="text-xs">Штрих-код</Label><Input value={form.barcode} onChange={(e) => set("barcode")(e.target.value)} placeholder="Отсканируйте или введите" /></div>
                <div className="space-y-1.5"><Label className="text-xs">Склад списания</Label>
                  <Select value={form.writeOffLocationId} onValueChange={set("writeOffLocationId")} disabled={form.source === "none"}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{form.source === "card" ? "Подразделение тех-карты" : "Склад этой точки"}</SelectItem>
                      {(locations ?? []).filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(false)}>Отмена</Button>
                <Button size="sm" onClick={save} disabled={saving} data-testid="btn-submit-product">{editing ? "Сохранить" : "Добавить"}</Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
