import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { daysRemainingInPeriod, periodRange, type PeriodInfo } from "@/lib/period";
import {
  byItem,
  outstanding,
  outstandingAmount,
  sumOccurrences,
  wontPost,
  type CommitmentOccurrence,
} from "@/lib/period-commitments";
import { prisma } from "@/lib/prisma";
import type { RecurringSkipReason } from "@/lib/recurring";
import {
  budgetSpentFrom,
  inUnbudgetedCategory,
  isContributionTwin,
  ownCost,
  periodBudgetFrom,
  spendingLineKey,
} from "@/lib/budget-spending";

import { SPENDING_ROW_SELECT, spendingRowFrom } from "@/lib/data/budget-spending";
import { loadPeriodIncome } from "@/lib/data/period-income";
import { periodCommitments } from "@/lib/data/period-commitments";

import type { AppContext } from "@/lib/data/context";
import type { RecurringKind } from "@/generated/prisma/enums";

/** One category's spending, as a breakdown bar shows it (Reports, the monthly averages). */
export interface SpendingLine {
  categoryId: string | null;
  name: string;
  color: string;
  /**
   * Every expense in the category, at the user's own cost: a shared expense
   * counts at its share (ownCost in src/lib/budget-spending.ts). Recurring
   * charges stay in - the "total" view Reports shows.
   */
  spent: number;
}

/** A period's line for one category: the total view beside budget spending and the budget. */
export interface CategoryLine extends SpendingLine {
  /**
   * Budget spending in the category (K6, src/lib/budget-spending.ts): what
   * the Budgets page's row shows. The lines' figures add up to the overall
   * `spent`.
   */
  budgetSpent: number;
  budget: number | null;
}

/**
 * One item's outstanding occurrences in the period (see
 * src/lib/period-commitments.ts): what "Committed" still expects to leave.
 */
export interface CommittedItem {
  id: string;
  name: string;
  kind: RecurringKind;
  /** Every outstanding occurrence in the period, in the display currency. */
  amount: number;
  /** The same total in the item's own currency. */
  nativeAmount: number;
  /** One occurrence's charge in the item's own currency. */
  perOccurrenceAmount: number;
  /** How many outstanding occurrences of this item the period holds. */
  occurrenceCount: number;
  /** Their due dates (occurrenceCount of them), in order - a backlog first. */
  occurrenceDates: Date[];
  currency: string;
  /** The first of occurrenceDates. */
  nextDate: Date;
  /** One of them was due before today and posting has not cleared it. */
  overdue: boolean;
  /** The account this item is funded from, if one is set - the payday planner groups due items by it. */
  accountId: string | null;
  /** CONTRIBUTION only: the goal it pays into, so a goal is not reserved for twice. */
  goalId: string | null;
}

/** An item with occurrences in the period that posting will skip: listed, never counted. */
export interface WontPostItem {
  id: string;
  name: string;
  kind: RecurringKind;
  reason: RecurringSkipReason;
  dueDates: Date[];
  /** What its occurrences would have cost, in the display currency - counted nowhere. */
  amount: number;
  nativeAmount: number;
  currency: string;
}

/** Occurrences of one item grouped into a CommittedItem, amounts summed as they stand. */
export function committedItemFrom(
  group: readonly CommitmentOccurrence[],
  context: Pick<AppContext, "displayCurrency" | "rates">,
  amountOf: (occurrence: CommitmentOccurrence) => number = outstandingAmount,
): CommittedItem {
  const first = group[0];
  return {
    id: first.itemId,
    name: first.name,
    kind: first.kind,
    amount: round2(sumOccurrences(group, context.displayCurrency, context.rates, amountOf)),
    nativeAmount: round2(sumOccurrences(group, first.itemCurrency, context.rates, amountOf)),
    perOccurrenceAmount: first.itemAmount,
    occurrenceCount: group.length,
    occurrenceDates: group.map((occurrence) => occurrence.dueDate),
    currency: first.itemCurrency,
    nextDate: first.dueDate,
    overdue: group.some((occurrence) => occurrence.backlog),
    accountId: first.accountId,
    goalId: first.goalId,
  };
}

