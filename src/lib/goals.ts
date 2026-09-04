import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";

/**
 * Recompute Goal.savedAmount from its contributions - the source of truth - and
 * write the cached value back. Thin wrapper over rebuildGoalSaved() for the
 * callers that only need the total.
 *
 * Contributions are normally already in the goal's own currency: the manual
 * flow forces it, and recurring posting converts once when it writes the row
 * (see src/lib/recurring-posting.ts). The conversion below is for the case that
 * genuinely needs it, a goal whose currency the user has since changed, so the
 * usual rebuild is a plain sum that cannot move with the exchange rate.
 *
 * The read and the write share one transaction with a row lock on the goal.
 * Without it two contributions landing at once can each read the total before
 * the other's row is visible, and the slower writer then persists a
 * savedAmount that is missing a contribution - which also drags achievedAt
 * back and forth with it.
 */
export async function recomputeGoalSaved(goalId: string): Promise<number> {
  return (await rebuildGoalSaved(goalId)).saved;
}

/**
 * The same rebuild, reporting whether *this* call is the one that crossed the
 * target - i.e. the goal had no achievedAt going in and has one coming out.
 *
 * It has to be decided in here rather than by comparing before/after from the
 * caller: the row lock above is what makes the answer single-valued. Two
 * contributions landing together are serialised by it, so the first sees a null
 * achievedAt and reports the crossing, and the second sees the timestamp the
 * first wrote and reports nothing. A caller reading achievedAt outside the lock
 * could have both report it.
 */
export async function rebuildGoalSaved(
  goalId: string,
): Promise<{ saved: number; justAchieved: boolean }> {
  const exists = await prisma.goal.findUnique({
    where: { id: goalId },
    select: { id: true },
  });
  if (!exists) return { saved: 0, justAchieved: false };

  // Fetched before the transaction on purpose: getRateTable can call the rate
  // service and upsert ExchangeRate rows, and neither belongs inside a lock.
  // It is a single indexed read while the cached rates are fresh.
  const rates = await getRateTable();

  return prisma.$transaction(async (tx) => {
    // Serialises rebuilds for this goal; everything read below is therefore the
    // state left by whichever rebuild committed last.
    await tx.$queryRaw`SELECT "id" FROM "Goal" WHERE "id" = ${goalId} FOR UPDATE`;

    const goal = await tx.goal.findUnique({
      where: { id: goalId },
      select: { currency: true, targetAmount: true, achievedAt: true },
    });
    if (!goal) return { saved: 0, justAchieved: false };

    const contributions = await tx.goalContribution.findMany({
      where: { goalId },
      select: { amount: true, currency: true },
    });

    const saved = round2(
      contributions.reduce((total, contribution) => {
        const amount = num(contribution.amount);
        return (
          total +
          (contribution.currency === goal.currency
            ? amount
            : convert(amount, contribution.currency, goal.currency, rates))
        );
      }, 0),
    );

    const target = num(goal.targetAmount);
    const achieved = target > 0 && saved >= target;

    await tx.goal.update({
      where: { id: goalId },
      data: {
        savedAmount: saved,
        achievedAt: achieved ? (goal.achievedAt ?? new Date()) : null,
      },
    });

    return { saved, justAchieved: achieved && goal.achievedAt === null };
  });
}

/** Self-heal every goal if the cached values ever drift. */
export async function recomputeAllGoals(): Promise<number> {
  const goals = await prisma.goal.findMany({ select: { id: true } });
  for (const goal of goals) {
    await recomputeGoalSaved(goal.id);
  }
  return goals.length;
}
