/**
 * Prints a receipt on a thermal printer (80 mm or 58 mm roll) through the
 * browser's print dialog, from a hidden iframe so the page around it isn't
 * printed. Works offline: no fonts or scripts are loaded from the network.
 */

export interface ReceiptLine { name: string; quantity: number; pricePerUnit: number }
export interface ReceiptPrintData {
  saleId: number;
  createdAt: string;
  pointName: string;
  registerName: string;
  cashierName: string;
  paymentMethod: "cash" | "card";
  items: ReceiptLine[];
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  total: number;
}

export type ReceiptWidth = "80" | "58";
const WIDTH_KEY = "lg.receiptWidth";

export function getReceiptWidth(): ReceiptWidth {
  try { return localStorage.getItem(WIDTH_KEY) === "58" ? "58" : "80"; } catch { return "80"; }
}
export function setReceiptWidth(w: ReceiptWidth) {
  try { localStorage.setItem(WIDTH_KEY, w); } catch { /* private mode — default 80 mm */ }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (v: number) => v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 3 });

export function receiptHtml(r: ReceiptPrintData, width: ReceiptWidth, logoUrl: string): string {
  const paper = width === "58" ? 58 : 80;
  const body = width === "58" ? 48 : 72; // printable area of common printers
  const rows = r.items.map((it) => `
    <div class="item">${esc(it.name)}</div>
    <div class="row"><span>${qty(it.quantity)} × ${money(it.pricePerUnit)}</span><span>${money(it.quantity * it.pricePerUnit)}</span></div>`).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Чек №${r.saleId}</title>
<style>
  @page { size: ${paper}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${body}mm; margin: 0 auto; padding: 3mm 0 6mm; font: ${width === "58" ? 11 : 12}px/1.35 "Courier New", ui-monospace, monospace; }
  .c { text-align: center; }
  .logo { display: block; margin: 0 auto 2mm; width: ${width === "58" ? 38 : 52}mm; filter: grayscale(1) brightness(0); }
  .sep { border-top: 1px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .item { margin-top: 1mm; word-break: break-word; }
  .total { font-size: 1.35em; font-weight: bold; }
  .muted { font-size: .9em; }
</style></head><body>
  <img class="logo" src="${esc(logoUrl)}" alt="">
  <div class="c">${esc(r.pointName)} · ${esc(r.registerName)}</div>
  <div class="c muted">ТОВАРНЫЙ ЧЕК №${r.saleId}</div>
  <div class="c muted">${esc(new Date(r.createdAt).toLocaleString("ru-RU"))}</div>
  <div class="c muted">Кассир: ${esc(r.cashierName)}</div>
  <div class="sep"></div>
  ${rows}
  <div class="sep"></div>
  ${r.discountPercent > 0 ? `<div class="row"><span>Подытог</span><span>${money(r.subtotal)}</span></div>
  <div class="row"><span>Скидка ${qty(r.discountPercent)}%</span><span>−${money(r.discountAmount)}</span></div>` : ""}
  <div class="row total"><span>ИТОГО</span><span>${money(r.total)}</span></div>
  <div class="row"><span>Оплата</span><span>${r.paymentMethod === "cash" ? "наличными" : "картой"}</span></div>
  <div class="sep"></div>
  <div class="c">Спасибо, ждём вас снова!</div>
  <div class="c muted">Документ не является фискальным</div>
</body></html>`;
}

export function printReceipt(r: ReceiptPrintData, width: ReceiptWidth = getReceiptWidth()) {
  const logoUrl = `${window.location.origin}${import.meta.env.BASE_URL}brand/logo-horizontal.svg`;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(receiptHtml(r, width, logoUrl)); doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  // Wait for the logo so it isn't missing on the first print.
  const img = doc.querySelector("img");
  if (img && !img.complete) { img.onload = go; img.onerror = go; } else go();
}
