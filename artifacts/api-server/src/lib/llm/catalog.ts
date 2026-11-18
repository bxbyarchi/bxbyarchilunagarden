/**
 * Which AI models the CRM can use. Claude models (Anthropic) are paid and strongest; OpenRouter gives
 * free models (the list changes, so it is fetched from OpenRouter and cached, with a fallback list).
 * Model ids: Claude ids as-is ("claude-opus-5-5"); OpenRouter ids prefixed ("openrouter:<slug>").
 */
export type Tier = "free" | "fast" | "balanced" | "smart";
export interface ModelInfo { id: string; provider: "anthropic" | "openrouter"; label: string; tier: Tier; free: boolean }

export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5 — самая умная", tier: "smart", free: false },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5 — умная и быстрее", tier: "balanced", free: false },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5 — быстрая и дешёвая", tier: "fast", free: false },
];
/** Guests (WhatsApp, Instagram, calls) always get a strong model. */
export const GUEST_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];
export const DEFAULT_GUEST_MODEL = "claude-opus-5-5";

/** Used until OpenRouter's live list is fetched (or when it can't be). Free models come and go. */
const FALLBACK_FREE = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

export const hasAnthropic = () => !!process.env.ANTHROPIC_API_KEY;
export const hasOpenRouter = () => !!process.env.OPENROUTER_API_KEY;
export const openRouterBase = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
export const isOpenRouter = (id: string) => id.startsWith("openrouter:");
export const orSlug = (id: string) => id.slice("openrouter:".length);

function prettyFree(slug: string) {
  const name = slug.replace(/:free$/, "").split("/").pop()!.replace(/-/g, " ");
  return `${name} — бесплатная`;
}

let cache: { at: number; ids: string[] } | null = null;
/** Free OpenRouter models that support tool calling (needed to open CRM reports), largest context first. */
export async function freeModels(): Promise<ModelInfo[]> {
  if (!hasOpenRouter()) return [];
  if (!cache || Date.now() - cache.at > 6 * 3600_000) {
    try {
      const r = await fetch(`${openRouterBase()}/models`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { data?: { id: string; context_length?: number; supported_parameters?: string[] }[] };
      const ids = (data.data ?? []).filter((m) => m.id.endsWith(":free") && (m.supported_parameters ?? []).includes("tools"))
        .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0)).slice(0, 12).map((m) => m.id);
      cache = { at: Date.now(), ids: ids.length ? ids : FALLBACK_FREE };
    } catch {
      cache = { at: Date.now() - 5.5 * 3600_000, ids: cache?.ids ?? FALLBACK_FREE }; // retry in ~30 min
    }
  }
  return cache.ids.map((slug) => ({ id: `openrouter:${slug}`, provider: "openrouter", label: prettyFree(slug), tier: "free", free: true }));
}

export async function availableModels(): Promise<ModelInfo[]> {
  return [...(await freeModels()), ...(hasAnthropic() ? CLAUDE_MODELS : [])];
}

/** "auto" for the advisor: a free model when OpenRouter is set up, otherwise Claude Sonnet. */
export async function resolveAdvisorModel(wanted: string | null | undefined): Promise<string> {
  const all = await availableModels();
  if (wanted && wanted !== "auto" && all.some((m) => m.id === wanted)) return wanted;
  return all.find((m) => m.free)?.id ?? (hasAnthropic() ? "claude-sonnet-5-5" : "claude-sonnet-5-5");
}
/** Who answers when the chosen model fails: Claude Haiku (cheap, reliable), if Claude is configured. */
export function fallbackFor(model: string): string | null {
  if (!hasAnthropic()) return null;
  return model === "claude-haiku-5-5" ? null : isOpenRouter(model) ? "claude-haiku-5-5" : null;
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? (isOpenRouter(id) ? prettyFree(orSlug(id)) : id);
}
