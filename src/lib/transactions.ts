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

export type TransactionEditBlock =
  | "transfer"
  | "opening_balance"
  | "goal_contribution"
  | null;

/**
 * Rows the generic transaction form must not edit: a transfer leg (edit both
 * legs from the transfer form), an account's opening balance (edit it from
 * the Accounts page, where it stays an OPENING_BALANCE rather than being
 * re-saved as income or spending), and the expense a goal contribution wrote
 * (its amount and date belong to the GoalContribution on the goal's page;
 * re-saving it here would leave the goal's progress and the ledger disagreeing).
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
  return null;
}
