/** Morning summary for the owner and managers in Telegram: yesterday's numbers and what needs attention today. */
import { db, staffTable, staffSchedulesTable, attendanceTable, tasksTable, moneyRequestsTable, itemsTable, bookingsTable } from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { gather } from "../routes/finance";
import { summarize, addDays, type PlanRow, type PresenceRow } from "./timesheet";
import { localDateTime, toLocal } from "./ai/helpers";
import { getSettings } from "./ai/agent";
import { notifyStaff } from "./telegramBot";
import { logger } from "./logger";

const fmt = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} сом`;
const dayRu = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
export const DIGEST_ROLES = ["super_admin", "manager"];
/** 1 гость, 2 гостя, 5 гостей. */
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

export function pctChange(now: number, before: number): string {
  if (!before) return "";
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? " (как неделю назад)" : ` (${d > 0 ? "+" : ""}${d}% к прошлой неделе)`;
}

export async function buildDigest(now = new Date()): Promise<string> {
  const today = toLocal(now).date, y = addDays(today, -1), weekAgo = addDays(y, -7);
  const [p, prev] = await Promise.all([gather(y, y), gather(weekAgo, weekAgo)]);
  const lines = [`☀️ Доброе утро! Сводка Luna Garden за ${dayRu(y)}`, ""];
  lines.push(p.revenue
    ? `💰 Выручка: ${fmt(p.revenue)}${pctChange(p.revenue, prev.revenue)}\n   чеков ${p.checks}, средний чек ${p.avgCheck ? fmt(p.avgCheck) : "—"}${p.foodCostPct != null ? `, фудкост ${p.foodCostPct}%` : ""}`
    : "💰 Продаж вчера не было (или касса не велась)");
  if (p.writeOffs) lines.push(`🗑 Списано на ${fmt(p.writeOffs)}`);

  // Staff yesterday: who did not come, who was late.
  const staff = await db.select({ id: staffTable.id, name: staffTable.name }).from(staffTable).where(eq(staffTable.isActive, true));
  const ids = staff.map((s) => s.id);
  if (ids.length) {
    const plans = await db.select().from(staffSchedulesTable).where(and(inArray(staffSchedulesTable.staffId, ids), eq(staffSchedulesTable.date, y)));
    if (plans.length) {
      const presence = await db.select().from(attendanceTable).where(and(gte(attendanceTable.checkInAt, new Date(localDateTime(y, "00:00")!.getTime() - 6 * 3600_000)), lt(attendanceTable.checkInAt, localDateTime(today, "06:00")!)));
      const ts = summarize(ids, plans as PlanRow[], presence as PresenceRow[], new Map(), { now });
      const name = new Map(staff.map((s) => [s.id, s.name]));
      const absent = ts.filter((t) => t.absences).map((t) => name.get(t.staffId));
      const late = ts.filter((t) => t.lateCount).map((t) => `${name.get(t.staffId)} (${t.lateMin} мин)`);
      lines.push(`👥 Смен по графику: ${plans.length}${absent.length ? `, не вышли: ${absent.join(", ")}` : ", все вышли"}${late.length ? `\n   опоздали: ${late.join(", ")}` : ""}`);
    }
  }

  const [tasks] = await db.select({
    overdue: sql<number>`count(*) FILTER (WHERE ${tasksTable.status} IN ('new','in_progress','review') AND ${tasksTable.dueAt} < now())::int`,
    review: sql<number>`count(*) FILTER (WHERE ${tasksTable.status} = 'review')::int`,
  }).from(tasksTable);
  if (tasks.overdue || tasks.review) lines.push(`📋 Задачи: просрочено ${tasks.overdue}, ждут проверки ${tasks.review}`);

  const [money] = await db.select({
    pending: sql<number>`count(*) FILTER (WHERE ${moneyRequestsTable.status} = 'pending')::int`,
    pendingSum: sql<string>`coalesce(sum(${moneyRequestsTable.amountRequested}) FILTER (WHERE ${moneyRequestsTable.status} = 'pending'), 0)`,
    advances: sql<string>`coalesce(sum(${moneyRequestsTable.amountIssued}) FILTER (WHERE ${moneyRequestsTable.kind} = 'advance' AND ${moneyRequestsTable.status} = 'issued'), 0)`,
    overdue: sql<number>`count(*) FILTER (WHERE ${moneyRequestsTable.kind} = 'advance' AND ${moneyRequestsTable.status} = 'issued' AND ${moneyRequestsTable.reportDueAt} < ${today})::int`,
  }).from(moneyRequestsTable);
  if (money.pending || Number(money.advances)) lines.push(`💸 Деньги: ждут согласования ${money.pending} на ${fmt(Number(money.pendingSum))}; под отчётом ${fmt(Number(money.advances))}${money.overdue ? `, просрочено отчётов: ${money.overdue}` : ""}`);

  const low = await db.select({ name: itemsTable.name }).from(itemsTable)
    .where(and(isNotNull(itemsTable.minThreshold), lte(itemsTable.currentStock, itemsTable.minThreshold))).limit(8);
  if (low.length) lines.push(`📦 Заканчивается: ${low.map((l) => l.name).join(", ")}${low.length === 8 ? "…" : ""}`);

  const [b] = await db.select({ n: sql<number>`count(*)::int`, guests: sql<number>`coalesce(sum(${bookingsTable.partySize}), 0)::int` }).from(bookingsTable)
    .where(and(gte(bookingsTable.startsAt, localDateTime(today, "00:00")!), lt(bookingsTable.startsAt, localDateTime(addDays(today, 1), "00:00")!), ne(bookingsTable.status, "cancelled")));
  lines.push(b.n ? `📅 Сегодня ${b.n} ${plural(b.n, "бронь", "брони", "броней")} (${b.guests} ${plural(b.guests, "гость", "гостя", "гостей")})` : "📅 На сегодня броней нет");
  lines.push("", "Подробнее — в CRM или спросите «🤖 Спросить ИИ».");
  return lines.join("\n");
}

let lastSent = "";
export async function maybeSendDigest(now = new Date()) {
  const s = await getSettings();
  if (s.digestHour == null) return;
  const l = toLocal(now);
  if (Number(l.time.slice(0, 2)) !== s.digestHour || lastSent === l.date) return;
  lastSent = l.date;
  await notifyStaff(await buildDigest(now), DIGEST_ROLES);
}

let timer: NodeJS.Timeout | null = null;
export function startDigest() {
  if (timer) return;
  timer = setInterval(() => { maybeSendDigest().catch((err) => logger.error({ err }, "digest failed")); }, 10 * 60_000);
  timer.unref();
}
