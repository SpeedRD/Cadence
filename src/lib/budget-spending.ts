/**
 * Budget spending (QUANTITIES_MAP.md K6): one population for every figure a
 * period's budget is measured with - the overall "spent" and safe to spend,
 * the Budgets page's category rows, the numerator of a category suggestion,
 * the carryover - and the rows the monthly pace calls lifestyle.
 *
 * It is every expense the plan did not already reserve. Left out:
 *
 *   - a row that stands for a recurring occurrence: the RECURRING row posting
 *     wrote, or a charge the user entered that posting settled an occurrence
 *     with (RecurringSettlement), a subscription's or a contribution's - the
 *     plan counted the occurrence among its commitments (K2);
 *   - a hand-logged contribution's own expense (externalId
 *     "goal-contribution:<id>"): its GoalContribution counts it as savings;
 *   - anything in a subscription or savings category: the check-in never
 *     budgets those categories, so nothing is measured against them.
 *
 * A shared expense counts at the user's own share (Transaction.yourShare, see
 * src/lib/shared-expense.ts): the budget is planned at what things cost the
 * user, and other people's part is money passing through. A deposit paying
 * it back is income, never an offset. A confirmed one-off
 * (Transaction.isExtraordinary) is budget spending like any other; its part
 * is reported beside the figure so a suggestion can leave it out.
 *
 * Pure - no Prisma - so scripts/verify-domain.ts can check it directly; the
 * loader is budgetSpent() in src/lib/data/budget-spending.ts, and
 * getPeriodSummary runs the same function over the rows it already reads.
 */
import { round2 } from "@/lib/money";
import { ownShare } from "@/lib/shared-expense";
import { manualContributionIdFromTransaction } from "@/lib/transactions";

import type { RecurringKind } from "@/generated/prisma/enums";

/** An EXPENSE row as budget spending reads it, amounts in the row's currency. */
export interface SpendingRow {
  amount: number;
  currency: string;
  categoryId: string | null;
  source: string;
  externalId: string | null;
  isExtraordinary: boolean;
  yourShare: number | null;
  /** The kind of the occurrence a RecurringSettlement pairs this charge with, if any. */
  settlementKind: RecurringKind | null;
}

export interface SpendingCategory {
  id: string;
  kind: string;
  isSubscriptionDefault: boolean;
  isSavingsDefault: boolean;
}

/** One category's budget spending, in the display currency. */
export interface BudgetCategorySpent {
  spent: number;
  /** The part of `spent` from confirmed one-offs - left out of a suggestion's average. */
  oneOff: number;
}

/** budgetSpent(period): the period's budget spending, overall and by category (null: uncategorized). */
export interface BudgetSpent {
  total: number;
  byCategory: Map<string | null, BudgetCategorySpent>;
}

/** The row stands for a recurring occurrence the plan reserved: posting's own row, or a charge that settled one. */
export function standsForOccurrence(row: Pick<SpendingRow, "source" | "settlementKind">): boolean {
  return row.source === "RECURRING" || row.settlementKind !== null;
}

/** A hand-logged contribution's own expense, or a charge that settled a contribution occurrence: savings, not spending. */
export function isContributionTwin(row: Pick<SpendingRow, "source" | "externalId" | "settlementKind">): boolean {
  return manualContributionIdFromTransaction(row) !== null || row.settlementKind === "CONTRIBUTION";
}

/** The row is filed under a category the check-in never budgets: a subscription or savings one. */
export function inUnbudgetedCategory(
  row: Pick<SpendingRow, "categoryId">,
  categoryById: ReadonlyMap<string, SpendingCategory>,
): boolean {
  const category = row.categoryId === null ? undefined : categoryById.get(row.categoryId);
  return Boolean(category && (category.isSubscriptionDefault || category.isSavingsDefault));
}

/** Whether a row is budget spending (the population above). */
export function isBudgetSpending(row: SpendingRow, categoryById: ReadonlyMap<string, SpendingCategory>): boolean {
  return !standsForOccurrence(row) && !isContributionTwin(row) && !inUnbudgetedCategory(row, categoryById);
}

/**
 * The line a row is reported under: its category when that is an expense
 * category, otherwise the uncategorized line (null) - an expense filed under
 * an income category joins it rather than disappearing from the breakdown.
 */
export function spendingLineKey(
  row: Pick<SpendingRow, "categoryId">,
  categoryById: ReadonlyMap<string, SpendingCategory>,
): string | null {
  if (row.categoryId === null) return null;
  return categoryById.get(row.categoryId)?.kind === "EXPENSE" ? row.categoryId : null;
}

/** What a row costs the user, in its own currency: the share of a shared expense, else the amount. */
export function ownCost(row: Pick<SpendingRow, "amount" | "yourShare">): number {
  return ownShare(row);
}

/** Budget spending over `rows`, converted with `toDisplay`. */
export function budgetSpentFrom(
  rows: readonly SpendingRow[],
  categoryById: ReadonlyMap<string, SpendingCategory>,
  toDisplay: (amount: number, currency: string) => number,
): BudgetSpent {
  let total = 0;
  const byCategory = new Map<string | null, BudgetCategorySpent>();
  for (const row of rows) {
    if (!isBudgetSpending(row, categoryById)) continue;
    const amount = toDisplay(ownCost(row), row.currency);
    total += amount;
    const key = spendingLineKey(row, categoryById);
    const line = byCategory.get(key) ?? { spent: 0, oneOff: 0 };
    line.spent += amount;
    if (row.isExtraordinary) line.oneOff += amount;
    byCategory.set(key, line);
  }
  for (const line of byCategory.values()) {
    line.spent = round2(line.spent);
    line.oneOff = round2(line.oneOff);
  }
  return { total: round2(total), byCategory };
}
