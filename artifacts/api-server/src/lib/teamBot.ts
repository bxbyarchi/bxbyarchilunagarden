/**
 * Telegram for the team: tasks and money requests from the chat.
 * Uses exactly the same service functions (and permission checks) as the web app.
 * Plain text everywhere — task titles and comments come from people and would break Markdown.
 */
import type { Context, Telegraf } from "telegraf";
import { db, usersTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { saveBuffer } from "./files";
import { APPROVERS, CASHIERS } from "./moneyMath";
import { parseLine, parseAmount } from "./teamBotParse";
import {
  TASK_ADMIN, HttpError as TaskError, listTasks, taskSummary, detail as taskDetail, createTask, updateTask, setTaskStatus, commentTask, type Ctx as TaskCtx,
} from "../routes/tasks";
import {
  HttpError as MoneyError, listMoney, moneySummary, detail as moneyDetail, createMoney, moneyAction, commentMoney, type Ctx as MoneyCtx,
} from "../routes/money";

export const TEAM_BTN = { TASKS: "📋 Задачи", MONEY: "💰 Деньги" } as const;

type Line = { name: string; amount: number; file: string | null };
type State =
  | { flow: "task_title" }
  | { flow: "task_assignee"; title: string }
  | { flow: "task_due"; title: string; staffId: number | null }
  | { flow: "task_note"; taskId: number; then: "comment" | "in_progress" | "cancelled" }
  | { flow: "money_amount"; kind: "advance" | "reimbursement" }
  | { flow: "money_title"; kind: "advance" | "reimbursement"; amount: number }
  | { flow: "money_receipt"; amount: number; title: string }
  | { flow: "money_reason"; id: number; action: "reject" | "return_report" | "cancel" }
  | { flow: "money_comment"; id: number }
  | { flow: "report"; id: number; lines: Line[] };
const state = new Map<number, State>();

type Btn = { text: string; callback_data: string };
type Kb = { inline_keyboard: Btn[][] };
const kb = (rows: Btn[][]): { reply_markup: Kb } => ({ reply_markup: { inline_keyboard: rows.filter((r) => r.length) } });
const b = (text: string, data: string): Btn => ({ text: text.length > 60 ? `${text.slice(0, 57)}…` : text, callback_data: data });
const money = (n: number | null | undefined) => `${Math.round(Number(n ?? 0)).toLocaleString("ru-RU")} сом`;
const TZ = "Asia/Bishkek";
const dt = (d: string | Date | null) => (d ? new Date(d).toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "без срока");

// ─── Who is writing ─────────────────────────────────────────────────────────

async function account(chatId: number) {
  const u = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramChatId, String(chatId)) });
  if (!u || !u.isActive) return null;
  const [s] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.userClerkId, u.clerkUserId));
  const base = { userId: u.clerkUserId, role: u.role, locationId: u.locationId ?? null, myStaffId: s?.id ?? null };
  return {
    user: u,
    task: { ...base, isAdmin: TASK_ADMIN.includes(u.role) } as TaskCtx,
    money: { ...base, seesAll: APPROVERS.includes(u.role) || CASHIERS.includes(u.role) } as MoneyCtx,
  };
}
type Acc = NonNullable<Awaited<ReturnType<typeof account>>>;

