/**
 * The inputs of the one history window (K9, src/lib/history-window.ts): the
 * first recorded spending and Settings' "count history from" date.
 */
import { prisma } from "@/lib/prisma";

import type { HistoryBounds } from "@/lib/history-window";
import type { AppContext } from "@/lib/data/context";

/**
 * The earliest date Cadence has any recorded *spending* for: the first
 * expense, or the first goal contribution if that is earlier.
 *
 * Only spending counts, because the date feeds the partial-first-period rule
 * of the spending averages (firstUsablePeriod) and the monthly windows. An
 * INCOME row is not a period of spending: a paycheck typed in July for Afford,
 * with spending logged only from September, opened July and August as periods
 * with nothing spent, and the average divided by them. An OPENING_BALANCE
 * dated "as of" some date long before the user started using Cadence is a
 * starting position, not a month of spending, for the same reason: every such
 * period scored zero lifestyle spending while still collecting each recurring
 * item's scheduled amount, which both deflated the lifestyle average and
 * inflated the committed one.
 */
export async function getFirstActivityDate(): Promise<Date | null> {
  const [txMin, goalMin] = await Promise.all([
    prisma.transaction.aggregate({
      _min: { date: true },
      where: { type: "EXPENSE" },
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
