import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { periodForDate, periodKey, periodSeries, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { getFirstActivityDate } from "@/lib/data/monthly";

import type { AppContext } from "@/lib/data/context";

export interface TrendPoint {
  period: PeriodInfo;
  spent: number;
  income: number;
  /** The period is still in progress: its figures are what has happened so far, not a total. */
  partial: boolean;
}

/** Spending and income across the last `count` pay periods, oldest first. */
export async function getSpendingTrend(
  context: AppContext,
  count = 6,
): Promise<TrendPoint[]> {
  const periods = periodSeries(context.currentPeriod, count);
  const first = periods[0];
  const last = periods[periods.length - 1];

  const [transactions, checkins] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        date: { gte: first.start, lte: last.end },
        type: { in: ["EXPENSE", "INCOME"] },
      },
      select: { date: true, amount: true, currency: true, type: true, source: true },
    }),
    // Check-in income belongs to the period the check-in planned, not to the
    // day the money landed - pay for the second half of a month arrives in the
    // first. Same attribution as getPeriodSummary, so the two never disagree.
    prisma.paydayCheckin.findMany({
      where: {
        status: "CONFIRMED",
        OR: periods.map((period) => ({
          year: period.year,
          month: period.month,
          period: period.period,
        })),
      },
      select: {
        year: true,
        month: true,
        period: true,
        snapshots: { select: { incomeEntered: true, currency: true } },
      },
    }),
  ]);

  const buckets = new Map<string, { spent: number; income: number }>(
    periods.map((period) => [period.key, { spent: 0, income: 0 }]),
  );

  for (const transaction of transactions) {
    const bucket = buckets.get(periodForDate(transaction.date).key);
    if (!bucket) continue;
    if (transaction.type === "INCOME" && transaction.source === "PAYDAY_CHECKIN") continue;
    const amount = convert(
      num(transaction.amount),
      transaction.currency,
      context.displayCurrency,
      context.rates,
    );
    if (transaction.type === "INCOME") bucket.income += amount;
    else bucket.spent += amount;
  }

  for (const checkin of checkins) {
    const bucket = buckets.get(
      periodKey({ year: checkin.year, month: checkin.month, period: checkin.period }),
    );
    if (!bucket) continue;
    for (const snapshot of checkin.snapshots) {
      bucket.income += convert(
        num(snapshot.incomeEntered),
        snapshot.currency,
        context.displayCurrency,
        context.rates,
      );
    }
  }

  return periods.map((period) => ({
    period,
    spent: round2(buckets.get(period.key)?.spent ?? 0),
    income: round2(buckets.get(period.key)?.income ?? 0),
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
