/**
 * Tools the AI agent may call. Every action is checked here, server-side:
 * the model only proposes; bookings go through the same service as the CRM,
 * and a guest can only see or change bookings bound to their own conversation.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { db, productsTable, techCardsTable, bookingsTable, guestsTable, aiConversationsTable, diningTablesTable, type AiConversation, type AiSettings } from "@workspace/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { checkAvailability, createBooking, updateBooking, setBookingStatus, findOrCreateGuest, BookingError, ACTIVE_STATUSES, notifyAboutBooking } from "../bookingService";
import { normalizePhone, formatPhone } from "../bookingMath";
import { notifyStaff } from "../telegramBot";
import { localDateTime, toLocal, depositFor, nearbyTimes } from "./helpers";

type Tool = Anthropic.Beta.BetaTool;
const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

export const AGENT_TOOLS: Tool[] = [
  {
    name: "get_menu",
    description: "Меню ресторана с ценами. Вызывай перед любым ответом о блюдах, напитках или ценах — не называй блюд и цен, которых нет в результате.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["query", "category"], properties: {
      query: nullable("string", "Часть названия блюда, или null"),
      category: nullable("string", "Категория меню (например «Горячее», «Коктейли»), или null — всё меню"),
    } },
  },
  {
    name: "check_availability",
    description: "Проверить, есть ли свободный стол на дату и время для компании. Если нет — вернёт ближайшее свободное время.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["date", "time", "party_size", "zone"], properties: {
      date: { type: "string", description: "Дата в формате ГГГГ-ММ-ДД (время ресторана)" },
      time: { type: "string", description: "Время ЧЧ:ММ" },
      party_size: { type: "integer", description: "Сколько гостей" },
      zone: nullable("string", "Пожелание по зоне (Зал, Веранда, VIP) или null"),
    } },
  },
  {
    name: "create_booking",
    description: "Создать бронь. Только после того, как гость подтвердил дату, время, число гостей, имя и телефон. Сумму предоплаты считает система — сообщи её гостю из результата.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["guest_name", "phone", "date", "time", "party_size", "occasion", "comment", "zone"], properties: {
      guest_name: { type: "string" },
      phone: { type: "string", description: "Телефон гостя, как он его написал" },
      date: { type: "string", description: "ГГГГ-ММ-ДД" },
      time: { type: "string", description: "ЧЧ:ММ" },
      party_size: { type: "integer" },
      occasion: nullable("string", "Повод (день рождения и т.п.) или null"),
      comment: nullable("string", "Пожелания (детский стул, торт, у окна) или null"),
      zone: nullable("string", "Зона или null"),
    } },
  },
  {
    name: "my_bookings",
    description: "Предстоящие брони этого гостя (только того, кто пишет в этом диалоге).",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "change_booking",
    description: "Перенести бронь гостя на другое время или изменить число гостей. Только для брони из my_bookings.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["booking_id", "date", "time", "party_size"], properties: {
      booking_id: { type: "integer" },
      date: nullable("string", "Новая дата ГГГГ-ММ-ДД или null"),
      time: nullable("string", "Новое время ЧЧ:ММ или null"),
      party_size: nullable("integer", "Новое число гостей или null"),
    } },
  },
  {
    name: "cancel_booking",
    description: "Отменить бронь гостя по его просьбе. Только для брони из my_bookings.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["booking_id", "reason"], properties: {
      booking_id: { type: "integer" },
      reason: nullable("string", "Причина со слов гостя или null"),
    } },
  },
  {
    name: "save_guest_note",
    description: "Записать в карточку гостя важное о нём: аллергии, предпочтения, любимый стол. Не записывай платёжные данные.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } },
  },
  {
    name: "escalate_to_manager",
    description: "Позвать менеджера: жалоба, просьба поговорить с человеком, банкет или большая компания, спор об оплате, вопрос, на который нет ответа в твоих данных. После вызова скажи гостю, что менеджер скоро ответит.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["reason", "kind", "urgent"], properties: {
      reason: { type: "string", description: "Коротко, что нужно гостю" },
      kind: { type: "string", enum: ["complaint", "large_event", "human_request", "other"] },
      urgent: { type: "boolean", description: "true — нужен ответ в ближайшие минуты" },
    } },
  },
];

export interface ToolContext {
  conversation: AiConversation;
  settings: AiSettings;
  /** Re-read after tools bind a guest, so later tools in the same turn see it. */
  setGuestId(id: number): void;
}