/** The period's wont_post occurrences, one row per item with the reason posting gives. */
export function wontPostItemsFrom(
  occurrences: readonly CommitmentOccurrence[],
  context: Pick<AppContext, "displayCurrency" | "rates">,
): WontPostItem[] {
  return byItem(wontPost(occurrences)).map((group) => {
    const first = group[0];
    const amountOf = (occurrence: CommitmentOccurrence) => occurrence.amount;
    return {
      id: first.itemId,
      name: first.name,
      kind: first.kind,
      reason: first.wontPostReason as RecurringSkipReason,
      dueDates: group.map((occurrence) => occurrence.dueDate),
      amount: round2(sumOccurrences(group, context.displayCurrency, context.rates, amountOf)),
      nativeAmount: round2(sumOccurrences(group, first.itemCurrency, context.rates, amountOf)),
      currency: first.itemCurrency,
    };
  });
}

export interface PeriodSummary {
  period: PeriodInfo;
  currency: string;
  /** Explicit overall budget for the period, if one is set. */
  overallBudget: number | null;
  categoryBudgetTotal: number;
  /** overallBudget when set, otherwise the sum of the category budgets. */
  periodBudget: number;
  hasBudget: boolean;
  /**
   * Budget spending (K6, src/lib/budget-spending.ts): what the period budget
   * is answerable for. Excludes what the budget was never asked to cover -
   * every row that stands for a recurring occurrence (an automatically posted
   * charge, or a charge the user entered that paid one), a hand-logged
   * contribution's own expense, and anything in a subscription or savings
   * category - and reads a shared expense at the user's share. See the note
   * above safeToSpend.
   */
  spent: number;
  /** Every expense in the period, whether budgeted or not, at the user's own cost (a shared expense at its share). */
  totalSpent: number;
  /** The period's income as a fact (K5, src/lib/period-income.ts): what arrived to fund it, in the display currency. */
  income: number;
  /** What the period's recurring items still expect to leave: its outstanding occurrences. */
  committed: number;
  committedItems: CommittedItem[];
  /** Every occurrence the period holds (src/lib/period-commitments.ts) - posted, settled, outstanding and wont_post. A plan for the period counts whole() of it. */
  commitments: CommitmentOccurrence[];
  /** Items posting will skip, left out of `committed`. */
  wontPostItems: WontPostItem[];
  safeToSpend: number;
  safeToSpendPerDay: number;
  daysRemaining: number;
  categories: CategoryLine[];
}

/**
 * Everything the dashboard and the budgets page need for one pay period.
 *
 *   committed         = the period's outstanding occurrences
 *                       (src/lib/period-commitments.ts): recurring items,
 *                       subscriptions and contributions, still to leave
 *                       before the period ends; what posted or was paid is
 *                       not, and neither is anything posting will skip
 *   safeToSpend       = periodBudget - spent
 *
 * The budget is a *net* figure: it denominates category spending, which is what
 * the payday planner writes Budget rows for, and it deliberately does not cover
 * subscriptions, recurring contributions, goal roadmaps or the protected
 * buffer - the plan subtracts all four before it arrives at what the categories
 * may have. Measuring against it therefore has to be net on both sides, so
 * `spent` counts only what the budget answers for and committed outflows are
 * not subtracted a second time. Subtracting them was the same money twice: once
 * when the plan set them aside, once when the charge arrived.
 *
 * Transfers are excluded throughout: only EXPENSE and INCOME rows are read.
 */
