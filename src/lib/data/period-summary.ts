import { convert } from "@/lib/currency";
import { maxDate } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { daysRemainingInPeriod, periodRange, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";

import type { AppContext } from "@/lib/data/context";
import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

export interface CategoryLine {
  categoryId: string | null;
  name: string;
  color: string;
  spent: number;
  budget: number | null;
}

export interface CommittedItem {
  id: string;
  name: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  amount: number;
  nativeAmount: number;
  currency: string;
  nextDate: Date;
  categoryName: string | null;
  /** The account this item is funded from, if one is set - the payday planner groups due items by it. */
  accountId: string | null;
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
  spent: number;
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
 *                       due between today and the end of the period
 *   safeToSpend       = periodBudget - spent - committedOutflows
 *
 * Transfers are excluded throughout: only EXPENSE and INCOME rows are read.
 */
export async function getPeriodSummary(
  period: PeriodInfo,
  context: AppContext,
): Promise<PeriodSummary> {
  const { rates, displayCurrency } = context;
  const range = periodRange(period);

  const [budgets, transactions, categories, recurring] = await Promise.all([
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
    prisma.transaction.findMany({
      where: { date: range, type: { in: ["EXPENSE", "INCOME"] } },
      select: {
        amount: true,
        currency: true,
        type: true,
        categoryId: true,
      },
    }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.recurringItem.findMany({
      where: {
        active: true,
        nextDate: { gte: maxDate(context.today, period.start), lte: period.end },
      },
      include: { category: { select: { name: true } } },
      orderBy: { nextDate: "asc" },
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

  const spentByCategory = new Map<string | null, number>();
  let spent = 0;
  let income = 0;
  for (const transaction of transactions) {
    const amount = toDisplay(num(transaction.amount), transaction.currency);
    if (transaction.type === "INCOME") {
      income += amount;
      continue;
    }
    spent += amount;
    const key = transaction.categoryId;
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + amount);
  }

  const committedItems: CommittedItem[] = recurring.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    frequency: item.frequency,
    amount: round2(toDisplay(num(item.amount), item.currency)),
    nativeAmount: num(item.amount),
    currency: item.currency,
    nextDate: item.nextDate,
    categoryName: item.category?.name ?? null,
    accountId: item.accountId,
  }));
  const committed = round2(
    committedItems.reduce((total, item) => total + item.amount, 0),
  );

  const periodBudget = overallBudget ?? categoryBudgetTotal;
  const hasBudget = overallBudget !== null || categoryBudgetTotal > 0;
  const daysRemaining = daysRemainingInPeriod(context.today, period);
  const safeToSpend = round2(periodBudget - spent - committed);
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
      budget: budgetByCategory.get(category.id) ?? null,
    }));

  const uncategorized = spentByCategory.get(null);
  if (uncategorized) {
    lines.push({
      categoryId: null,
      name: "Uncategorized",
      color: "#7a8590",
      spent: round2(uncategorized),
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
    income: round2(income),
    committed,
    committedItems,
    safeToSpend,
    safeToSpendPerDay,
    daysRemaining,
    categories: lines.sort((a, b) => b.spent - a.spent),
  };
}
