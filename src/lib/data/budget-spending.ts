/**
 * Loads budget spending (QUANTITIES_MAP.md K6) - the population and the rules
 * are in src/lib/budget-spending.ts. getPeriodSummary reads the same rows for
 * its other figures and runs budgetSpentFrom itself; this is for the readers
 * that need only budget spending, over several periods at once (the category
 * suggestions).
 */
import { convert } from "@/lib/currency";
import {
  budgetSpentFrom,
  type BudgetSpent,
  type SpendingCategory,
  type SpendingRow,
} from "@/lib/budget-spending";
import { num, type DecimalLike } from "@/lib/money";
import { periodInfo, type PeriodRef } from "@/lib/period";
import { prisma } from "@/lib/prisma";

import type { AppContext } from "@/lib/data/context";
import type { RecurringKind } from "@/generated/prisma/enums";

/** The Transaction fields a SpendingRow is built from. */
export const SPENDING_ROW_SELECT = {
  date: true,
  amount: true,
  currency: true,
  categoryId: true,
  source: true,
  externalId: true,
  isExtraordinary: true,
  yourShare: true,
  recurringSettlement: { select: { kind: true } },
} as const;

export function spendingRowFrom(transaction: {
  amount: DecimalLike;
  currency: string;
  categoryId: string | null;
  source: string;
  externalId: string | null;
  isExtraordinary: boolean;
  yourShare: DecimalLike | null;
  recurringSettlement: { kind: RecurringKind } | null;
}): SpendingRow {
  return {
    amount: num(transaction.amount),
    currency: transaction.currency,
    categoryId: transaction.categoryId,
    source: transaction.source,
    externalId: transaction.externalId,
    isExtraordinary: transaction.isExtraordinary,
    yourShare: transaction.yourShare === null ? null : num(transaction.yourShare),
    settlementKind: transaction.recurringSettlement?.kind ?? null,
  };
}

/** Every category, keyed by id, as budget spending reads it. */
export async function loadSpendingCategories(): Promise<Map<string, SpendingCategory>> {
  const categories = await prisma.category.findMany({
    select: { id: true, kind: true, isSubscriptionDefault: true, isSavingsDefault: true },
  });
  return new Map(categories.map((category) => [category.id, category]));
}

/** budgetSpent() for each of `periods`, keyed by period key: one read of the rows over all of them. */
export async function loadBudgetSpent(
  periods: readonly PeriodRef[],
  context: Pick<AppContext, "displayCurrency" | "rates">,
): Promise<Map<string, BudgetSpent>> {
  const infos = periods.map(periodInfo);
  const result = new Map<string, BudgetSpent>();
  if (infos.length === 0) return result;
  const [transactions, categoryById] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "EXPENSE", OR: infos.map((period) => ({ date: { gte: period.start, lte: period.end } })) },
      select: SPENDING_ROW_SELECT,
    }),
    loadSpendingCategories(),
  ]);
  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);
  for (const period of infos) {
    const rows = transactions
      .filter((row) => row.date.getTime() >= period.start.getTime() && row.date.getTime() <= period.end.getTime())
      .map(spendingRowFrom);
    result.set(period.key, budgetSpentFrom(rows, categoryById, toDisplay));
  }
  return result;
}

/** budgetSpent(period) -> { total, byCategory }: the period's budget spending in the display currency. */
export async function budgetSpent(
  period: PeriodRef,
  context: Pick<AppContext, "displayCurrency" | "rates">,
): Promise<BudgetSpent> {
  const spent = await loadBudgetSpent([period], context);
  return spent.get(periodInfo(period).key) as BudgetSpent;
}