export async function getPeriodSummary(
  period: PeriodInfo,
  context: AppContext,
): Promise<PeriodSummary> {
  const { rates, displayCurrency } = context;
  const range = periodRange(period);

  const [budgets, transactions, categories, commitments, incomeByPeriod] = await Promise.all([
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
    prisma.transaction.findMany({
      where: { date: range, type: "EXPENSE" },
      select: SPENDING_ROW_SELECT,
    }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    periodCommitments(period, context),
    // The period's income on the one attribution (K5): a paycheck counts in
    // the period it funds - a check-in's in the period it planned, any other
    // from the payday it landed on - not in the calendar half it is dated in.
    loadPeriodIncome([period], "fact", context),
  ]);

  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, displayCurrency, rates);

  const { overallBudget, byCategory: budgetByCategory, categoryBudgetTotal, periodBudget, hasBudget } = periodBudgetFrom(
    budgets.map((row) => ({ categoryId: row.categoryId, amount: num(row.amount), currency: row.currency })),
    toDisplay,
  );

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const rows = transactions.map(spendingRowFrom);
  // The budget's figures - the overall spent and each category's row - are
  // one population (K6): what the plan did not already reserve.
  const budget = budgetSpentFrom(rows, categoryById, toDisplay);

  // The total view, by category: every expense at the user's own cost,
  // recurring charges included - what Reports shows as spent. A hand-logged
  // contribution's own expense keeps its line only while it is still filed
  // under a savings or subscription category; reassigned elsewhere it would
  // quietly inflate that category, so it is left out of the lines (it stays
  // in totalSpent, what left the accounts).
  const spentByCategory = new Map<string | null, number>();
  let totalSpent = 0;
  for (const row of rows) {
    const amount = toDisplay(ownCost(row), row.currency);
    totalSpent += amount;
    if (isContributionTwin(row) && !inUnbudgetedCategory(row, categoryById)) continue;
    const key = spendingLineKey(row, categoryById);
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + amount);
  }

  const income = incomeByPeriod.get(period.key)?.total ?? 0;

  // What is still to leave: the outstanding occurrences. Whatever already
  // posted or was paid by a charge the user entered is in the ledger, and an
  // item posting will skip is listed apart rather than counted.
  const committedItems = byItem(outstanding(commitments)).map((group) => committedItemFrom(group, context));
  const committed = round2(
    committedItems.reduce((total, item) => total + item.amount, 0),
  );
  const wontPostItems = wontPostItemsFrom(commitments, context);

  const daysRemaining = daysRemainingInPeriod(context.today, period);
  const safeToSpend = round2(periodBudget - budget.total);
  const safeToSpendPerDay = round2(
    Math.max(0, safeToSpend / Math.max(1, daysRemaining)),
  );

  const lines: CategoryLine[] = categories
    .filter(
      (category) =>
        category.kind === "EXPENSE" &&
        (budgetByCategory.has(category.id) || spentByCategory.has(category.id)),
    )
    .map((category) => ({
      categoryId: category.id,
      name: category.name,
      color: category.color,
      spent: round2(spentByCategory.get(category.id) ?? 0),
      budgetSpent: budget.byCategory.get(category.id)?.spent ?? 0,
      budget: budgetByCategory.get(category.id) ?? null,
    }));

  const uncategorized = spentByCategory.get(null);
  if (uncategorized) {
    lines.push({
      categoryId: null,
      name: "Uncategorized",
      color: "#7a8590",
      spent: round2(uncategorized),
      budgetSpent: budget.byCategory.get(null)?.spent ?? 0,
      budget: null,
    });
  }

  return {
    period,
    currency: displayCurrency,
    overallBudget,
    categoryBudgetTotal,
    periodBudget,
    hasBudget,
    spent: budget.total,
    totalSpent: round2(totalSpent),
    income: round2(income),
    committed,
    committedItems,
    commitments,
    wontPostItems,
    safeToSpend,
    safeToSpendPerDay,
    daysRemaining,
    categories: lines.sort((a, b) => b.spent - a.spent),
  };
}
