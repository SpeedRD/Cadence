/**
 * Budget spending (QUANTITIES_MAP.md K6): one population for every figure a
 * period's budget is measured with - the overall "spent" and safe to spend,
 * the Budgets page's category rows, the numerator of a category suggestion,
 * the carryover - and the rows the monthly pace calls lifestyle.
 *
 * It is every expense the plan did not already reserve. Left out, because
 * another figure already counts it:
 *
 *   - a row that stands for a recurring occurrence: the RECURRING row posting
 *     wrote, or a charge the user entered that pays an occurrence (a
 *     RecurringSettlement, or a pairing the settlement plan makes before
 *     posting records it), a subscription's or a contribution's - the plan
 *     counted the occurrence among its commitments (K2);
 *   - a hand-logged contribution's own expense (externalId
 *     "goal-contribution:<id>"): its GoalContribution counts it as savings.
 *
 * Nothing is left out for its category: an expense filed under a
 * subscription or savings category with no recurring item or contribution
 * behind it is in no commitment and no goal, so it is spending in its
 * category like any other - otherwise it would be in no figure at all.
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

/**
 * The row is filed under a category the check-in never budgets: a
 * subscription or savings one. Not a budget-spending rule (an expense there
 * that nothing else covers is spending); the total view and the monthly pace
 * read it.
 */
export function inUnbudgetedCategory(
  row: Pick<SpendingRow, "categoryId">,
  categoryById: ReadonlyMap<string, Pick<SpendingCategory, "isSubscriptionDefault" | "isSavingsDefault">>,
): boolean {
  const category = row.categoryId === null ? undefined : categoryById.get(row.categoryId);
  return Boolean(category && (category.isSubscriptionDefault || category.isSavingsDefault));
}

/** Whether a row is budget spending (the population above): whatever no commitment or goal already counts. */
export function isBudgetSpending(row: SpendingRow): boolean {
  return !standsForOccurrence(row) && !isContributionTwin(row);
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
    if (!isBudgetSpending(row)) continue;
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

/** A period's budget as the Dashboard, the Budgets page, carryover and K4 read it, in the display currency. */
export interface PeriodBudget {
  /** The explicit overall budget, when one is set. */
  overallBudget: number | null;
  /** Each category's budget, keyed by category id. */
  byCategory: Map<string, number>;
  categoryBudgetTotal: number;
  /** overallBudget when set, otherwise the sum of the category budgets. */
  periodBudget: number;
  hasBudget: boolean;
}

/** The period's Budget rows read into one figure: the overall row when there is one, else the category rows summed. */
export function periodBudgetFrom(
  budgets: readonly { categoryId: string | null; amount: number; currency: string }[],
  toDisplay: (amount: number, currency: string) => number,
): PeriodBudget {
  const overallRow = budgets.find((budget) => budget.categoryId === null);
  const overallBudget = overallRow ? round2(toDisplay(overallRow.amount, overallRow.currency)) : null;
  const byCategory = new Map<string, number>();
  for (const budget of budgets) {
    if (!budget.categoryId) continue;
    byCategory.set(budget.categoryId, round2(toDisplay(budget.amount, budget.currency)));
  }
  const categoryBudgetTotal = round2([...byCategory.values()].reduce((total, value) => total + value, 0));
  return {
    overallBudget,
    byCategory,
    categoryBudgetTotal,
    periodBudget: overallBudget ?? categoryBudgetTotal,
    hasBudget: overallBudget !== null || categoryBudgetTotal > 0,
  };
}

/**
 * The part of `spent` in lines the period budgets nothing for: the
 * uncategorized line and every category without a category budget above 0.
 * It is what spending has taken out of the money the plan leaves in no
 * budget (unallocatedRoom). With an overall budget every line is in it, so
 * nothing is outside.
 */
export function spentOutsideBudgets(spent: BudgetSpent, budget: Pick<PeriodBudget, "overallBudget" | "byCategory">): number {
  if (budget.overallBudget !== null) return 0;
  let total = 0;
  for (const [categoryId, line] of spent.byCategory) {
    if (categoryId === null || (budget.byCategory.get(categoryId) ?? 0) <= 0) total += line.spent;
  }
  return round2(total);
}
