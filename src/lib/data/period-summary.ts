import { convert } from "@/lib/currency";
import { maxDate } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { daysRemainingInPeriod, periodRange, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { owedOccurrences } from "@/lib/recurring";
import { manualContributionIdFromTransaction } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

export interface CategoryLine {
  categoryId: string | null;
  name: string;
  color: string;
  spent: number;
  /**
   * The part of `spent` from transactions the user confirmed as extraordinary
   * (Transaction.isExtraordinary). Still real spending, so it stays inside
   * `spent` for every actual figure; the payday planner's category average
   * subtracts it to estimate typical spending. 0 on a line built from rows
   * that already left such transactions out.
   */
  extraordinarySpent: number;
  /**
   * The part of `spent` that was other people's share of shared expenses
   * (amount - Transaction.yourShare, see src/lib/shared-expense.ts). Like
   * `extraordinarySpent`, still inside `spent` for every actual figure and
   * subtracted only by the averages that estimate typical spending, so they
   * read the user's own cost. A row that is also a confirmed one-off is
   * already wholly in `extraordinarySpent` and adds nothing here. 0 on a
   * line built from rows that already read the share in place of the amount.
   */
  othersShareSpent: number;
  /**
   * `spent` minus any RECURRING-sourced rows (an auto-posted subscription or
   * contribution charge, already committed at payday-planning time - see
   * outsideBudget in getPeriodSummary). `spent` itself stays the complete,
   * factual figure Reports reads as what was really spent, source included;
   * this one exists only for callers averaging what a category usually
   * costs organically, e.g. getCategorySuggestions, so a subscription filed
   * under a flexible category never leaks into recommending more of it.
   * Equal to `spent` on a line already built from non-RECURRING rows only
   * (e.g. monthly.ts's lifestyleByCategory, which excludes them earlier).
   */
  spentExcludingRecurring: number;
  budget: number | null;
}

export interface CommittedItem {
  id: string;
  name: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  /** Every occurrence owed in this window, in the display currency. */
  amount: number;
  /** The same total in the item's own currency. */
  nativeAmount: number;
  /** One occurrence's charge in the item's own currency. */
  perOccurrenceAmount: number;
  /** How many occurrences of this item the window owes. */
  occurrenceCount: number;
  currency: string;
  nextDate: Date;
  /** The item's due date has passed and posting has not been able to clear it. */
  overdue: boolean;
  categoryName: string | null;
  /** The account this item is funded from, if one is set - the payday planner groups due items by it. */
  accountId: string | null;
  /** CONTRIBUTION only: the goal it pays into, so a goal is not reserved for twice. */
  goalId: string | null;
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
   * Spending the period budget is answerable for. Excludes what the budget was
   * never asked to cover: automatically posted recurring charges, and anything
   * in a subscription or savings category. See the note above safeToSpend.
   */
  spent: number;
  /** Every expense in the period, whether budgeted or not. */
  totalSpent: number;
  income: number;
  committed: number;
  committedItems: CommittedItem[];
  safeToSpend: number;
  safeToSpendPerDay: number;
  daysRemaining: number;
  categories: CategoryLine[];
}

/**
 * Everything the dashboard and the budgets page need for one pay period.
 *
 *   committedOutflows = active recurring items (subscriptions + contributions)
 *                       still owed before the period ends
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

  const [budgets, transactions, categories, recurring, checkin] = await Promise.all([
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
    prisma.transaction.findMany({
      where: { date: range, type: { in: ["EXPENSE", "INCOME"] } },
      select: {
        amount: true,
        currency: true,
        type: true,
        source: true,
        externalId: true,
        categoryId: true,
        isExtraordinary: true,
        yourShare: true,
      },
    }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    // Overdue items are still owed. The posting job leaves an item it cannot
    // post (no account, archived account, no goal) exactly where it is, so
    // filtering on nextDate >= today made it disappear from this figure the day
    // after it fell due, with no charge to replace it.
    prisma.recurringItem.findMany({
      where: { active: true, nextDate: { lte: period.end } },
      include: { category: { select: { name: true } } },
      orderBy: { nextDate: "asc" },
    }),
    // A paycheck belongs to the period its check-in planned, not to the day it
    // landed: pay for the 16th-31st arrives on the 15th, which is the period
    // before. The Transaction keeps the real date so the ledger still matches
    // the bank; only this attribution moves.
    prisma.paydayCheckin.findFirst({
      where: {
        year: period.year,
        month: period.month,
        period: period.period,
        status: "CONFIRMED",
      },
      select: { snapshots: { select: { incomeEntered: true, currency: true } } },
    }),
  ]);

  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, displayCurrency, rates);

  const overallBudgetRow = budgets.find((budget) => budget.categoryId === null);
  const overallBudget = overallBudgetRow
    ? round2(toDisplay(num(overallBudgetRow.amount), overallBudgetRow.currency))
    : null;

  const budgetByCategory = new Map<string, number>();
  for (const budget of budgets) {
    if (!budget.categoryId) continue;
    budgetByCategory.set(
      budget.categoryId,
      round2(toDisplay(num(budget.amount), budget.currency)),
    );
  }
  const categoryBudgetTotal = round2(
    [...budgetByCategory.values()].reduce((total, value) => total + value, 0),
  );

  // Categories the payday planner never budgets for (it filters both of these
  // out when it builds its essential and flexible lists), so spending in them
  // is not spending against the period budget either.
  const outsideBudgetCategoryIds = new Set(
    categories
      .filter((category) => category.isSubscriptionDefault || category.isSavingsDefault)
      .map((category) => category.id),
  );
  // Only an expense category can carry a breakdown line. An expense filed under
  // an income category (the transaction form offers every category) counted in
  // `spent` but matched no line, so the lines never added up to the total; it
  // joins the Uncategorized line instead of disappearing from the breakdown.
  const expenseCategoryIds = new Set(
    categories.filter((category) => category.kind === "EXPENSE").map((category) => category.id),
  );

  const spentByCategory = new Map<string | null, number>();
  // Confirmed one-offs, by the same key: reported beside each line's spending
  // (never subtracted from it) so an average can leave them out.
  const extraordinaryByCategory = new Map<string | null, number>();
  // Other people's share of shared expenses, by the same key and on the same
  // terms: reported beside the spending so an average can read the user's own
  // cost. The full amount stays in every actual figure below - it is what
  // left the account.
  const othersShareByCategory = new Map<string | null, number>();
  // spentByCategory minus RECURRING-sourced rows: a RECURRING posting was
  // already committed at payday-planning time (like `spent` below excludes it
  // via outsideBudget), so it must not also inflate getCategorySuggestions'
  // average for whatever category it happens to be filed under - a
  // subscription filed under a flexible category (e.g. "Entertainment"
  // instead of "Subscriptions") would otherwise leak its full amount into
  // that category's suggested budget every period. `spentByCategory` itself
  // stays the complete, factual figure Reports reads as what was really
  // spent; this parallel map exists only to feed CategoryLine.spentExcludingRecurring,
  // getCategorySuggestions' own averaging input. Mirrors, rather than reuses,
  // computeMonthActuals in monthly.ts, which already skips every RECURRING
  // row before building its own category map.
  const spentByCategoryExcludingRecurring = new Map<string | null, number>();
  let spent = 0;
  let totalSpent = 0;
  let income = 0;
  for (const transaction of transactions) {
    const amount = toDisplay(num(transaction.amount), transaction.currency);
    if (transaction.type === "INCOME") {
      // Check-in income is added below, from the check-in that planned it.
      if (transaction.source !== "PAYDAY_CHECKIN") income += amount;
      continue;
    }
    totalSpent += amount;

    // A manual goal contribution's paired expense (source MANUAL, externalId
    // "goal-contribution:<id>" - see logManualContribution in src/lib/goals.ts)
    // is never spending: the GoalContribution it moved money for already
    // counts it as savings. Filing it under a savings/subscription category
    // (isSavingsDefault/isSubscriptionDefault, below) is what keeps it out
    // today, but that category assignment is an editable field, not an
    // identity - a direct database edit could reassign it. Checking the row
    // itself, the same way transactionEditBlock and hasLinkedGoalContribution
    // already do, closes that gap: the row stays excluded from budget
    // spending (and from leaking into a category's average, e.g.
    // getCategorySuggestions) however its category ends up.
    const inSavingsOrSubscriptionCategory =
      transaction.categoryId !== null && outsideBudgetCategoryIds.has(transaction.categoryId);
    const isManualContributionTwin = manualContributionIdFromTransaction(transaction) !== null;
    const isRecurringPosting = transaction.source === "RECURRING";

    // The per-category breakdown stays complete whatever the budget covers -
    // the Reports page and the budget rows both read it - so a manual
    // contribution twin still appears under its own category exactly as
    // before, as long as that is still a savings/subscription category. Only
    // when it has been reassigned away from one (the state above) does it
    // stop counting as spending in the new category too, rather than
    // quietly inflating that category's total and any average built from it.
    // A RECURRING posting stays in this figure too, on the same principle
    // `totalSpent` already follows: this is the real, factual record of what
    // was spent, source included. See spentByCategoryExcludingRecurring above
    // for the figure that leaves RECURRING rows out.
    if (!isManualContributionTwin || inSavingsOrSubscriptionCategory) {
      const key =
        transaction.categoryId !== null && expenseCategoryIds.has(transaction.categoryId)
          ? transaction.categoryId
          : null;
      spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + amount);
      if (!isRecurringPosting) {
        spentByCategoryExcludingRecurring.set(key, (spentByCategoryExcludingRecurring.get(key) ?? 0) + amount);
      }
      if (transaction.isExtraordinary) {
        extraordinaryByCategory.set(key, (extraordinaryByCategory.get(key) ?? 0) + amount);
      } else if (transaction.yourShare !== null) {
        // A one-off's whole amount is already set aside above; only an
        // ordinary shared expense has a part to report here.
        const othersShare = amount - toDisplay(num(transaction.yourShare), transaction.currency);
        othersShareByCategory.set(key, (othersShareByCategory.get(key) ?? 0) + othersShare);
      }
    }

    const outsideBudget = isRecurringPosting || inSavingsOrSubscriptionCategory || isManualContributionTwin;
    if (!outsideBudget) spent += amount;
  }

  income += (checkin?.snapshots ?? []).reduce(
    (total, snapshot) => total + toDisplay(num(snapshot.incomeEntered), snapshot.currency),
    0,
  );

  // From today when the period is under way, from its start when it is still
  // ahead; an already-finished period owes nothing.
  const owedFrom = maxDate(context.today, period.start);
  const committedItems: CommittedItem[] = recurring
    .map((item) => {
      const occurrences = owedOccurrences(item, owedFrom, period.end);
      const perOccurrenceAmount = num(item.amount);
      return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        frequency: item.frequency,
        amount: round2(toDisplay(perOccurrenceAmount, item.currency) * occurrences.length),
        nativeAmount: round2(perOccurrenceAmount * occurrences.length),
        perOccurrenceAmount,
        occurrenceCount: occurrences.length,
        currency: item.currency,
        nextDate: item.nextDate,
        overdue: item.nextDate.getTime() < owedFrom.getTime(),
        categoryName: item.category?.name ?? null,
        accountId: item.accountId,
        goalId: item.kind === "CONTRIBUTION" ? item.goalId : null,
      };
    })
    .filter((item) => item.occurrenceCount > 0);
  const committed = round2(
    committedItems.reduce((total, item) => total + item.amount, 0),
  );

  const periodBudget = overallBudget ?? categoryBudgetTotal;
  const hasBudget = overallBudget !== null || categoryBudgetTotal > 0;
  const daysRemaining = daysRemainingInPeriod(context.today, period);
  const safeToSpend = round2(periodBudget - spent);
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
      extraordinarySpent: round2(extraordinaryByCategory.get(category.id) ?? 0),
      othersShareSpent: round2(othersShareByCategory.get(category.id) ?? 0),
      spentExcludingRecurring: round2(spentByCategoryExcludingRecurring.get(category.id) ?? 0),
      budget: budgetByCategory.get(category.id) ?? null,
    }));

  const uncategorized = spentByCategory.get(null);
  if (uncategorized) {
    lines.push({
      categoryId: null,
      name: "Uncategorized",
      color: "#7a8590",
      spent: round2(uncategorized),
      extraordinarySpent: round2(extraordinaryByCategory.get(null) ?? 0),
      othersShareSpent: round2(othersShareByCategory.get(null) ?? 0),
      spentExcludingRecurring: round2(spentByCategoryExcludingRecurring.get(null) ?? 0),
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
    spent: round2(spent),
    totalSpent: round2(totalSpent),
    income: round2(income),
    committed,
    committedItems,
    safeToSpend,
    safeToSpendPerDay,
    daysRemaining,
    categories: lines.sort((a, b) => b.spent - a.spent),
  };
}
