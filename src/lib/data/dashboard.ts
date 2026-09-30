import { addDays } from "@/lib/date";
import { round2 } from "@/lib/money";
import { nextPeriod, periodForDate, periodInfo, type PeriodInfo } from "@/lib/period";
import { byItem, sumOccurrences, type CommitmentOccurrence } from "@/lib/period-commitments";
import type { RecurringSkipReason } from "@/lib/recurring";

import { loadCommitments } from "@/lib/data/period-commitments";
import { getPeriodSummary, type PeriodSummary } from "@/lib/data/period-summary";
import { listGoals, type GoalSummary } from "@/lib/data/goals";

import type { AppContext } from "@/lib/data/context";
import type { RecurringKind } from "@/generated/prisma/enums";

export interface UpcomingItem {
  id: string;
  name: string;
  kind: RecurringKind;
  /** Its occurrences due in the window, in the display currency - one charge for an item posting will skip. */
  amount: number;
  nativeAmount: number;
  currency: string;
  /** The first of them. */
  nextDate: Date;
  /** One of them was due before today and posting has not been able to clear it. */
  overdue: boolean;
  /** Set when posting will skip the item: it is listed with the reason, and it charges nothing. */
  wontPostReason: RecurringSkipReason | null;
}

export interface DashboardData {
  summary: PeriodSummary;
  upcoming: UpcomingItem[];
  goals: GoalSummary[];
}

export const UPCOMING_WINDOW_DAYS = 7;

/**
 * The next seven days (today plus six) of the period commitments
 * (src/lib/period-commitments.ts): every occurrence still to leave - a
 * backlog posting has not cleared included, so an unposted charge never
 * quietly drops off the list - one row per item. An item posting will skip
 * is listed too, with its reason, since nothing will be charged for it.
 */
export async function getDashboardData(
  context: AppContext,
): Promise<DashboardData> {
  const windowEnd = addDays(context.today, UPCOMING_WINDOW_DAYS - 1);
  const periods: PeriodInfo[] = [periodForDate(context.today)];
  while (periods[periods.length - 1].end.getTime() < windowEnd.getTime()) {
    periods.push(periodInfo(nextPeriod(periods[periods.length - 1])));
  }
  const [summary, commitments, goals] = await Promise.all([
    getPeriodSummary(context.currentPeriod, context),
    loadCommitments(periods, context),
    listGoals(context),
  ]);

  const due = periods
    .flatMap((period) => commitments.get(period.key) ?? [])
    .filter(
      (occurrence) =>
        (occurrence.status === "outstanding" || occurrence.status === "wont_post") &&
        occurrence.dueDate.getTime() <= windowEnd.getTime(),
    );
  const amountOf = (occurrence: CommitmentOccurrence) => occurrence.amount;
  const upcoming: UpcomingItem[] = byItem(due).map((all) => {
    const first = all[0];
    // What is owed is every occurrence in the window; an item that will not
    // post owes nothing, so it shows the one charge it is listed for.
    const group = first.wontPostReason ? [first] : all;
    return {
      id: first.itemId,
      name: first.name,
      kind: first.kind,
      amount: round2(sumOccurrences(group, context.displayCurrency, context.rates, amountOf)),
      nativeAmount: round2(sumOccurrences(group, first.itemCurrency, context.rates, amountOf)),
      currency: first.itemCurrency,
      nextDate: first.dueDate,
      overdue: group.some((occurrence) => occurrence.backlog),
      wontPostReason: first.wontPostReason,
    };
  });

  return { summary, upcoming, goals };
}
