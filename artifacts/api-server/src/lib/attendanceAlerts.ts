/**
 * Telegram alerts from the schedule: someone did not check in for a shift that has started,
 * or forgot to check out long after the shift ended. Each alert is sent once.
 */
import { db, staffTable, staffSchedulesTable, attendanceTable } from "@workspace/db";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { planWindow, addDays } from "./timesheet";
import { toLocal } from "./ai/helpers";
import { notifyStaff, notifyUsers } from "./telegramBot";
import { logger } from "./logger";

export const NO_SHOW_GRACE_MIN = 15;
export const CHECKOUT_REMIND_AFTER_MIN = 120;
const MANAGERS = ["super_admin", "manager", "location_admin"];

type Plan = { id: number; staffId: number; date: string; startTime: string; endTime: string; noShowNotifiedAt: Date | null };
type Presence = { staffId: number; checkInAt: Date; checkOutAt: Date | null };

/** Shifts that started more than `grace` minutes ago, are still running, have no check-in and no alert yet. */
export function findNoShows(plans: Plan[], presence: Presence[], now: Date, graceMin = NO_SHOW_GRACE_MIN) {
  const out: { plan: Plan; start: Date; end: Date; lateMin: number }[] = [];
  for (const p of plans) {
    if (p.noShowNotifiedAt) continue;
    const w = planWindow(p.date, p.startTime, p.endTime);
    if (!w) continue;
    const late = (now.getTime() - w.start.getTime()) / 60_000;
    if (late < graceMin || now >= w.end) continue;
    // Any presence that began up to 4h before the shift and is open or ends after its start counts.
    const came = presence.some((a) => a.staffId === p.staffId && a.checkInAt.getTime() >= w.start.getTime() - 4 * 3600_000 && a.checkInAt <= now && (!a.checkOutAt || a.checkOutAt > w.start));
    if (!came) out.push({ plan: p, start: w.start, end: w.end, lateMin: Math.floor(late) });
  }
  return out;
}

/** Open check-ins whose shift (or, without a shift, 14 h) ended more than `afterMin` ago. */
export function findForgottenCheckouts(open: (Presence & { id: number; checkoutRemindedAt: Date | null })[], plans: Plan[], now: Date, afterMin = CHECKOUT_REMIND_AFTER_MIN) {
  return open.filter((a) => {
    if (a.checkOutAt || a.checkoutRemindedAt) return false;
    const plan = plans.map((p) => ({ p, w: planWindow(p.date, p.startTime, p.endTime) }))
      .find(({ p, w }) => p.staffId === a.staffId && w && a.checkInAt.getTime() >= w.start.getTime() - 4 * 3600_000 && a.checkInAt < w.end);
    const end = plan?.w ? plan.w.end : new Date(a.checkInAt.getTime() + 14 * 3600_000);
    return now.getTime() - end.getTime() >= afterMin * 60_000;
  });
}

const hm = (d: Date) => toLocal(d).time;

export async function checkAttendance(now = new Date()) {
  const today = toLocal(now).date;
  const plans = await db.select().from(staffSchedulesTable).where(inArray(staffSchedulesTable.date, [addDays(today, -1), today]));
  const staff = new Map((await db.select({ id: staffTable.id, name: staffTable.name, account: staffTable.userClerkId, isActive: staffTable.isActive }).from(staffTable)).map((s) => [s.id, s]));
  const recent = await db.select({ id: attendanceTable.id, staffId: attendanceTable.staffId, checkInAt: attendanceTable.checkInAt, checkOutAt: attendanceTable.checkOutAt, checkoutRemindedAt: attendanceTable.checkoutRemindedAt })
    .from(attendanceTable).where(gte(attendanceTable.checkInAt, new Date(now.getTime() - 3 * 86400_000)));

  for (const n of findNoShows(plans.filter((p) => staff.get(p.staffId)?.isActive), recent, now)) {
    const s = staff.get(n.plan.staffId)!;
    await db.update(staffSchedulesTable).set({ noShowNotifiedAt: now }).where(eq(staffSchedulesTable.id, n.plan.id));
    await notifyStaff(`⏰ ${s.name} не отметился(ась) на смену ${n.plan.startTime}–${n.plan.endTime} (прошло ${n.lateMin} мин).`, MANAGERS);
    await notifyUsers([s.account], `⏰ Ваша смена началась в ${n.plan.startTime}, а отметки прихода нет. Отметьтесь в киоске у входа — или напишите управляющему, если задерживаетесь.`);
  }

  const open = await db.select({ id: attendanceTable.id, staffId: attendanceTable.staffId, checkInAt: attendanceTable.checkInAt, checkOutAt: attendanceTable.checkOutAt, checkoutRemindedAt: attendanceTable.checkoutRemindedAt })
    .from(attendanceTable).where(and(isNull(attendanceTable.checkOutAt), isNull(attendanceTable.checkoutRemindedAt), lt(attendanceTable.checkInAt, now)));
  for (const a of findForgottenCheckouts(open, plans, now)) {
    const s = staff.get(a.staffId);
    if (!s) continue;
    await db.update(attendanceTable).set({ checkoutRemindedAt: now }).where(eq(attendanceTable.id, a.id));
    await notifyUsers([s.account], `🕘 Вы отметили приход в ${hm(a.checkInAt)}, но не отметили уход. Если смена закончилась — отметьтесь в киоске, иначе часы в табеле не посчитаются.`);
    await notifyStaff(`🕘 ${s.name} не отметил(а) уход (приход в ${hm(a.checkInAt)}). Проверьте и исправьте отметку в «Табеле».`, MANAGERS);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startAttendanceAlerts() {
  if (timer) return;
  timer = setInterval(() => { checkAttendance().catch((err) => logger.error({ err }, "attendance alerts failed")); }, 5 * 60_000);
  timer.unref();
}
