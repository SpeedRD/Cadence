import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { ownCost } from "@/lib/budget-spending";
import { periodForDate, periodSeries, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { getFirstActivityDate } from "@/lib/data/monthly";
import { loadPeriodIncome } from "@/lib/data/period-income";

import type { AppContext } from "@/lib/data/context";

export interface TrendPoint {
  period: PeriodInfo;
  spent: number;
  income: number;
  /** The period is still in progress: its figures are what has happened so far, not a total. */
  partial: boolean;
}

/**
 * Spending and income across the last `count` pay periods, oldest first.
 * Spending is every expense by its date at the user's own cost - a shared
 * expense at its share (ownCost in src/lib/budget-spending.ts), so the
 * average below reads what the monthly averages read - and income is the
 * period's income as a fact (K5, src/lib/period-income.ts), the figure
 * getPeriodSummary gives the hero, so the two never disagree.
 */
export async function getSpendingTrend(
  context: AppContext,
  count = 6,
): Promise<TrendPoint[]> {
  const periods = periodSeries(context.currentPeriod, count);
  const first = periods[0];
  const last = periods[periods.length - 1];

  const [transactions, income] = await Promise.all([
    prisma.transaction.findMany({
      where: { date: { gte: first.start, lte: last.end }, type: "EXPENSE" },
      select: { date: true, amount: true, currency: true, yourShare: true },
    }),
    loadPeriodIncome(periods, "fact", context),
  ]);

  const spent = new Map<string, number>(periods.map((period) => [period.key, 0]));
  for (const transaction of transactions) {
    const key = periodForDate(transaction.date).key;
    if (!spent.has(key)) continue;
    const cost = ownCost({
      amount: num(transaction.amount),
      yourShare: transaction.yourShare === null ? null : num(transaction.yourShare),
    });
    spent.set(key, (spent.get(key) ?? 0) + convert(cost, transaction.currency, context.displayCurrency, context.rates));
  }

  return periods.map((period) => ({
    period,
    spent: round2(spent.get(period.key) ?? 0),
    income: round2(income.get(period.key)?.total ?? 0),
    partial: period.end.getTime() >= context.today.getTime(),
  }));
}

export interface TrendAverage {
  average: number;
  /** How many completed periods the average is over. */
  periods: number;
}

/**
 * The mean spent per completed period: a period still in progress is left out
 * (a few days of spending read as a whole period drags the mean down), and so
 * is every period before the first recorded activity (the user was not using
 * Cadence yet, so it says nothing about what a period costs). Null when no
 * completed period is left - there is nothing to average.
 */
function averageOfCompletedPeriods(points: TrendPoint[], firstActivity: Date | null): TrendAverage | null {
  if (!firstActivity) return null;
  const counted = points.filter(
    (point) => !point.partial && point.period.end.getTime() >= firstActivity.getTime(),
  );
  if (counted.length === 0) return null;
  const total = counted.reduce((sum, point) => sum + point.spent, 0);
  return { average: round2(total / counted.length), periods: counted.length };
}

/** getSpendingTrend, with the average per completed period the Reports page shows beside it. */
export async function getSpendingTrendSummary(
  context: AppContext,
  count = 6,
): Promise<{ points: TrendPoint[]; average: TrendAverage | null }> {
  const [points, firstActivity] = await Promise.all([getSpendingTrend(context, count), getFirstActivityDate()]);
  return { points, average: averageOfCompletedPeriods(points, firstActivity) };
}
