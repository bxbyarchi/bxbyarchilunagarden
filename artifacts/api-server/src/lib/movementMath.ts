/** Groups ledger kinds into the columns of the stock movement report. */

export const MOVEMENT_COLUMNS = ["receipts", "transfers", "production", "sales", "writeOffs", "adjustments"] as const;
export type MovementColumn = (typeof MOVEMENT_COLUMNS)[number];

const KIND_COLUMN: Record<string, MovementColumn> = {
  receipt: "receipts", receipt_edit: "receipts", receipt_delete: "receipts", telegram_receipt: "receipts",
  transfer_out: "transfers", transfer_in: "transfers", transfer_return: "transfers",
  production_out: "production", production_in: "production", production_cancel: "production",
  sale: "sales", sale_return: "sales",
  write_off: "writeOffs", write_off_edit: "writeOffs", write_off_delete: "writeOffs", telegram_write_off: "writeOffs",
  inventory: "adjustments", manual_adjust: "adjustments", item_create: "adjustments", opening: "adjustments", other: "adjustments",
};

export const columnOf = (kind: string): MovementColumn => KIND_COLUMN[kind] ?? "adjustments";

export interface LedgerSum { itemId: number; locationId: number; kind: string; inRange: boolean; delta: number }

export interface MovementRow {
  itemId: number; locationId: number;
  opening: number; closing: number;
  columns: Record<MovementColumn, number>;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** `sums` = SUM(delta) per item/location/kind, split into before-the-period and in-the-period. */
export function buildMovement(sums: LedgerSum[]): MovementRow[] {
  const rows = new Map<string, MovementRow>();
  for (const s of sums) {
    const key = `${s.itemId}:${s.locationId}`;
    let row = rows.get(key);
    if (!row) {
      row = { itemId: s.itemId, locationId: s.locationId, opening: 0, closing: 0, columns: Object.fromEntries(MOVEMENT_COLUMNS.map((c) => [c, 0])) as Record<MovementColumn, number> };
      rows.set(key, row);
    }
    // "opening" = balances that existed before the ledger started: always the starting point.
    if (s.inRange && s.kind !== "opening") row.columns[columnOf(s.kind)] += s.delta;
    else row.opening += s.delta;
  }
  for (const row of rows.values()) {
    for (const c of MOVEMENT_COLUMNS) row.columns[c] = r4(row.columns[c]);
    row.opening = r4(row.opening);
    row.closing = r4(row.opening + MOVEMENT_COLUMNS.reduce((s, c) => s + row.columns[c], 0));
  }
  // Rows with nothing before, nothing during and nothing after are noise.
  return [...rows.values()].filter((r) => r.opening !== 0 || r.closing !== 0 || MOVEMENT_COLUMNS.some((c) => r.columns[c] !== 0));
}
