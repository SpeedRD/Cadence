/**
 * Sign convention: amounts are always stored positive and the row's type
 * decides the direction. Transfers move value between two of the user's own
 * accounts, so they affect balances but are never income or spending. An
 * opening balance raises the ledger balance like income but is excluded from
 * isCashflow, so it never counts as income, spending, or budget activity.
 */
export function balanceSign(
  type: string,
  transferDirection: string | null | undefined,
): number {
  if (type === "INCOME") return 1;
  if (type === "EXPENSE") return -1;
  if (type === "TRANSFER") return transferDirection === "IN" ? 1 : -1;
  if (type === "OPENING_BALANCE") return 1;
  return 0;
}

export function isCashflow(type: string): boolean {
  return type === "INCOME" || type === "EXPENSE";
}
