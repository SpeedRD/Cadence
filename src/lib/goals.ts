import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";

/**
 * Recompute Goal.savedAmount from its contributions - the source of truth - and
 * write the cached value back. Contributions in another currency are converted
 * into the goal's currency at current rates.
 */
export async function recomputeGoalSaved(goalId: string): Promise<number> {
  const goal = await prisma.goal.findUnique({
    where: { id: goalId },
    select: { id: true, currency: true, targetAmount: true, achievedAt: true },
  });
  if (!goal) return 0;

  const contributions = await prisma.goalContribution.findMany({
    where: { goalId },
    select: { amount: true, currency: true },
  });

  const needsConversion = contributions.some(
    (contribution) => contribution.currency !== goal.currency,
  );
  const rates = needsConversion ? await getRateTable() : null;

  const saved = round2(
    contributions.reduce((total, contribution) => {
      const amount = num(contribution.amount);
      return (
        total +
        (rates
          ? convert(amount, contribution.currency, goal.currency, rates)
          : amount)
      );
    }, 0),
  );

  const target = num(goal.targetAmount);
  const achieved = target > 0 && saved >= target;

  await prisma.goal.update({
    where: { id: goalId },
    data: {
      savedAmount: saved,
      achievedAt: achieved ? (goal.achievedAt ?? new Date()) : null,
    },
  });

  return saved;
}

/** Self-heal every goal if the cached values ever drift. */
export async function recomputeAllGoals(): Promise<number> {
  const goals = await prisma.goal.findMany({ select: { id: true } });
  for (const goal of goals) {
    await recomputeGoalSaved(goal.id);
  }
  return goals.length;
}
