/** Pure helpers for guests and bookings. */

/**
 * Normalises a Kyrgyz (or international) phone to digits with country code:
 * "0555 12-34-56", "+996 555 123 456", "555123456" → "996555123456".
 * Returns null when there aren't enough digits to be a phone.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0")) d = "996" + d.slice(1); // 0555123456
  else if (d.length === 9) d = "996" + d;                           // 555123456
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/** "996555123456" → "+996 555 123 456" for display. */
export function formatPhone(p: string | null | undefined): string {
  if (!p) return "";
  const m = /^996(\d{3})(\d{3})(\d{3})$/.exec(p);
  return m ? `+996 ${m[1]} ${m[2]} ${m[3]}` : `+${p}`;
}

export interface Slot { startsAt: Date; durationMin: number }
const endOf = (s: Slot) => s.startsAt.getTime() + s.durationMin * 60_000;

/** Half-open intervals: a booking ending at 20:00 doesn't clash with one starting at 20:00. */
export function overlaps(a: Slot, b: Slot): boolean {
  return a.startsAt.getTime() < endOf(b) && b.startsAt.getTime() < endOf(a);
}

export interface TableInfo { id: number; name: string; zone: string | null; seats: number }
export interface BusyBooking extends Slot { id: number; tableIds: number[] }

/** Tables free for the whole slot (ignoring `exceptBookingId`, e.g. the booking being edited). */
export function freeTables(tables: TableInfo[], bookings: BusyBooking[], slot: Slot, exceptBookingId?: number | null): TableInfo[] {
  const busy = new Set<number>();
  for (const b of bookings) {
    if (b.id === exceptBookingId) continue;
    if (overlaps(b, slot)) b.tableIds.forEach((t) => busy.add(t));
  }
  return tables.filter((t) => !busy.has(t.id));
}

/**
 * Picks tables for a party: the smallest single table that fits; otherwise the
 * fewest tables of one zone (largest first) whose seats add up, preferring the
 * fewest empty seats on a tie. null = no room.
 */
export function suggestTables(free: TableInfo[], partySize: number, zone?: string | null): TableInfo[] | null {
  const pool = zone ? free.filter((t) => t.zone === zone) : free;
  const single = pool.filter((t) => t.seats >= partySize).sort((a, b) => a.seats - b.seats)[0];
  if (single) return [single];
  const byZone = new Map<string, TableInfo[]>();
  for (const t of pool) byZone.set(t.zone ?? "", [...(byZone.get(t.zone ?? "") ?? []), t]);
  let best: TableInfo[] | null = null;
  for (const group of byZone.values()) {
    const picked: TableInfo[] = [];
    let seats = 0;
    for (const t of [...group].sort((a, b) => b.seats - a.seats)) {
      if (seats >= partySize) break;
      picked.push(t); seats += t.seats;
    }
    if (seats < partySize) continue;
    // Fewer tables first, then fewer empty seats.
    const bestSeats = best?.reduce((n, t) => n + t.seats, 0) ?? Infinity;
    if (!best || picked.length < best.length || (picked.length === best.length && seats < bestSeats)) best = picked;
  }
  return best;
}
