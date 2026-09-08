/**
 * Sign convention: amounts are always stored positive and the row's type
 * decides the direction. Transfers move value between two of the user's own
 * accounts, so they affect balances but are never income or spending. An
 * opening balance raises the ledger balance like income but is excluded from
 * isCashflow, so it never counts as income, spending, or budget activity. An
 * external transfer moves value out of (or into) a tracked account with no
 * Cadence-side counterparty - it affects the balance exactly like a transfer
 * leg, using the same OUT/IN direction convention, but is a single row (no
 * paired leg) and is likewise excluded from isCashflow.
 */
export function balanceSign(
  type: string,
  transferDirection: string | null | undefined,
): number {
  if (type === "INCOME") return 1;
  if (type === "EXPENSE") return -1;
  if (type === "TRANSFER") return transferDirection === "IN" ? 1 : -1;
  if (type === "OPENING_BALANCE") return 1;
  if (type === "EXTERNAL_TRANSFER") return transferDirection === "IN" ? 1 : -1;
  return 0;
}

export function isCashflow(type: string): boolean {
  return type === "INCOME" || type === "EXPENSE";
}

/**
 * The (source MANUAL, externalId) key of the Transaction a hand-logged goal
 * contribution wrote - the same pairing device recurring posting uses
 * ("<itemId>:<date>" under source RECURRING), keyed by the GoalContribution's
 * own id since a manual entry has no item or schedule to name it by. Storing
 * the pairing on the Transaction rather than as a second foreign key on
 * GoalContribution keeps the existing (source, externalId) unique index as the
 * one-twin-per-contribution guard and gives every lookup a single indexed key.
 * Defined here, in a module with no database import, so the client-side
 * transaction table can recognise these rows too.
 */
export const MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX = "goal-contribution:";

export function manualContributionExternalId(contributionId: string): string {
  return `${MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX}${contributionId}`;
}

/** The GoalContribution id a paired Transaction points at, or null for any other row. */
export function manualContributionIdFromTransaction(row: {
  source: string;
  externalId: string | null;
}): string | null {
  if (row.source !== "MANUAL" || row.externalId === null) return null;
  if (!row.externalId.startsWith(MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX)) return null;
  const id = row.externalId.slice(MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * The key a RECURRING-sourced row shares with the GoalContribution posted
 * beside it ("<itemId>:<YYYY-MM-DD>", see recurringExternalId in
 * src/lib/recurring-posting.ts), or null for any other row. Only a lookup can
 * tell whether a contribution actually exists for it - a subscription's row
 * carries the same shape of key with nothing paired - so callers that cascade
 * must check, and transactionEditBlock deliberately does not use this.
 */
export function recurringContributionKeyFromTransaction(row: {
  source: string;
  externalId: string | null;
}): string | null {
  if (row.source !== "RECURRING" || !row.externalId) return null;
  return row.externalId;
}

export type TransactionEditBlock =
  | "transfer"
  | "opening_balance"
  | "goal_contribution"
  | "payday_income"
  | null;

/**
 * Rows the generic transaction form must not edit: a transfer leg (edit both
 * legs from the transfer form), an account's opening balance (edit it from
 * the Accounts page, where it stays an OPENING_BALANCE rather than being
 * re-saved as income or spending), the expense a goal contribution wrote
 * (its amount and date belong to the GoalContribution on the goal's page;
 * re-saving it here would leave the goal's progress and the ledger
 * disagreeing), and the paycheck a payday check-in recorded (the check-in's
 * snapshot keeps the same figure as incomeEntered and points at this row by
 * id: period income is read from the snapshot, the next check-in's expected
 * balance subtracts it, and a re-confirm rewrites or recreates the row - so
 * editing or deleting it here would desync all three; change the income by
 * re-running that period's check-in instead). There is no paired row to
 * cascade to, so a delete is refused outright rather than mirrored.
 */
export function transactionEditBlock(row: {
  type: string;
  transferId: string | null;
  source: string;
  externalId: string | null;
}): TransactionEditBlock {
  if (row.transferId) return "transfer";
  if (row.type === "OPENING_BALANCE") return "opening_balance";
  if (manualContributionIdFromTransaction(row) !== null) return "goal_contribution";
  if (row.source === "PAYDAY_CHECKIN") return "payday_income";
  return null;
}

export interface TransferLeg {
  amount: number;
  currency: string;
}

/**
 * What each leg of a transfer records. Both legs carry the entered amount
 * and currency - the receiving account's balance then converts it at the
 * current rate - unless the accounts are in different currencies and the
 * user gave the amount the bank actually credited: then the receiving leg
 * carries that exact figure in the receiving account's own currency, the way
 * a real cross-currency transfer lands. Same-currency transfers ignore the
 * override entirely, so their two legs can never disagree.
 */
export function transferLegs(input: {
  amount: number;
  currency: string;
  receivedAmount: number | null;
  fromCurrency: string;
  toCurrency: string;
}): { out: TransferLeg; in: TransferLeg } {
  const out = { amount: input.amount, currency: input.currency };
  const crossCurrency = input.fromCurrency !== input.toCurrency;
  if (crossCurrency && input.receivedAmount !== null) {
    return { out, in: { amount: input.receivedAmount, currency: input.toCurrency } };
  }
  return { out, in: { ...out } };
}
