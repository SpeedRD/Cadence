import { revalidatePath } from "next/cache";

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
    recurringSuggestions?: number;
  },
): ActionState {
  return { ok: true, message, at: Date.now(), ...extra };
}

/**
 * Every page reads live data, so a single layout-level revalidation keeps the
 * client router cache honest without threading paths through each action.
 */
export function revalidateApp(): void {
  revalidatePath("/", "layout");
}
