/**
 * One tool-using conversation turn on any configured model. Claude goes through the Anthropic SDK;
 * OpenRouter (free models) through its OpenAI-style chat API. The history is plain text kept in our
 * database, so switching models mid-conversation loses nothing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../ai/helpers";
import { isOpenRouter, orSlug, openRouterBase, fallbackFor, hasAnthropic, hasOpenRouter } from "./catalog";

export interface Tool { name: string; description: string; parameters: Record<string, unknown> }
export interface Turn {
  model: string; system: string; history: { role: "user" | "assistant"; text: string }[]; note: string;
  tools: Tool[]; exec: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  maxRounds?: number; maxTokens?: number;
}
export interface TurnResult { text: string; actions: { name: string; input: Record<string, unknown>; ok: boolean }[]; inputTokens: number; outputTokens: number; costUsd: number; model: string; fellBackFrom: string | null; truncated: boolean }

export class LlmError extends Error { constructor(message: string, public retryable = false) { super(message); } }

let anthropic: Anthropic | null = null;
function claude() {
  if (!hasAnthropic()) throw new LlmError("Не настроен ключ ANTHROPIC_API_KEY — модели Claude недоступны");
  anthropic ??= new Anthropic();
  return anthropic;
}

async function runClaude(t: Turn): Promise<Omit<TurnResult, "fellBackFrom">> {
  const client = claude();
  const messages: Anthropic.Beta.BetaMessageParam[] = t.history.map((h) => ({ role: h.role, content: h.text }));
  // Per-turn facts after the newest message keep the cached prefix (system + tools) stable.
  messages.push({ role: "system", content: t.note } as unknown as Anthropic.Beta.BetaMessageParam);
  const tools: Anthropic.Beta.BetaToolUnion[] = t.tools.map((x) => ({ name: x.name, description: x.description, strict: true, input_schema: x.parameters as Anthropic.Beta.BetaTool.InputSchema }));
  const actions: TurnResult["actions"] = [];
  let inTok = 0, outTok = 0;
  for (let round = 0; round <= (t.maxRounds ?? 8); round++) {
    let res;
    try {
      res = await client.beta.messages.create({
        model: t.model, max_tokens: t.maxTokens ?? 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        thinking: { type: "adaptive" }, output_config: { effort: "medium" }, cache_control: { type: "ephemeral" },
        system: t.system, tools, messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new LlmError("Превышен лимит запросов к Claude, попробуйте через минуту", true);
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError("Неверный ключ API Anthropic");
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError("Нет связи с сервером ИИ — проверьте интернет", true);
      if (e instanceof Anthropic.APIError) throw new LlmError(`Ошибка Claude ${e.status ?? ""}: ${e.message}`.slice(0, 300), (e.status ?? 0) >= 500);
      throw e;
    }
    inTok += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    outTok += res.usage.output_tokens;
    if (res.stop_reason === "refusal") throw new LlmError("Модель отказалась отвечать на этот вопрос");
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason !== "tool_use" || !uses.length) {
      if (!text) throw new LlmError(res.stop_reason === "max_tokens" ? "Ответ оборвался по лимиту длины" : "Модель не дала ответа", true);
      return { text, actions, inputTokens: inTok, outputTokens: outTok, costUsd: costUsd(t.model, inTok, outTok), model: t.model, truncated: res.stop_reason === "max_tokens" };
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>;
      const r = await t.exec(u.name, input).catch(() => ({ ok: false, text: "Инструмент временно недоступен" }));
      actions.push({ name: u.name, input, ok: r.ok });
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new LlmError("Слишком много шагов — сузьте вопрос");
}

type OaMsg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

async function runOpenRouter(t: Turn): Promise<Omit<TurnResult, "fellBackFrom">> {
  if (!hasOpenRouter()) throw new LlmError("Не настроен ключ OPENROUTER_API_KEY — бесплатные модели недоступны");
  // OpenAI-style APIs expect one system message up front: the per-turn note goes there.
  const messages: OaMsg[] = [{ role: "system", content: `${t.system}\n\n${t.note}` }, ...t.history.map((h) => ({ role: h.role, content: h.text }) as OaMsg)];
  const tools = t.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description, parameters: x.parameters } }));
  const actions: TurnResult["actions"] = [];
  let inTok = 0, outTok = 0;
  for (let round = 0; round <= (t.maxRounds ?? 8); round++) {
    let r: Response;
    try {
      r = await fetch(`${openRouterBase()}/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json", "x-title": "Luna Garden CRM" },
        body: JSON.stringify({ model: orSlug(t.model), messages, tools, tool_choice: "auto", max_tokens: Math.min(t.maxTokens ?? 4000, 8000) }),
      });
    } catch { throw new LlmError("Нет связи с OpenRouter — проверьте интернет", true); }
    const body = await r.json().catch(() => null) as { error?: { message?: string; code?: number }; choices?: { message: OaMsg; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    if (!r.ok || !body || body.error || !body.choices?.length) {
      const msg = body?.error?.message ?? `HTTP ${r.status}`;
      throw new LlmError(r.status === 429 ? "Бесплатная модель сейчас перегружена или исчерпан дневной лимит" : `Ошибка бесплатной модели: ${msg}`.slice(0, 300), true);
    }
    inTok += body.usage?.prompt_tokens ?? 0; outTok += body.usage?.completion_tokens ?? 0;
    const msg = body.choices[0].message;
    const calls = msg.tool_calls ?? [];
    messages.push({ role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      const text = (msg.content ?? "").trim();
      if (!text) throw new LlmError("Бесплатная модель не дала ответа", true);
      return { text, actions, inputTokens: inTok, outputTokens: outTok, costUsd: 0, model: t.model, truncated: body.choices[0].finish_reason === "length" };
    }
    for (const c of calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(c.function.arguments || "{}"); } catch { /* bad JSON from the model */ }
      const res = await t.exec(c.function.name, input).catch(() => ({ ok: false, text: "Инструмент временно недоступен" }));
      actions.push({ name: c.function.name, input, ok: res.ok });
      messages.push({ role: "tool", tool_call_id: c.id, content: res.text });
    }
  }
  throw new LlmError("Слишком много шагов — сузьте вопрос");
}

/** Run on the chosen model; if a free model fails, answer with the fallback (Claude Haiku). */
export async function runTurn(t: Turn): Promise<TurnResult> {
  const run = (m: string) => (isOpenRouter(m) ? runOpenRouter({ ...t, model: m }) : runClaude({ ...t, model: m }));
  try { return { ...(await run(t.model)), fellBackFrom: null }; }
  catch (e) {
    const fb = fallbackFor(t.model);
    if (!fb || !(e instanceof LlmError)) throw e;
    return { ...(await run(fb)), fellBackFrom: t.model };
  }
}