/** Reply, or edit the message the button sits on (keeps the chat tidy). */
async function show(ctx: Context, text: string, extra: { reply_markup: Kb }, edit: boolean) {
  if (edit) {
    try { await ctx.editMessageText(text, extra); return; } catch { /* message too old or unchanged — send a new one */ }
  }
  await ctx.reply(text, extra);
}
async function fail(ctx: Context, e: unknown) {
  if (e instanceof TaskError || e instanceof MoneyError) { await ctx.reply(`⛔ ${e.message}`); return; }
  logger.error({ err: e }, "team bot error");
  await ctx.reply("Что-то пошло не так. Попробуйте ещё раз или откройте CRM.");
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

const T_STATUS: Record<string, string> = { new: "Новая", in_progress: "В работе", review: "На проверке", done: "Выполнена", cancelled: "Отменена" };
const T_PRIO: Record<string, string> = { low: "низкий", normal: "обычный", high: "высокий", urgent: "СРОЧНО" };

async function tasksMenu(ctx: Context, a: Acc, edit = false) {
  const s = await taskSummary(a.task);
  const mine = a.task.myStaffId ? (await listTasks(a.task, { query: { view: "mine", status: "open" } })) as { id: number; title: string; dueAt: Date | null; overdue: boolean; status: string }[] : [];
  const lines = [`📋 Задачи`];
  if (!s.hasStaffCard) lines.push("", "Ваш аккаунт не привязан к карточке сотрудника — назначать вам задачи нельзя. Попросите управляющего привязать его в разделе «Сотрудники».");
  else lines.push("", mine.length ? `Открытых у вас: ${mine.length}${s.myOverdue ? `, просрочено: ${s.myOverdue}` : ""}` : "У вас нет открытых задач 🎉");
  const rows: Btn[][] = mine.slice(0, 15).map((t) => [b(`${t.overdue ? "⚠️ " : t.status === "review" ? "⏳ " : t.status === "in_progress" ? "▶️ " : "• "}${t.title} · ${dt(t.dueAt)}`, `tk:${t.id}`)]);
  if (s.toReview) rows.push([b(`🔎 Проверить выполненные (${s.toReview})`, "tkl:review")]);
  rows.push([b("📤 Поставленные мной", "tkl:created"), b("➕ Новая задача", "tknew")]);
  await show(ctx, lines.join("\n"), kb(rows), edit);
}

async function taskList(ctx: Context, a: Acc, view: "review" | "created") {
  const list = (await listTasks(a.task, { query: { view, status: "open" } })) as { id: number; title: string; dueAt: Date | null; overdue: boolean; assigneeName: string | null; status: string }[];
  const title = view === "review" ? "🔎 Ждут вашей проверки" : "📤 Поставленные вами (открытые)";
  const rows = list.slice(0, 20).map((t) => [b(`${t.overdue ? "⚠️ " : ""}${t.title} — ${t.assigneeName ?? "без исполнителя"}${view === "created" ? ` · ${T_STATUS[t.status]}` : ""}`, `tk:${t.id}`)]);
  rows.push([b("⬅️ Мои задачи", "tkmenu")]);
  await show(ctx, list.length ? title : `${title}: пусто`, kb(rows), true);
}

async function taskCard(ctx: Context, a: Acc, id: number, edit: boolean) {
  const t = await taskDetail(id, a.task);
  const done = t.checklist.filter((c) => c.done).length;
  const text = [
    `📋 ${t.title}`,
    `Статус: ${T_STATUS[t.status]} · приоритет ${T_PRIO[t.priority] ?? t.priority}`,
    `Срок: ${dt(t.dueAt)}${t.overdue ? " ⚠️ просрочено" : ""}`,
    `Исполнитель: ${t.assigneeName ?? "не назначен"} · поставил(а): ${t.creatorName}`,
    t.zone ? `Где: ${t.zone}` : "",
    t.description ? `\n${t.description}` : "",
    t.checklist.length ? `\nЧек-лист ${done}/${t.checklist.length}` : "",
    ...t.events.filter((e) => e.kind === "comment").slice(-3).map((e) => `💬 ${e.authorName}: ${e.text}`),
  ].filter(Boolean).join("\n");
  const open = ["new", "in_progress", "review"].includes(t.status);
  const rows: Btn[][] = [];
  if (t.can.checklist && open) t.checklist.forEach((c, i) => rows.push([b(`${c.done ? "✅" : "⬜"} ${c.text}`, `tkc:${id}:${i}`)]));
  const tr = new Set(t.can.transitions);
  const boss = t.me.isAdmin || t.me.isCreator;
  const act: Btn[] = [];
  if (t.status === "new" && tr.has("in_progress") && t.me.isAssignee) act.push(b("▶️ Взять в работу", `tks:${id}:in_progress`));
  if (["new", "in_progress"].includes(t.status) && t.me.isAssignee && t.needsReview && tr.has("review")) act.push(b("✅ Готово — на проверку", `tks:${id}:review`));
  if (["new", "in_progress"].includes(t.status) && !t.needsReview && tr.has("done") && (t.me.isAssignee || boss)) act.push(b("✅ Выполнено", `tks:${id}:done`));
  if (t.status === "review" && boss && tr.has("done")) act.push(b("👍 Принять", `tks:${id}:done`));
  if (t.status === "review" && boss && !t.me.isAssignee && tr.has("in_progress")) act.push(b("↩️ Вернуть", `tkn:${id}:in_progress`));
  if (act.length) rows.push(act);
  const more: Btn[] = [b("💬 Комментарий", `tkn:${id}:comment`)];
  if (open && boss) more.push(b("✖️ Отменить", `tkn:${id}:cancelled`));
  rows.push(more, [b("⬅️ Мои задачи", "tkmenu")]);
  await show(ctx, text, kb(rows), edit);
}

const DUE: Record<string, [string, () => Date | null]> = {
  today: ["Сегодня 18:00", () => at(0, 18)], tomorrow: ["Завтра 12:00", () => at(1, 12)], d3: ["Через 3 дня", () => at(3, 18)], week: ["Через неделю", () => at(7, 18)], none: ["Без срока", () => null],
};
function at(days: number, hour: number) {
  const local = new Date(Date.now() + 6 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour - 6, 0));
}

