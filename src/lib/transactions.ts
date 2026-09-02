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

export type TransactionEditBlock = "transfer" | "opening_balance" | null;

/**
 * Rows the generic transaction form must not edit: a transfer leg (edit both
 * legs from the transfer form) and an account's opening balance (edit it from
 * the Accounts page, where it stays an OPENING_BALANCE rather than being
 * re-saved as income or spending).
 */
export function transactionEditBlock(row: {
  type: string;
  transferId: string | null;
}): TransactionEditBlock {
  if (row.transferId) return "transfer";
  if (row.type === "OPENING_BALANCE") return "opening_balance";
  return null;
}
