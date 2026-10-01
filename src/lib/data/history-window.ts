/**
 * The inputs of the one history window (K9, src/lib/history-window.ts): the
 * first recorded activity and Settings' "count history from" date.
 */
import { prisma } from "@/lib/prisma";

import type { HistoryBounds } from "@/lib/history-window";
import type { AppContext } from "@/lib/data/context";

/**
 * The earliest date Cadence has any recorded financial *activity* for.
 *
 * Only cashflow counts. An OPENING_BALANCE dated "as of" some date long before
 * the user started using Cadence is a starting position, not a month of
 * spending, and letting it in opened months of fabricated history: every one of
 * them scored zero lifestyle spending while still collecting each recurring
 * item's scheduled amount, which both deflated the lifestyle average and
 * inflated the committed one.
 */
export async function getFirstActivityDate(): Promise<Date | null> {
  const [txMin, goalMin] = await Promise.all([
    prisma.transaction.aggregate({
      _min: { date: true },
      where: { type: { in: ["EXPENSE", "INCOME"] } },
    }),
    prisma.goalContribution.aggregate({ _min: { date: true } }),
  ]);
  const dates = [txMin._min.date, goalMin._min.date].filter((d): d is Date => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((earliest, date) => (date.getTime() < earliest.getTime() ? date : earliest));
}

/** Both bounds of the history window for the request's context. */
export async function loadHistoryBounds(context: AppContext): Promise<HistoryBounds> {
  return { historyStart: context.incomeHistoryStartDate ?? null, firstActivity: await getFirstActivityDate() };
}