type ToolResult = { ok: boolean; text: string };
const ok = (data: unknown): ToolResult => ({ ok: true, text: JSON.stringify(data) });
const fail = (message: string): ToolResult => ({ ok: false, text: JSON.stringify({ error: message }) });

async function guestBookings(guestId: number) {
  const rows = await db.select().from(bookingsTable)
    .where(and(eq(bookingsTable.guestId, guestId), inArray(bookingsTable.status, [...ACTIVE_STATUSES]), gte(bookingsTable.startsAt, new Date(Date.now() - 3 * 3600_000))))
    .orderBy(asc(bookingsTable.startsAt));
  return rows.map((b) => ({ booking_id: b.id, when: toLocal(b.startsAt).label, date: toLocal(b.startsAt).date, time: toLocal(b.startsAt).time, guests: b.partySize, status: b.status, deposit: b.depositAmount ? { amount: Number(b.depositAmount), status: b.depositStatus } : null }));
}

async function ownBooking(ctx: ToolContext, id: number) {
  if (!ctx.conversation.guestId) return null;
  const b = await db.query.bookingsTable.findFirst({ where: and(eq(bookingsTable.id, id), eq(bookingsTable.guestId, ctx.conversation.guestId)) });
  return b && ACTIVE_STATUSES.includes(b.status as (typeof ACTIVE_STATUSES)[number]) ? b : null;
}

