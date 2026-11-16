/** Pure inventory math: per-line discrepancy and audit totals (money in сом). */

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export interface AuditLine {
  diff: number | null;      // actual − system, in the item's unit; null = not counted
  diffValue: number | null; // diff × unit price
  status: "uncounted" | "ok" | "shortage" | "surplus";
}

export function auditLineMath(system: number, actual: number | null, unitPrice: number): AuditLine {
  if (actual == null) return { diff: null, diffValue: null, status: "uncounted" };
  const diff = round(actual - system, 3);
  const diffValue = round(diff * unitPrice, 2);
  return { diff, diffValue, status: Math.abs(diff) < 0.0005 ? "ok" : diff < 0 ? "shortage" : "surplus" };
}

export function auditTotals(lines: AuditLine[]) {
  let shortageValue = 0, surplusValue = 0, counted = 0, withDiff = 0;
  for (const l of lines) {
    if (l.status === "uncounted") continue;
    counted++;
    if (l.status === "shortage") { shortageValue += -(l.diffValue ?? 0); withDiff++; }
    if (l.status === "surplus") { surplusValue += l.diffValue ?? 0; withDiff++; }
  }
  return {
    total: lines.length, counted, withDiff,
    shortageValue: round(shortageValue, 2), surplusValue: round(surplusValue, 2),
    balance: round(surplusValue - shortageValue, 2),
  };
}
