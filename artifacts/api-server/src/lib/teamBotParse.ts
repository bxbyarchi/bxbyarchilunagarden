/** Parsing what people type into the Telegram bot. */

/** "Мука высший сорт 450", "450 мука", "450" → line. */
export function parseLine(text: string): { name: string; amount: number } | null {
  const t = text.trim().replace(/\s*(сом|с|kgs)\.?$/i, "");
  let m = /^(.+?)\s*[-—:]?\s+(\d[\d\s]*(?:[.,]\d+)?)$/.exec(t);
  if (m) return { name: m[1].trim(), amount: Number(m[2].replace(/\s/g, "").replace(",", ".")) };
  m = /^(\d[\d\s]*(?:[.,]\d+)?)\s+(.+)$/.exec(t);
  if (m) return { name: m[2].trim(), amount: Number(m[1].replace(/\s/g, "").replace(",", ".")) };
  m = /^(\d[\d\s]*(?:[.,]\d+)?)$/.exec(t);
  if (m) return { name: "Покупка", amount: Number(m[1].replace(/\s/g, "").replace(",", ".")) };
  return null;
}
export function parseAmount(text: string): number | null {
  const n = Number(text.replace(/\s/g, "").replace(/(сом|с)$/i, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n * 100) / 100 : null;
}