async function zonesOf(tableIds: number[]) {
  if (!tableIds.length) return [];
  const rows = await db.select({ zone: diningTablesTable.zone }).from(diningTablesTable).where(inArray(diningTablesTable.id, tableIds));
  return [...new Set(rows.map((r) => r.zone).filter(Boolean))];
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "get_menu": {
        const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
        const cat = typeof input.category === "string" ? input.category.trim().toLowerCase() : "";
        const rows = await db.select({ name: productsTable.name, category: productsTable.category, price: productsTable.price, output: techCardsTable.outputQty, unit: techCardsTable.outputUnit })
          .from(productsTable).leftJoin(techCardsTable, eq(productsTable.techCardId, techCardsTable.id))
          .where(eq(productsTable.isActive, true)).orderBy(asc(productsTable.category), asc(productsTable.sortOrder), asc(productsTable.name));
        const seen = new Set<string>();
        const items = rows.filter((r) => {
          const k = r.name.toLowerCase();
          if (seen.has(k)) return false; seen.add(k);
          return (!q || k.includes(q)) && (!cat || r.category.toLowerCase().includes(cat));
        }).slice(0, 120).map((r) => ({ name: r.name, category: r.category, price_som: Number(r.price), portion: r.output ? `${Number(r.output)} ${r.unit}` : null }));
        return ok(items.length ? { items } : { items: [], note: "Ничего не найдено — не придумывай блюдо, предложи посмотреть другие позиции или уточни у менеджера." });
      }

      case "check_availability": {
        const start = localDateTime(String(input.date), String(input.time));
        const party = Number(input.party_size);
        if (!start) return fail("Неверная дата или время");
        if (start.getTime() < Date.now()) return fail("Это время уже прошло");
        if (party > ctx.settings.maxPartyForAi) return fail(`Компании больше ${ctx.settings.maxPartyForAi} человек бронирует менеджер — вызови escalate_to_manager с kind=large_event`);
        const zone = typeof input.zone === "string" ? input.zone : null;
        const r = await checkAvailability({ startsAt: start, partySize: party, zone });
        const deposit = depositFor(party, ctx.settings.depositMinParty, ctx.settings.depositPerGuest ? Number(ctx.settings.depositPerGuest) : null);
        if (r.suggestion || !r.tables.length) {
          return ok({ available: true, when: toLocal(start).label, zones: [...new Set((r.suggestion ?? []).map((t) => t.zone).filter(Boolean))], deposit_som: deposit || null });
        }
        const alternatives: string[] = [];
        for (const t of nearbyTimes(start)) {
          if (t.getTime() < Date.now()) continue;
          const alt = await checkAvailability({ startsAt: t, partySize: party, zone });
          if (alt.suggestion) alternatives.push(toLocal(t).time);
          if (alternatives.length >= 3) break;
        }
        return ok({ available: false, when: toLocal(start).label, alternatives_same_day: alternatives });
      }

      case "create_booking": {
        const start = localDateTime(String(input.date), String(input.time));
        const party = Number(input.party_size);
        const phone = normalizePhone(input.phone);
        if (!start) return fail("Неверная дата или время");
        if (!phone) return fail("Номер телефона не распознан — переспроси номер");
        if (party > ctx.settings.maxPartyForAi) return fail(`Компании больше ${ctx.settings.maxPartyForAi} человек бронирует менеджер — вызови escalate_to_manager с kind=large_event`);
        // A conversation already tied to a guest can't book under somebody else's number.
        if (ctx.conversation.guestId) {
          const bound = await db.query.guestsTable.findFirst({ where: eq(guestsTable.id, ctx.conversation.guestId) });
          if (bound?.phone && bound.phone !== phone) return fail("В этом диалоге уже указан другой номер гостя. Уточни у гостя номер; бронь на чужой номер оформляет менеджер.");
        }
        const { guest } = await findOrCreateGuest({ name: String(input.guest_name), phone, source: ctx.conversation.channel, ...(ctx.conversation.channel === "instagram" ? { instagram: ctx.conversation.externalId } : {}) }, null);
        if (guest.isBlacklisted) {
          await markAttention(ctx, "other", "Гость из чёрного списка пытается забронировать", false);
          return fail("Бронь через чат для этого гостя недоступна — скажи, что менеджер свяжется с ним");
        }
        await bindGuest(ctx, guest.id);
        const deposit = depositFor(party, ctx.settings.depositMinParty, ctx.settings.depositPerGuest ? Number(ctx.settings.depositPerGuest) : null);
        const booking = await createBooking({
          guestId: guest.id, startsAt: start, partySize: party, zone: typeof input.zone === "string" ? input.zone : null,
          occasion: typeof input.occasion === "string" ? input.occasion : null, comment: typeof input.comment === "string" ? input.comment : null,
          depositAmount: deposit || null, channel: ctx.conversation.channel,
        }, "ai");
        return ok({
          booking_id: booking.id, when: toLocal(booking.startsAt).label, guests: booking.partySize, name: guest.name, phone: formatPhone(guest.phone),
          zones: await zonesOf(booking.tableIds),
          deposit: deposit ? { amount_som: deposit, how_to_pay: ctx.settings.paymentDetails ?? "реквизиты уточнит менеджер", rules: ctx.settings.depositRules } : null,
        });
      }

      case "my_bookings": {
        if (!ctx.conversation.guestId) return ok({ bookings: [], note: "Гость в этом диалоге ещё не определён. Попроси номер телефона, на который была бронь, и передай менеджеру — сам чужие брони не ищи." });
        return ok({ bookings: await guestBookings(ctx.conversation.guestId) });
      }

      case "change_booking": {
        const b = await ownBooking(ctx, Number(input.booking_id));
        if (!b) return fail("Бронь не найдена среди броней этого гостя");
        const cur = toLocal(b.startsAt);
        const start = (input.date || input.time) ? localDateTime(String(input.date ?? cur.date), String(input.time ?? cur.time)) : undefined;
        if (start === null) return fail("Неверная дата или время");
        if (start && start.getTime() < Date.now()) return fail("Это время уже прошло");
        const party = input.party_size != null ? Number(input.party_size) : undefined;
        if (party && party > ctx.settings.maxPartyForAi) return fail("Для такой компании нужен менеджер — escalate_to_manager");
        // Re-seat automatically: let the service pick tables for the new slot.
        const avail = await checkAvailability({ startsAt: start ?? b.startsAt, partySize: party ?? b.partySize, durationMin: b.durationMin, exceptBookingId: b.id });
        if (avail.tables.length && !avail.suggestion) return fail("На это время нет свободного стола — предложи другое время (check_availability)");
        const row = await updateBooking(b.id, { startsAt: start, partySize: party, tableIds: avail.suggestion?.map((t) => t.id) ?? undefined });
        void notifyAboutBooking(row.id, "Бронь изменена гостем через ИИ");
        return ok({ booking_id: row.id, when: toLocal(row.startsAt).label, guests: row.partySize });
      }

      case "cancel_booking": {
        const b = await ownBooking(ctx, Number(input.booking_id));
        if (!b) return fail("Бронь не найдена среди броней этого гостя");
        await setBookingStatus(b.id, "cancelled", `Гость через ${ctx.conversation.channel}: ${typeof input.reason === "string" ? input.reason : "без причины"}`);
        return ok({ cancelled: b.id, deposit_note: b.depositStatus === "paid" ? "Предоплата была внесена — возврат решает менеджер, он свяжется." : null });
      }

      case "save_guest_note": {
        if (!ctx.conversation.guestId) return fail("Гость не определён — сначала нужна бронь или номер телефона");
        const note = String(input.note).trim().slice(0, 500);
        if (!note) return fail("Пустая заметка");
        await db.update(guestsTable).set({ notes: sql`concat_ws(E'\\n', NULLIF(${guestsTable.notes}, ''), ${`${new Date().toLocaleDateString("ru-RU")} (ИИ): ${note}`}::text)` }).where(eq(guestsTable.id, ctx.conversation.guestId));
        return ok({ saved: true });
      }

      case "escalate_to_manager": {
        const kind = String(input.kind);
        await markAttention(ctx, kind, String(input.reason).slice(0, 500), !!input.urgent);
        return ok({ manager_notified: true, note: kind === "human_request" ? "Диалог передан человеку — дальше отвечает менеджер." : "Менеджер увидит сообщение и ответит." });
      }

      default:
        return fail(`Неизвестный инструмент ${name}`);
    }
  } catch (e) {
    if (e instanceof BookingError) return fail(e.message);
    throw e;
  }
}

async function bindGuest(ctx: ToolContext, guestId: number) {
  if (ctx.conversation.guestId === guestId) return;
  await db.update(aiConversationsTable).set({ guestId }).where(eq(aiConversationsTable.id, ctx.conversation.id));
  ctx.setGuestId(guestId);
}

const KIND_LABEL: Record<string, string> = { complaint: "Жалоба", large_event: "Банкет / большая компания", human_request: "Просит человека", error: "Ошибка ИИ", other: "Нужен менеджер" };

export async function markAttention(ctx: { conversation: AiConversation }, kind: string, reason: string, urgent: boolean) {
  await db.update(aiConversationsTable).set({
    needsAttention: true, attentionKind: kind, attentionReason: reason,
    ...(kind === "human_request" ? { status: "human" } : {}),
  }).where(eq(aiConversationsTable.id, ctx.conversation.id));
  const who = ctx.conversation.contactName ?? ctx.conversation.externalId;
  await notifyStaff(`${urgent ? "🔴 СРОЧНО. " : ""}🤖 ${KIND_LABEL[kind] ?? kind} — ${ctx.conversation.channel}, ${who}\n${reason}\n\nОткройте «ИИ-агент» в CRM, диалог №${ctx.conversation.id}.`);
}