async function assigneePicker(ctx: Context, a: Acc, title: string) {
  const staff = await db.select({ id: staffTable.id, name: staffTable.name }).from(staffTable).where(eq(staffTable.isActive, true)).orderBy(staffTable.name);
  const others = staff.filter((s) => s.id !== a.task.myStaffId).slice(0, 30);
  const rows: Btn[][] = [];
  if (a.task.myStaffId) rows.push([b("🙋 Себе", `tka:${a.task.myStaffId}`)]);
  for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2).map((s) => b(s.name, `tka:${s.id}`)));
  rows.push([b("Без исполнителя", "tka:0")]);
  state.set(ctx.chat!.id, { flow: "task_assignee", title });
  await ctx.reply(`Кому поручить «${title}»?`, kb(rows));
}

// ─── Money ──────────────────────────────────────────────────────────────────

const M_KIND: Record<string, string> = { advance: "Под отчёт", payment: "Оплата по счёту", reimbursement: "Компенсация" };
const M_STATUS: Record<string, string> = { pending: "на согласовании", approved: "согласовано", issued: "выдано, ждём отчёт", reported: "отчёт на проверке", closed: "закрыто", rejected: "отклонено", cancelled: "отменено" };
type MRow = { id: number; kind: string; status: string; title: string; amountRequested: number; amountApproved: number | null; amountIssued: number | null; staffName: string | null; counterpartyName: string | null; reportOverdue: boolean };

async function moneyMenu(ctx: Context, a: Acc, edit = false) {
  const s = await moneySummary(a.money);
  const mine = (await listMoney(a.money, { query: { view: "mine", status: "open" } })) as MRow[];
  const lines = ["💰 Деньги", ""];
  lines.push(mine.length ? `Ваши открытые запросы: ${mine.length}` : "Открытых запросов нет");
  if (s.myToReport?.count) lines.push(`🧾 Нужно отчитаться: ${s.myToReport.count} на ${money(s.myToReport.sum)}`);
  const rows: Btn[][] = mine.slice(0, 10).map((r) => [b(`${r.reportOverdue ? "⚠️ " : ""}№${r.id} ${r.title} · ${money(r.amountIssued ?? r.amountApproved ?? r.amountRequested)} · ${M_STATUS[r.status]}`, `mr:${r.id}`)]);
  rows.push([b("➕ Под отчёт", "mrnew:advance"), b("➕ Компенсация по чеку", "mrnew:reimbursement")]);
  if (s.toApprove?.count) rows.push([b(`✅ Согласовать (${s.toApprove.count} · ${money(s.toApprove.sum)})`, "mrl:approve")]);
  if (s.toPay?.count || s.toCheck?.count) rows.push([b(`💸 Выдать/оплатить (${s.toPay?.count ?? 0})`, "mrl:pay"), b(`🧾 Отчёты (${s.toCheck?.count ?? 0})`, "mrl:check")]);
  await show(ctx, lines.join("\n"), kb(rows), edit);
}

