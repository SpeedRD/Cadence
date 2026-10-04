import { revalidatePath } from "next/cache";

import { RatesUnavailableError, RoundsToZeroError } from "@/lib/account-money";
import { formatMoney } from "@/lib/currency";
import { RecentDuplicateError } from "@/lib/data/recent-duplicate";
import { getDictionary, type Locale } from "@/lib/i18n";

import type { PostedMatch } from "@/lib/data/posted-duplicates";

export type ActionState = {
  ok: boolean;
  error?: string;
  message?: string;
  /** Changes identity on every result so effects re-run on repeat submits. */
  at?: number;
  /**
   * Set only by the contribution that crossed a goal's target, so the client
   * can mark that one moment. Absent on every later write to an already
   * achieved goal - see rebuildGoalSaved() in src/lib/goals.ts.
   */
  achievedGoalId?: string;
  /**
   * Set by deleteCategoryAction when the category still has rows filed under
   * it: what would be orphaned, so the client can open the reassignment step
   * with the real counts instead of deleting anything.
   */
  categoryUsage?: { transactions: number; recurringItems: number; budgets: number };
  /**
   * Set by saveTransactionAction when the expense it just created is
   * unusually large for its category (see src/lib/extraordinary.ts), so the
   * form can ask whether it was a one-off. The row is saved unflagged either
   * way; only the user's answer writes the flag.
   */
  extraordinarySuggestion?: ExtraordinarySuggestion;
  /**
   * Set by saveTransactionAction when the row it just created matches a row
   * Cadence wrote itself - a posted recurring charge or a check-in's paycheck
   * (see src/lib/data/posted-duplicates.ts) - so the form can ask whether it
   * is the same money. The row is saved either way; only the user's answer
   * removes it in favour of the posted one.
   */
  postedMatchSuggestion?: PostedMatchSuggestion;
  /**
   * Set by importTransactionsAction: how many spending patterns look like
   * an untracked recurring bill once the new rows are in (see
   * src/lib/recurring-detection.ts), so the importer can point at the
   * Recurring page. A count only - nothing is created by importing.
   */
  recurringSuggestions?: number;
} | null;

export interface ExtraordinarySuggestion {
  transactionId: string;
  amount: number;
  currency: string;
  categoryName: string;
  /** The category's typical amount the expense was measured against, in `medianCurrency`. */
  median: number;
  medianCurrency: string;
}

export interface PostedMatchSuggestion {
  /** The row this save created - the only one the answer may remove. */
  transactionId: string;
  /** That row as saved (entryDigest); an answer to an entry changed since is refused. */
  savedDigest: string;
  /** The entry as saved. */
  amount: number;
  currency: string;
  match: PostedMatch;
}

export function fail(
  error: string,
  extra?: { categoryUsage?: NonNullable<ActionState>["categoryUsage"] },
): ActionState {
  return { ok: false, error, at: Date.now(), ...extra };
}

export function done(
  message?: string,
  extra?: {
    achievedGoalId?: string;
    extraordinarySuggestion?: ExtraordinarySuggestion;
    postedMatchSuggestion?: PostedMatchSuggestion;
    recurringSuggestions?: number;
  },
): ActionState {
  return { ok: true, message, at: Date.now(), ...extra };
}

/**
 * The message for a money write the writer refused and left unwritten - no
 * current rate to convert it (R20), an amount that comes to 0.00 in the
 * account's currency (R29), the same entry submitted again (R30) - or null
 * for any other error, which the caller rethrows. `ratesMessage` replaces
 * the generic rates message where the form can take the amount in the
 * account's currency instead.
 */
export function refusedWriteMessage(error: unknown, locale: Locale, ratesMessage?: (currency: string) => string): string | null {
  const common = getDictionary(locale).common;
  if (error instanceof RecentDuplicateError) return common.duplicateEntry;
  if (error instanceof RoundsToZeroError) {
    return common.roundsToZero(formatMoney(error.entered.amount, error.entered.currency), error.accountCurrency);
  }
  if (error instanceof RatesUnavailableError) return ratesMessage ? ratesMessage(error.to) : common.ratesUnavailable;
  return null;
}

/**
 * Every page reads live data, so a single layout-level revalidation keeps the
 * client router cache honest without threading paths through each action.
 */
export function revalidateApp(): void {
  revalidatePath("/", "layout");
}
