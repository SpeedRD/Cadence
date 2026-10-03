/**
 * The inputs of the one history window (K9, src/lib/history-window.ts): the
 * first recorded spending and Settings' "count history from" date.
 */
import { prisma } from "@/lib/prisma";
import { MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX } from "@/lib/transactions";

import type { HistoryBounds } from "@/lib/history-window";
import type { AppContext } from "@/lib/data/context";

/**
 * The earliest date Cadence has any recorded *spending* for: the first
 * expense that is not a goal contribution's ledger twin.
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
 *
 * A goal contribution is saving, not spending, for the same reason - so
 * neither the GoalContribution row nor the expense that carries its money (its
 * twin) opens a period. The twin is the hand-logged contribution's MANUAL row
 * (externalId "goal-contribution:<id>"), the RECURRING row posting wrote for a
 * contribution occurrence, or the charge the user entered that settled one:
 * the last two are told from a subscription's rows, which share their key
 * shape, only by a GoalContribution carrying the key (the rule monthly.ts
 * reads them by). A subscription's posted charge is spending.
 */
export async function getFirstActivityDate(): Promise<Date | null> {
  const contributionKeys = (
    await prisma.goalContribution.findMany({
      where: { recurringExternalId: { not: null } },
      select: { recurringExternalId: true },
    })
  ).map((row) => row.recurringExternalId as string);
  // Each clause says "is not that kind of twin" positively (a null externalId
  // or no settlement passes): a NOT over a nullable column would drop the
  // rows where it is NULL, plain expenses first among them.
  const first = await prisma.transaction.findFirst({
    where: {
      type: "EXPENSE",
      AND: [
        {
          OR: [
            { source: { not: "MANUAL" } },
            { externalId: null },
            { externalId: { not: { startsWith: MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX } } },
          ],
        },
        { OR: [{ source: { not: "RECURRING" } }, { externalId: null }, { externalId: { notIn: contributionKeys } }] },
        {
          OR: [
            { recurringSettlement: { is: null } },
            { recurringSettlement: { isNot: { occurrenceKey: { in: contributionKeys } } } },
          ],
        },
      ],
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  return first?.date ?? null;
}

/** Both bounds of the history window for the request's context. */
export async function loadHistoryBounds(context: AppContext): Promise<HistoryBounds> {
  return { historyStart: context.incomeHistoryStartDate ?? null, firstActivity: await getFirstActivityDate() };
}
