import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ChevronsUpDown, Plus, X } from "lucide-react";
import { CounterpartyDialog } from "@/pages/counterparties";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export interface SupplierValue { id: number | null; name: string }
interface Row { id: number; name: string; category: string | null; phone: string | null }

/**
 * Picks a supplier from the counterparty directory. Typing a name that isn't
 * there offers to add it (managers and up). Old receipts may carry a free-text
 * supplier with no id — it's shown as is until another one is picked.
 */
export function SupplierPicker({ value, onChange, testId }: { value: SupplierValue; onChange: (v: SupplierValue) => void; testId?: string }) {
  const { canDo } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [createName, setCreateName] = useState<string | null>(null);
  const { data: rows } = useQuery<Row[]>({ queryKey: ["/api/counterparties", "supplier", "", "", false], queryFn: () => customFetch<Row[]>("/api/counterparties?role=supplier"), enabled: open });
  const exact = rows?.some((r) => r.name.toLowerCase() === search.trim().toLowerCase());

  return (
    <>
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" role="combobox" className="flex-1 justify-between font-normal" data-testid={testId}>
              <span className={`truncate ${value.name ? "" : "text-muted-foreground"}`}>
                {value.name || "Выберите поставщика"}{value.name && value.id == null && <span className="ml-1 text-xs text-muted-foreground">(не из справочника)</span>}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command>
              <CommandInput placeholder="Найти поставщика…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>{search.trim() ? "Не найдено" : "Справочник поставщиков пуст"}</CommandEmpty>
                <CommandGroup>
                  {(rows ?? []).map((r) => (
                    <CommandItem key={r.id} value={`${r.name} ${r.category ?? ""} ${r.phone ?? ""} ${r.id}`} onSelect={() => { onChange({ id: r.id, name: r.name }); setOpen(false); }}>
                      <span className="flex-1 truncate">{r.name}</span>{r.category && <span className="ml-2 text-xs text-muted-foreground">{r.category}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {canDo("manager") && search.trim() && !exact && (
                  <CommandGroup>
                    <CommandItem value={`__create ${search}`} onSelect={() => { setCreateName(search.trim()); setOpen(false); }}>
                      <Plus className="mr-2 h-4 w-4" />Добавить «{search.trim()}» в справочник
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {value.name && <Button type="button" variant="ghost" size="icon" aria-label="Убрать поставщика" onClick={() => onChange({ id: null, name: "" })}><X className="h-4 w-4" /></Button>}
      </div>
      <CounterpartyDialog
        open={createName != null} onOpenChange={(v) => { if (!v) setCreateName(null); }}
        initial={createName != null ? { name: createName } : null} defaultRole="supplier"
        onSaved={(row) => onChange({ id: row.id, name: row.name })}
      />
    </>
  );
}
