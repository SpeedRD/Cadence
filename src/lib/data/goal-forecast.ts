/**
 * The goal forecast's database half: every dated goal still being saved for,
 * walked from the plan period to its target date through Afford's own
 * projection.
 *
 * Nothing here projects anything itself. The periods a goal's pace is spread
 * over - from the period a check-in opened today would plan for through the
 * one its target date falls in, goalRoadmapAmount's own count - are projected
 * with projectPeriods() (src/lib/data/afford.ts): income averaged from
 * comparable history, commitments enumerated from every active item's
 * schedule, the per-account buffer, and each dated goal's pace spread over
 * the accounts' remaining room exactly as the check-in's Step 3 spreads it.
 * That last step is the forecast: the plan projectPeriods makes for each goal
 * in each period (PeriodProjection.goalPlans) already says what the room
 * could give the goal and what it could not. This module only lines those
 * plans up per goal, one projection for every goal at once, over the furthest
 * horizon any of them needs.
 *
 * Afford exposes one account's own figures per projection beside the
 * period-wide ones; the goal plans are period-wide, so which account is
 * "chosen" makes no difference here and the first active one is passed. With
 * no active account there is nothing to walk and no forecast.
 */
import type { GoalForecast } from "@/lib/goal-forecast";
import { nextPeriod, periodInfo, periodsRemaining, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";

import { projectPeriods, type AffordContext } from "@/lib/data/afford";
import { getGoalRoadmapAmounts, planPeriodRef } from "@/lib/data/payday";

/**
 * One forecast per dated goal with something left to save, in the check-in's
 * funding order. An undated goal has no target date to walk to and is not
 * here, just as Afford estimates nothing for it. Plain function (no
 * requireAuth()/cookies()) so scripts/verify-domain.ts can drive it the same
 * way the Insight Engine's loader does.
 */
export async function forecastGoalFunding(context: AffordContext): Promise<GoalForecast[]> {
  const planRef = planPeriodRef(context);
  const plan = periodInfo(planRef);
  const [paces, accounts] = await Promise.all([
    getGoalRoadmapAmounts(planRef, context),
    prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
  ]);
  const dated = paces.flatMap((pace) =>
    pace.targetDate ? [{ goalId: pace.goalId, name: pace.name, targetDate: pace.targetDate }] : [],
  );
  if (dated.length === 0 || accounts.length === 0) return [];

  // How many periods each goal's pace is spread over, counted from the plan
  // period's start as goalRoadmapAmount counts them - at least the plan
  // period itself for a target date already behind us.
  const lengths = dated.map((goal) => Math.max(1, periodsRemaining(plan.start, goal.targetDate)));
  const horizon: PeriodInfo[] = [];
  let cursor = plan;
  for (let i = 0; i < Math.max(...lengths); i += 1) {
    horizon.push(cursor);
    cursor = periodInfo(nextPeriod(cursor));
  }
  const projections = await projectPeriods(horizon, accounts[0], accounts, context);

  return dated.map((goal, index) => ({
    goalId: goal.goalId,
    name: goal.name,
    targetDate: goal.targetDate,
    currency: context.displayCurrency,
    periods: horizon.slice(0, lengths[index]).flatMap((period) => {
      // A period with a confirmed check-in has no goal plans (its GOAL rows
      // are the real thing), so it drops out of the walk here.
      const goalPlan = projections.get(period.key)?.goalPlans.find((candidate) => candidate.goalId === goal.goalId);
      return goalPlan
        ? [
            {
              period,
              pace: goalPlan.pace,
              recommended: goalPlan.recommended,
              shortfall: goalPlan.shortfall,
              draws: goalPlan.draws,
            },
          ]
        : [];
    }),
  }));
}