async function moneyList(ctx: Context, a: Acc, which: "approve" | "pay" | "check") {
  const all = (await listMoney(a.money, { query: { view: which === "approve" ? "approve" : "accounting" } })) as MRow[];
  const list = which === "approve" ? all : all.filter((r) => (which === "pay" ? r.status === "approved" : r.status === "reported"));
  const title = { approve: "✅ На согласование", pay: "💸 К выдаче и оплате", check: "🧾 Отчёты на проверке" }[which];
  const rows = list.slice(0, 20).map((r) => [b(`№${r.id} ${r.title} · ${money(r.amountApproved ?? r.amountRequested)} · ${r.kind === "payment" ? r.counterpartyName ?? "счёт" : r.staffName ?? ""}`, `mr:${r.id}`)]);
  rows.push([b("⬅️ Деньги", "mrmenu")]);
  await show(ctx, list.length ? title : `${title}: пусто`, kb(rows), true);
}

async function moneyCard(ctx: Context, a: Acc, id: number, edit: boolean) {
  const r = await moneyDetail(id, a.money);
  const text = [
    `💰 №${r.id} · ${M_KIND[r.kind]} · ${M_STATUS[r.status]}`,
    r.title,
    `Запросил(а): ${r.requesterName}${r.kind === "payment" ? ` · получатель: ${r.counterpartyName ?? "в описании"}` : ` · кому: ${r.staffName ?? "—"}`}`,
    `Сумма: ${money(r.amountRequested)}${r.amountApproved != null && r.amountApproved !== r.amountRequested ? ` → согласовано ${money(r.amountApproved)}` : ""}${r.amountIssued != null ? ` · выдано ${money(r.amountIssued)}` : ""}`,
    r.purpose ?? "",
    r.estimate.length ? `Смета:\n${r.estimate.map((l) => `• ${l.name} — ${l.qty} ${l.unit} × ${money(l.price)}`).join("\n")}` : "",
    r.report.length ? `${r.kind === "advance" ? "Отчёт" : "Чеки"}:\n${r.report.map((l) => `• ${l.name} — ${money(l.amount)}${l.file ? " 📎" : " (без чека)"}`).join("\n")}\nИтого: ${money(r.amountSpent)}` : "",
    r.status === "reported" && r.amountIssued != null ? (r.amountIssued - (r.amountSpent ?? 0) >= 0 ? `Остаток к возврату: ${money(r.amountIssued - (r.amountSpent ?? 0))}` : `Перерасход: ${money((r.amountSpent ?? 0) - r.amountIssued)}`) : "",
    r.status === "closed" && r.settlement ? (r.settlement > 0 ? `Остаток ${money(r.settlement)} возвращён в кассу` : `Перерасход ${money(-r.settlement)} выплачен`) : "",
    r.reportOverdue ? "⚠️ Отчёт просрочен" : "",
    ...r.events.filter((e) => e.kind === "comment").slice(-3).map((e) => `💬 ${e.authorName}: ${e.text}`),
  ].filter(Boolean).join("\n");
  const has = (x: string) => r.actions.includes(x as never);
  const rows: Btn[][] = [];
  if (has("approve")) rows.push([b("✅ Согласовать", `mra:${id}:approve`), b("❌ Отклонить", `mrn:${id}:reject`)]);
  if (has("issue")) rows.push([b("💵 Выдать наличными", `mra:${id}:issue:cash`), b("Переводом", `mra:${id}:issue:transfer`)]);
  if (has("pay")) rows.push([b("💸 Оплачено переводом", `mra:${id}:pay:transfer`), b("Наличными", `mra:${id}:pay:cash`)]);
  if (has("report")) rows.push([b("🧾 Отчитаться чеками", `mrrep:${id}`)]);
  if (has("close")) rows.push([b("👍 Принять отчёт", `mra:${id}:close`), b("↩️ Вернуть", `mrn:${id}:return_report`)]);
  const more: Btn[] = [b("💬 Комментарий", `mrc:${id}`)];
  if (has("cancel")) more.push(b("✖️ Отменить", r.requesterClerkId === a.money.userId ? `mra:${id}:cancel` : `mrn:${id}:cancel`));
  rows.push(more, [b("⬅️ Деньги", "mrmenu")]);
  await show(ctx, text, kb(rows), edit);
}

