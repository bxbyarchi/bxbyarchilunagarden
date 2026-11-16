export const DEPARTMENTS: Record<string, string> = {
  kitchen: "Кухня", bar: "Бар", pastry: "Кондитерка", hall: "Зал", admin: "Администрация", tech: "Техперсонал", other: "Другое",
};
export const PERSONNEL_ADMIN = ["super_admin", "warehouse_chief", "location_admin", "manager"];
export const PERSONNEL_VIEW = [...PERSONNEL_ADMIN, "accountant"];

/** 615 → "10 ч 15 мин" */
export function fmtMin(m: number | null | undefined): string {
  if (!m) return "—";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} ч ${r} мин` : `${h} ч`) : `${r} мин`;
}
export const fmtMoney = (v: number) => `${Math.round(v).toLocaleString("ru-RU")} сом`;
const TZ = "Asia/Bishkek";
export const fmtTime = (s: string | Date) => new Date(s).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
export const fmtDayTime = (s: string | Date) => new Date(s).toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
/** Today in restaurant time, yyyy-mm-dd. */
export const todayLocal = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
export function addDays(date: string, n: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function mondayOf(date: string) { const d = new Date(`${date}T00:00:00Z`); return addDays(date, -((d.getUTCDay() + 6) % 7)); }
/** "2026-11-16T10:00" local input value ↔ ISO in restaurant time. */
export const toInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 16) : "");
export const fromInput = (v: string) => (v ? `${v}:00+06:00` : null);
export const errMsg = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;
