/**
 * Loads what planSettlements (src/lib/recurring-settlement.ts) needs and runs
 * it: the verdict on every still-unclaimed occurrence of every active item,
 * due on or before `through`. Recurring posting calls it with today, the
 * period commitments (src/lib/data/period-commitments.ts - what the payday
 * check-in and every other reader of a period's items use) with the last
 * day of the periods they cover; the matcher's due-date ordering is what
 * makes the two agree on every occurrence both cover.
 */
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { advanceDate } from "@/lib/recurring";
import {
  planSettlements,
  recurringExternalId,
  settlementSpan,
  type SettlementCharge,
  type SettlementItem,
  type SettlementOccurrence,
} from "@/lib/recurring-settlement";
import { manualContributionIdFromTransaction } from "@/lib/transactions";

/** Never walk more occurrences of one item than this, however far behind it has fallen. */
const MAX_SETTLEMENT_WALK = 400;

/** A candidate charge as posting needs it to record the settlement and, for a contribution, its GoalContribution. */
export interface PlannedCharge {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  /** What the charge was entered as, when that was another currency than its account's (K7). */
  originalAmount: number | null;
  originalCurrency: string | null;
  accountId: string;
  /** A hand-logged contribution's own expense: its GoalContribution already exists. */
  isContributionTwin: boolean;
}

export interface SettlementPlan {
  /** Occurrences whose RECURRING row already exists (a nextDate moved back onto a posted day). */
  posted: Set<string>;
  /** The charge that already paid each settled occurrence, by recurringExternalId. */
  settledBy: Map<string, PlannedCharge>;
}

export async function loadSettlementPlan(through: Date): Promise<SettlementPlan> {
  const plan: SettlementPlan = { posted: new Set(), settledBy: new Map() };

  const rows = await prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lte: through } },
    select: {
      id: true,
      name: true,
      amount: true,
      currency: true,
      categoryId: true,
      kind: true,
      goalId: true,
      frequency: true,
      nextDate: true,
      anchorDay: true,
      secondAnchorDay: true,
      remainingOccurrences: true,
    },
  });
  if (rows.length === 0) return plan;

  // Every unclaimed due date through `through`, before the countdown: an
  // occurrence whose RECURRING row already exists is rolled past without
  // spending an installment (see postOccurrence), so it cannot count against
  // remainingOccurrences here either.
  const walks = rows.map((row) => {
    const dates: Date[] = [];
    let cursor = row.nextDate;
    for (let i = 0; i < MAX_SETTLEMENT_WALK && cursor.getTime() <= through.getTime(); i += 1) {
      dates.push(cursor);
      cursor = advanceDate(cursor, row.frequency, row.anchorDay, row.secondAnchorDay);
    }
    return { row, dates };
  });
  const keys = walks.flatMap(({ row, dates }) => dates.map((due) => recurringExternalId(row.id, due)));
  for (const posted of await prisma.transaction.findMany({
    where: { source: "RECURRING", externalId: { in: keys } },
    select: { externalId: true },
  })) {
    plan.posted.add(posted.externalId as string);
  }

  const occurrences: SettlementOccurrence[] = [];
  for (const { row, dates } of walks) {
    let left = row.remainingOccurrences ?? Number.POSITIVE_INFINITY;
    for (const due of dates) {
      if (left <= 0) break;
      if (plan.posted.has(recurringExternalId(row.id, due))) continue;
      occurrences.push({ itemId: row.id, due });
      left -= 1;
    }
  }
  const span = settlementSpan(occurrences.map((occurrence) => occurrence.due));
  if (!span) return plan;

  // The look-alike guard is judged over every active item, not only the ones
  // with something due by `through`.
  const guardRows = await prisma.recurringItem.findMany({
    where: { active: true },
    select: { id: true, name: true, amount: true, currency: true, categoryId: true, kind: true, goalId: true },
  });
  const items: SettlementItem[] = guardRows.map((row) => ({
    ...row,
    amount: num(row.amount),
    goalId: row.kind === "CONTRIBUTION" ? row.goalId : null,
  }));

  const chargeRows = await prisma.transaction.findMany({
    where: {
      type: "EXPENSE",
      source: { not: "RECURRING" },
      recurringSettlement: { is: null },
      date: { gte: span.start, lte: span.end },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      currency: true,
      originalAmount: true,
      originalCurrency: true,
      categoryId: true,
      note: true,
      accountId: true,
      source: true,
      externalId: true,
    },
  });
  const twinContributionIds = chargeRows
    .map((row) => manualContributionIdFromTransaction(row))
    .filter((id): id is string => id !== null);
  const goalByContributionId = new Map(
    twinContributionIds.length
      ? (
          await prisma.goalContribution.findMany({
            where: { id: { in: twinContributionIds } },
            select: { id: true, goalId: true },
          })
        ).map((contribution) => [contribution.id, contribution.goalId])
      : [],
  );

  const charges: SettlementCharge[] = [];
  const plannedById = new Map<string, PlannedCharge>();
  for (const row of chargeRows) {
    const contributionId = manualContributionIdFromTransaction(row);
    const contributionGoalId = contributionId === null ? null : (goalByContributionId.get(contributionId) ?? null);
    // A contribution's own expense whose contribution is gone belongs to no
    // goal any more; it is nobody's payment of anything.
    if (contributionId !== null && contributionGoalId === null) continue;
    const amount = num(row.amount);
    const originalAmount = row.originalAmount === null ? null : num(row.originalAmount);
    charges.push({
      id: row.id,
      date: row.date,
      amount,
      currency: row.currency,
      originalAmount,
      originalCurrency: row.originalCurrency,
      categoryId: row.categoryId,
      note: row.note,
      contributionGoalId,
    });
    plannedById.set(row.id, {
      id: row.id,
      date: row.date,
      amount,
      currency: row.currency,
      originalAmount,
      originalCurrency: row.originalCurrency,
      accountId: row.accountId,
      isContributionTwin: contributionId !== null,
    });
  }

  for (const [key, chargeId] of planSettlements({ items, occurrences, charges })) {
    plan.settledBy.set(key, plannedById.get(chargeId) as PlannedCharge);
  }
  return plan;
}
