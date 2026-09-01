import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { periodForDate, periodSeries, type PeriodInfo } from "@/lib/period";
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

  const transactions = await prisma.transaction.findMany({
    where: {
      date: { gte: first.start, lte: last.end },
      type: { in: ["EXPENSE", "INCOME"] },
    },
    select: { date: true, amount: true, currency: true, type: true },
  });

  const buckets = new Map<string, { spent: number; income: number }>(
    periods.map((period) => [period.key, { spent: 0, income: 0 }]),
  );

  for (const transaction of transactions) {
    const bucket = buckets.get(periodForDate(transaction.date).key);
    if (!bucket) continue;
    const amount = convert(
      num(transaction.amount),
      transaction.currency,
      context.displayCurrency,
      context.rates,
    );
    if (transaction.type === "INCOME") bucket.income += amount;
    else bucket.spent += amount;
  }

  return periods.map((period) => ({
    period,
    spent: round2(buckets.get(period.key)?.spent ?? 0),
    income: round2(buckets.get(period.key)?.income ?? 0),
  }));
}
