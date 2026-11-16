import { rawRequirements, type CardInfo, type ItemInfo } from "./techCardMath";

/** What a menu position deducts from stock. */
export interface ProductLink {
  id: number;
  techCardId: number | null;
  itemId: number | null;
  itemQty: number;          // in the stock item's unit, per 1 sold
  writeOffLocationId: number | null;
}

export interface WriteOff { itemId: number; locationId: number; qty: number; unitCost: number }

/**
 * Stock to write off for `quantity` sold of one product.
 * - tech card → its ingredients (semis taken from stock when produced in advance);
 * - stock item → itemQty × quantity;
 * - neither → nothing (services, deposits…).
 * Department: product override → tech card's department → the point of sale's location.
 */
export function saleWriteOffs(
  product: ProductLink,
  quantity: number,
  saleLocationId: number,
  cards: Map<number, CardInfo>,
  items: Map<number, ItemInfo>,
): WriteOff[] {
  if (product.techCardId != null && cards.has(product.techCardId)) {
    const card = cards.get(product.techCardId)!;
    const locationId = product.writeOffLocationId ?? card.departmentId ?? saleLocationId;
    return [...rawRequirements(card.id, cards, items, quantity)]
      .filter(([, qty]) => qty > 0)
      .map(([itemId, qty]) => ({ itemId, locationId, qty: round4(qty), unitCost: items.get(itemId)?.pricePerUnit ?? 0 }));
  }
  if (product.itemId != null && items.has(product.itemId)) {
    const item = items.get(product.itemId)!;
    const qty = round4((product.itemQty > 0 ? product.itemQty : 1) * quantity);
    return [{ itemId: item.id, locationId: product.writeOffLocationId ?? saleLocationId, qty, unitCost: item.pricePerUnit }];
  }
  return [];
}

/** Share of earlier write-offs to put back when `returnedQty` of `soldQty` is returned. */
export function restockShare(writeOffs: Array<{ itemId: number; locationId: number; qty: number; unitCost: number }>, soldQty: number, returnedQty: number): WriteOff[] {
  if (!(soldQty > 0) || !(returnedQty > 0)) return [];
  const k = Math.min(returnedQty / soldQty, 1);
  return writeOffs.filter((w) => w.qty > 0).map((w) => ({ ...w, qty: round4(w.qty * k) }));
}

/** Discount-aware refund for returning `qty` of a line sold at `price` with `discountPercent` on the receipt. */
export function refundAmount(qty: number, price: number, discountPercent: number): number {
  const pct = Math.min(Math.max(discountPercent, 0), 100);
  return Math.round(qty * price * (1 - pct / 100) * 100) / 100;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
