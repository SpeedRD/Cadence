import { convert } from "@/lib/currency";
import { addDays } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import { getPeriodSummary, type PeriodSummary } from "@/lib/data/period-summary";
import { listGoals, type GoalSummary } from "@/lib/data/goals";

import type { AppContext } from "@/lib/data/context";
import type { RecurringKind } from "@/generated/prisma/enums";

export interface UpcomingItem {
  id: string;
  name: string;
  kind: RecurringKind;
  amount: number;
  nativeAmount: number;
  currency: string;
  nextDate: Date;
  categoryName: string | null;
}

export interface DashboardData {
  summary: PeriodSummary;
  upcoming: UpcomingItem[];
  goals: GoalSummary[];
}

export const UPCOMING_WINDOW_DAYS = 7;

export async function getDashboardData(
  context: AppContext,
): Promise<DashboardData> {
  const [summary, upcomingRows, goals] = await Promise.all([
    getPeriodSummary(context.currentPeriod, context),
    prisma.recurringItem.findMany({
      where: {
        active: true,
        nextDate: {
          gte: context.today,
          lte: addDays(context.today, UPCOMING_WINDOW_DAYS),
        },
      },
      include: { category: { select: { name: true } } },
      orderBy: { nextDate: "asc" },
    }),
    listGoals(context),
  ]);

  const upcoming: UpcomingItem[] = upcomingRows.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    amount: round2(
      convert(
        num(item.amount),
        item.currency,
        context.displayCurrency,
        context.rates,
      ),
    ),
    nativeAmount: num(item.amount),
    currency: item.currency,
    nextDate: item.nextDate,
    categoryName: item.category?.name ?? null,
  }));

  return { summary, upcoming, goals };
}
