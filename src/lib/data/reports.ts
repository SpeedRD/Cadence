import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { periodForDate, periodKey, periodSeries, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";

import type { AppContext } from "@/lib/data/context";

export interface TrendPoint {
  period: PeriodInfo;
  spent: number;
  income: number;
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
  }));
}
