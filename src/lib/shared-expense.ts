/**
 * Shared expenses: one purchase paid up front for several people, whose parts
 * come back later as separate deposits. Two facts are recorded, both on the
 * Transaction rows themselves:
 *
 *   Transaction.yourShare               on the EXPENSE - the part of `amount`
 *                                       that was the user's own cost
 *   Transaction.reimbursesTransactionId on each INCOME deposit that pays some
 *                                       of the rest back
 *
 * The expense's `amount` is never changed: it is what left the account, so the
 * ledger, the account balance and the current period's spending keep it in
 * full. Only the figures that estimate the *future* read the share instead -
 * the one-off threshold (src/lib/extraordinary.ts) and the two averages of
 * typical spending (getCategorySuggestions, getHistoricalMonthlyAverage) - and
 * a linked deposit is left out of every income average (Afford's projections),
 * since it is money coming back rather than earnings. Nothing here projects
 * money not yet received: a share is recovered only when its deposit is a
 * real, logged row.
 *
 * Pure - no Prisma - so scripts/verify-domain.ts can check it directly and the
 * client-side transaction form can validate with the same rule.
 */
import { round2 } from "@/lib/money";

/**
 * The user's own cost of an expense: its share when it was shared, otherwise
 * the whole amount. Every substitution in the averaging engines goes through
 * this, so a row with no share is read exactly as it always was.
 */
export function ownShare(row: { amount: number; yourShare: number | null }): number {
  return row.yourShare ?? row.amount;
}

/**
 * Why a share is not acceptable for an expense of `amount`, or null when it
 * is: a share must be positive and can be at most the whole amount (a share
 * equal to the amount is allowed - nothing is then owed back - but not above
 * it). Messages are the form's validation vocabulary, translated by
 * firstError() in src/lib/validation.ts.
 */
export function yourShareIssue(amount: number, yourShare: number): string | null {
  if (yourShare <= 0) return "Enter an amount greater than 0";
  if (yourShare > amount) return "Your share cannot be more than the amount";
  return null;
}

/**
 * What a deposit's row needs to name the expense it pays back: the expense's
 * own description, falling back to its category the way the reimbursement
 * picker does. Loaded beside the row (see loadReimbursementDetails in
 * src/lib/data/transactions.ts), never stored on it.
 */
export interface ReimbursedExpenseRef {
  note: string | null;
  categoryName: string | null;
}

export interface ReimbursementProgress {
  /** What other people owe on this expense: amount - yourShare. */
  owed: number;
  /** The linked deposits so far, in the expense's currency. */
  recovered: number;
  /** owed - recovered, never below 0: a deposit above what was owed is simply money in. */
  pending: number;
  /** Nothing is pending any more. */
  settled: boolean;
}

/**
 * How far a shared expense has been paid back, from the sum of its linked
 * deposits. A display of existing rows, not a stored total: every reading
 * re-sums whatever deposits are linked right now.
 */
export function reimbursementProgress(
  expense: { amount: number; yourShare: number },
  recovered: number,
): ReimbursementProgress {
  const owed = round2(expense.amount - expense.yourShare);
  const pending = round2(Math.max(0, owed - recovered));
  return { owed, recovered: round2(recovered), pending, settled: pending <= 0 };
}

/**
 * How transactions.csv (Settings > Export all) names the expense a deposit
 * pays back, and how the CSV importer reads it back: the expense's own date,
 * description and signed amount with its currency - "2026-09-18 · Movie
 * tickets · -2725.00 DOP" - the three things a person identifies a
 * transaction by, and the same identity the importer's duplicate check uses.
 * Never an internal id, which means nothing in a spreadsheet and nothing in
 * another database. The description may itself contain the separator; the
 * date and the amount have a fixed shape, so parsing anchors on both ends.
 */
export interface ReimbursedExpenseReference {
  /** YYYY-MM-DD */
  date: string;
  /** The expense's description; null when it had none. */
  note: string | null;
  /** Unsigned, in `currency`. */
  amount: number;
  currency: string;
}

const REFERENCE_SEPARATOR = " · ";
const REFERENCE_PATTERN = /^(\d{4}-\d{2}-\d{2}) · ([\s\S]*) · (-?\d+\.\d{2}) ([A-Z]{3})$/;

export function formatReimbursedExpenseReference(expense: {
  date: string;
  note: string | null;
  /** Signed as the file's Amount column is: spending negative. */
  signedAmount: number;
  currency: string;
}): string {
  return [
    expense.date,
    expense.note ?? "",
    `${expense.signedAmount.toFixed(2)} ${expense.currency}`,
  ].join(REFERENCE_SEPARATOR);
}

/** The reference a cell holds, or null when it is blank or not one. */
export function parseReimbursedExpenseReference(cell: string): ReimbursedExpenseReference | null {
  const match = REFERENCE_PATTERN.exec(cell.trim());
  if (!match) return null;
  const [, date, note, amount, currency] = match;
  return { date, note: note === "" ? null : note, amount: Math.abs(Number(amount)), currency };
}

/** An expense still worth linking a deposit to: shared, and not yet fully paid back. */
export function isOpenSharedExpense(
  expense: { amount: number; yourShare: number | null },
  recovered: number,
): boolean {
  if (expense.yourShare === null) return false;
  return !reimbursementProgress({ amount: expense.amount, yourShare: expense.yourShare }, recovered).settled;
}
