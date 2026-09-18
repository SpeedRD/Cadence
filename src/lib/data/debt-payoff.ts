import { listGoals } from "@/lib/data/goals";
import { getGoalRoadmapAmounts, planPeriodRef } from "@/lib/data/payday";

import type { AppContext } from "@/lib/data/context";
import type { DebtInput } from "@/lib/debt-payoff";

/** One goal marked as a debt, as the comparator's input plus what the page shows beside it. */
export interface DebtGoal extends DebtInput {
  targetDate: Date | null;
}

/**
 * The open goals marked as debts (Goal.isDebt, an explicit marking on the
 * goal form), each with what is still to go and its own per-period pace, both
 * in the display currency - the inputs simulateDebtPayoff() runs on.
 *
 * The pace is getGoalRoadmapAmounts()' figure for the plan period, the same
 * one the goal page measures a confirmed check-in against and the check-in
 * itself funds by; it is read here, never recomputed. A goal with no target
 * date has no per-period pace in that walk (its figure there is the whole
 * balance for the one period being planned), so it enters the simulation
 * with a minimum of 0: paid only by the extra and by the paces other debts
 * free up. Achieved goals and goals with nothing left are not debts to pay,
 * and getGoalRoadmapAmounts() already leaves them out. Order: the goal
 * list's (oldest first) - the strategies impose their own.
 *
 * Read-only and standalone: nothing here feeds the check-in's goal funding.
 */
export async function listDebtGoals(context: AppContext): Promise<DebtGoal[]> {
  const [goals, paces] = await Promise.all([
    listGoals(context),
    getGoalRoadmapAmounts(planPeriodRef(context), context),
  ]);
  const paceByGoal = new Map(paces.map((pace) => [pace.goalId, pace]));
  const debts: DebtGoal[] = [];
  for (const goal of goals) {
    if (!goal.isDebt) continue;
    const pace = paceByGoal.get(goal.id);
    if (!pace) continue;
    debts.push({
      goalId: goal.id,
      name: goal.name,
      balance: goal.displayRemaining,
      minimum: pace.targetDate ? pace.amount : 0,
      targetDate: goal.targetDate,
    });
  }
  return debts;
}
