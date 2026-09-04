import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";

/**
 * Recompute Goal.savedAmount from its contributions - the source of truth - and
 * write the cached value back.
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
  const exists = await prisma.goal.findUnique({
    where: { id: goalId },
    select: { id: true },
  });
  if (!exists) return 0;

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
    if (!goal) return 0;

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

    return saved;
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
