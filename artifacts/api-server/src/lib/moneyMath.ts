/** Pure rules for money requests: who may do what, totals, advance settlement. */

export type Kind = "advance" | "payment" | "reimbursement";
export type Status = "pending" | "approved" | "issued" | "reported" | "closed" | "rejected" | "cancelled";
export type Action = "approve" | "reject" | "cancel" | "issue" | "pay" | "report" | "return_report" | "close";

/** Managers agree to spend; accounting hands out the money and checks reports. */
export const APPROVERS = ["super_admin", "warehouse_chief", "manager", "location_admin"];
export const CASHIERS = ["super_admin", "accountant"];
export const OPEN_STATUSES: Status[] = ["pending", "approved", "issued", "reported"];

export interface Actor { role: string; isRequester: boolean; isHolder: boolean }

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimateTotal(lines: { qty: number; price: number }[]): number {
  return round2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
}
export function spentTotal(lines: { amount: number }[]): number {
  return round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
}
/** >0: the employee returns this much; <0: the company owes them; 0: square. */
export function settlementOf(issued: number, spent: number): number {
  return round2(issued - spent);
}

export function allowedActions(kind: Kind, status: Status, a: Actor): Action[] {
  const approver = APPROVERS.includes(a.role);
  const cashier = CASHIERS.includes(a.role);
  // Nobody approves their own request — except the owner account.
  const canApprove = approver && (!a.isRequester || a.role === "super_admin");
  const out: Action[] = [];
  if (status === "pending") {
    if (canApprove) out.push("approve", "reject");
    if (a.isRequester || approver) out.push("cancel");
  }
  if (status === "approved") {
    if (cashier) out.push(kind === "advance" ? "issue" : "pay");
    if (a.isRequester || approver) out.push("cancel");
  }
  if (status === "issued" && kind === "advance" && (a.isHolder || a.isRequester || cashier)) out.push("report");
  if (status === "reported" && cashier) out.push("close", "return_report");
  return out;
}

/** Days an advance may stay unreported before it shows as overdue. */
export const REPORT_DAYS = 3;
export function isReportOverdue(r: { kind: string; status: string; reportDueAt: string | null }, today: string): boolean {
  return r.kind === "advance" && r.status === "issued" && !!r.reportDueAt && r.reportDueAt < today;
}
