/** Pure helpers for the AI agent: restaurant-local time, deposit rule, cost. */

/** Kyrgyzstan is UTC+6 all year (no DST). */
export const TZ_OFFSET = "+06:00";
export const TZ_NAME = "Asia/Bishkek";

/** "2026-11-18" + "19:30" in restaurant time → Date. null when malformed. */
export function localDateTime(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const d = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${TZ_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → { date: "2026-11-18", time: "19:30", label: "ср, 18 ноября, 19:30" } in restaurant time. */
export function toLocal(d: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ_NAME, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const label = d.toLocaleString("ru-RU", { timeZone: TZ_NAME, weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, label };
}

/** Deposit for a party under the configured rule; 0 = no deposit. */
export function depositFor(partySize: number, minParty: number | null | undefined, perGuest: number | null | undefined): number {
  if (!minParty || !perGuest || perGuest <= 0 || partySize < minParty) return 0;
  return Math.round(partySize * perGuest);
}

/** USD per 1M tokens (input, output) for the models the agent may use. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
export const AGENT_MODELS = Object.keys(PRICES);

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [i, o] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return Math.round(((inputTokens * i + outputTokens * o) / 1_000_000) * 100000) / 100000;
}

/** Candidate times around a requested slot, nearest first (±2h, 30-minute steps). */
export function nearbyTimes(start: Date, stepMin = 30, spanMin = 120): Date[] {
  const out: Date[] = [];
  for (let k = 1; k * stepMin <= spanMin; k++) {
    out.push(new Date(start.getTime() - k * stepMin * 60_000), new Date(start.getTime() + k * stepMin * 60_000));
  }
  return out;
}