function reportText(id: number, lines: Line[]) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return [`🧾 Отчёт по запросу №${id}`, "",
    "Отправляйте чеки по одному: фото с подписью «Название сумма» или просто текстом «Мука 450». Фото без подписи прикрепится к последней строке без чека.", "",
    ...(lines.length ? lines.map((l, i) => `${i + 1}. ${l.name} — ${money(l.amount)}${l.file ? " 📎" : ""}`) : ["Пока пусто"]),
    lines.length ? `\nИтого: ${money(total)}` : ""].join("\n");
}
const reportKb = (lines: Line[]) => kb([[b("✅ Сдать отчёт", "mrrdone"), b("↩️ Убрать последнюю", "mrrundo")], [b("✖️ Отмена", "mrrcancel")]]);
async function downloadPhoto(ctx: Context, fileId: string): Promise<string> {
  const link = await ctx.telegram.getFileLink(fileId);
  const r = await fetch(link.href);
  if (!r.ok) throw new Error(`telegram file ${r.status}`);
  return saveBuffer("money", Buffer.from(await r.arrayBuffer()), "jpg");
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

export function registerTeamBot(bot: Telegraf) {
  // Runs before the warehouse bot's handlers: anything not ours goes on via next().
  const guard = async (ctx: Context, fn: (a: Acc) => Promise<void>) => {
    const a = await account(ctx.chat!.id);
    if (!a) { await ctx.reply("Сначала войдите: отправьте /start."); return; }
    try { await fn(a); } catch (e) { await fail(ctx, e); }
  };
  const cb = (re: RegExp, fn: (ctx: Context & { match: RegExpExecArray }, a: Acc) => Promise<void>) =>
    bot.action(re, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await guard(ctx, (a) => fn(ctx as Context & { match: RegExpExecArray }, a)); });

  bot.command("tasks", (ctx) => guard(ctx, (a) => tasksMenu(ctx, a)));
  bot.command("money", (ctx) => guard(ctx, (a) => moneyMenu(ctx, a)));
  bot.hears(/^\/t(\d+)$/, (ctx) => guard(ctx, (a) => taskCard(ctx, a, Number(ctx.match[1]), false)));
  bot.hears(/^\/m(\d+)$/, (ctx) => guard(ctx, (a) => moneyCard(ctx, a, Number(ctx.match[1]), false)));

  // Tasks
  cb(/^tkmenu$/, (ctx, a) => tasksMenu(ctx, a, true));
  cb(/^tkl:(review|created)$/, (ctx, a) => taskList(ctx, a, ctx.match[1] as "review" | "created"));
  cb(/^tk:(\d+)$/, (ctx, a) => taskCard(ctx, a, Number(ctx.match[1]), true));
  cb(/^tkc:(\d+):(\d+)$/, async (ctx, a) => {
    const id = Number(ctx.match[1]), i = Number(ctx.match[2]);
    const t = await taskDetail(id, a.task);
    await updateTask(a.task, { params: { id }, body: { checklist: t.checklist.map((c, k) => (k === i ? { ...c, done: !c.done } : c)) } });
    await taskCard(ctx, a, id, true);
  });
  cb(/^tks:(\d+):(in_progress|review|done)$/, async (ctx, a) => {
    const id = Number(ctx.match[1]);
    await setTaskStatus(a.task, { params: { id }, body: { to: ctx.match[2] } });
    await taskCard(ctx, a, id, true);
  });
  cb(/^tkn:(\d+):(comment|in_progress|cancelled)$/, async (ctx, a) => {
    state.set(ctx.chat!.id, { flow: "task_note", taskId: Number(ctx.match[1]), then: ctx.match[2] as "comment" });
    await ctx.reply(ctx.match[2] === "comment" ? "Напишите комментарий:" : ctx.match[2] === "in_progress" ? "Что нужно исправить?" : "Почему отменяете?", kb([[b("✖️ Отмена", "teamcancel")]]));
  });
  cb(/^tknew$/, async (ctx) => { state.set(ctx.chat!.id, { flow: "task_title" }); await ctx.reply("Что нужно сделать? Напишите одним сообщением.", kb([[b("✖️ Отмена", "teamcancel")]])); });
  cb(/^tka:(\d+)$/, async (ctx) => {
    const st = state.get(ctx.chat!.id);
    if (st?.flow !== "task_assignee") return;
    state.set(ctx.chat!.id, { flow: "task_due", title: st.title, staffId: Number(ctx.match[1]) || null });
    await show(ctx, "Срок?", kb([[b(DUE.today[0], "tkd:today"), b(DUE.tomorrow[0], "tkd:tomorrow")], [b(DUE.d3[0], "tkd:d3"), b(DUE.week[0], "tkd:week")], [b(DUE.none[0], "tkd:none")]]), true);
  });
  cb(/^tkd:(today|tomorrow|d3|week|none)$/, async (ctx, a) => {
    const st = state.get(ctx.chat!.id);
    if (st?.flow !== "task_due") return;
    state.delete(ctx.chat!.id);
    const r = (await createTask(a.task, { body: { title: st.title, assigneeStaffId: st.staffId, dueAt: DUE[ctx.match[1]][1]()?.toISOString() ?? null, priority: "normal" } })) as { id: number };
    await show(ctx, `✅ Задача поставлена: ${st.title}`, kb([]), true);
    await taskCard(ctx, a, r.id, false);
  });

  // Money
  cb(/^mrmenu$/, (ctx, a) => moneyMenu(ctx, a, true));
  cb(/^mrl:(approve|pay|check)$/, (ctx, a) => moneyList(ctx, a, ctx.match[1] as "approve"));
  cb(/^mr:(\d+)$/, (ctx, a) => moneyCard(ctx, a, Number(ctx.match[1]), true));
  cb(/^mrnew:(advance|reimbursement)$/, async (ctx) => {
    state.set(ctx.chat!.id, { flow: "money_amount", kind: ctx.match[1] as "advance" });
    await ctx.reply(ctx.match[1] === "advance" ? "Сколько нужно под отчёт? Напишите сумму в сомах." : "Сколько вы потратили? Напишите сумму по чеку.", kb([[b("✖️ Отмена", "teamcancel")]]));
  });
  cb(/^mra:(\d+):(approve|cancel|close|issue|pay)(?::(cash|transfer))?$/, async (ctx, a) => {
    const id = Number(ctx.match[1]);
    await moneyAction(a.money, { params: { id }, body: { action: ctx.match[2], payMethod: ctx.match[3] } });
    await moneyCard(ctx, a, id, true);
  });
  cb(/^mrn:(\d+):(reject|return_report|cancel)$/, async (ctx) => {
    state.set(ctx.chat!.id, { flow: "money_reason", id: Number(ctx.match[1]), action: ctx.match[2] as "reject" });
    await ctx.reply(ctx.match[2] === "return_report" ? "Что не так с отчётом?" : "Укажите причину:", kb([[b("✖️ Отмена", "teamcancel")]]));
  });
  cb(/^mrc:(\d+)$/, async (ctx) => { state.set(ctx.chat!.id, { flow: "money_comment", id: Number(ctx.match[1]) }); await ctx.reply("Напишите комментарий:", kb([[b("✖️ Отмена", "teamcancel")]])); });
  cb(/^mrrep:(\d+)$/, async (ctx, a) => {
    const id = Number(ctx.match[1]);
    const r = await moneyDetail(id, a.money);
    if (!r.actions.includes("report")) { await ctx.reply("По этому запросу сейчас нельзя отчитаться."); return; }
    const lines = r.report.map((l) => ({ name: l.name, amount: l.amount, file: l.file }));
    state.set(ctx.chat!.id, { flow: "report", id, lines });
    await ctx.reply(reportText(id, lines), reportKb(lines));
  });
  cb(/^mrrundo$/, async (ctx) => {
    const st = state.get(ctx.chat!.id);
    if (st?.flow !== "report") return;
    st.lines.pop();
    await show(ctx, reportText(st.id, st.lines), reportKb(st.lines), true);
  });
  cb(/^mrrcancel$/, async (ctx) => { state.delete(ctx.chat!.id); await show(ctx, "Отчёт не отправлен. Его можно сдать позже: /money", kb([]), true); });
  cb(/^mrrdone$/, async (ctx, a) => {
    const st = state.get(ctx.chat!.id);
    if (st?.flow !== "report") return;
    if (!st.lines.length) { await ctx.reply("Добавьте хотя бы один чек."); return; }
    await moneyAction(a.money, { params: { id: st.id }, body: { action: "report", report: st.lines } });
    state.delete(ctx.chat!.id);
    await show(ctx, "✅ Отчёт отправлен бухгалтеру.", kb([]), true);
    await moneyCard(ctx, a, st.id, false);
  });
  cb(/^mrnochk$/, async (ctx, a) => {
    const st = state.get(ctx.chat!.id);
    if (st?.flow !== "money_receipt") return;
    state.delete(ctx.chat!.id);
    const r = (await createMoney(a.money, { body: { kind: "reimbursement", title: st.title, report: [{ name: st.title, amount: st.amount, file: null }] } })) as { id: number };
    await moneyCard(ctx, a, r.id, false);
  });
  cb(/^teamcancel$/, async (ctx) => { state.delete(ctx.chat!.id); await show(ctx, "Отменено.", kb([]), true); });

  bot.on("photo", async (ctx, next) => {
    const st = state.get(ctx.chat.id);
    if (st?.flow !== "report" && st?.flow !== "money_receipt") return next();
    await guard(ctx, async (a) => {
      const file = await downloadPhoto(ctx, ctx.message.photo[ctx.message.photo.length - 1].file_id);
      if (st.flow === "money_receipt") {
        state.delete(ctx.chat.id);
        const r = (await createMoney(a.money, { body: { kind: "reimbursement", title: st.title, report: [{ name: st.title, amount: st.amount, file }] } })) as { id: number };
        await ctx.reply("✅ Запрос на компенсацию отправлен на согласование.");
        await moneyCard(ctx, a, r.id, false);
        return;
      }
      const parsed = ctx.message.caption ? parseLine(ctx.message.caption) : null;
      if (parsed) st.lines.push({ ...parsed, file });
      else {
        const target = [...st.lines].reverse().find((l) => !l.file);
        if (target) target.file = file;
        else { await ctx.reply("Подпишите фото: «Название сумма», например «Мука 450»."); return; }
      }
      await ctx.reply(reportText(st.id, st.lines), reportKb(st.lines));
    });
  });

  bot.on("text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat.id;
    if (text === TEAM_BTN.TASKS) { state.delete(chatId); return guard(ctx, (a) => tasksMenu(ctx, a)); }
    if (text === TEAM_BTN.MONEY) { state.delete(chatId); return guard(ctx, (a) => moneyMenu(ctx, a)); }
    const st = state.get(chatId);
    if (!st || text.startsWith("/")) return next();
    await guard(ctx, async (a) => {
      switch (st.flow) {
        case "task_title":
          if (text.length > 200) { await ctx.reply("Слишком длинно — до 200 символов. Подробности можно добавить в CRM."); return; }
          await assigneePicker(ctx, a, text); return;
        case "task_note": {
          state.delete(chatId);
          if (st.then === "comment") await commentTask(a.task, { params: { id: st.taskId }, body: { text } });
          else await setTaskStatus(a.task, { params: { id: st.taskId }, body: { to: st.then, comment: text } });
          await taskCard(ctx, a, st.taskId, false); return;
        }
        case "money_amount": {
          const amount = parseAmount(text);
          if (!amount) { await ctx.reply("Напишите сумму числом, например 2500."); return; }
          state.set(chatId, { flow: "money_title", kind: st.kind, amount });
          await ctx.reply(st.kind === "advance" ? "На что нужны деньги?" : "Что купили?"); return;
        }
        case "money_title":
          if (st.kind === "advance") {
            state.delete(chatId);
            const r = (await createMoney(a.money, { body: { kind: "advance", title: text, amount: st.amount } })) as { id: number };
            await ctx.reply("✅ Запрос отправлен на согласование.");
            await moneyCard(ctx, a, r.id, false);
          } else {
            state.set(chatId, { flow: "money_receipt", amount: st.amount, title: text });
            await ctx.reply("Сфотографируйте чек и отправьте сюда.", kb([[b("Чека нет", "mrnochk"), b("✖️ Отмена", "teamcancel")]]));
          }
          return;
        case "money_reason":
          state.delete(chatId);
          await moneyAction(a.money, { params: { id: st.id }, body: { action: st.action, comment: text } });
          await moneyCard(ctx, a, st.id, false); return;
        case "money_comment":
          state.delete(chatId);
          await commentMoney(a.money, { params: { id: st.id }, body: { text } });
          await moneyCard(ctx, a, st.id, false); return;
        case "report": {
          const p = parseLine(text);
          if (!p || !(p.amount > 0)) { await ctx.reply("Не понял. Напишите «Название сумма», например «Сливки 1640»."); return; }
          st.lines.push({ ...p, file: null });
          await ctx.reply(reportText(st.id, st.lines), reportKb(st.lines)); return;
        }
        default: return;
      }
    });
  });
}
