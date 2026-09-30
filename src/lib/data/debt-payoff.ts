import { listGoals } from "@/lib/data/goals";

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
 * The pace is the goal's plan-period pace (src/lib/goal-plan.ts), gross of
 * the recurring contributions that pay into the debt: the simulation adds
 * nothing else, so a debt paid by an automatic contribution still receives
 * that money. What already went into the debt in the plan period - period 1
 * of the simulation - is passed beside it, since the balance is already net
 * of it, and so is the period its target date's last pay lands in, where the
 * roadmap asks for whatever is left. A goal with no target date has no per-period pace (its figure is
 * the whole balance for the one period being planned), so it enters the
 * simulation with a minimum of 0: paid only by the extra and by the paces
 * other debts free up. Achieved goals and goals with nothing left are not
 * debts to pay. Order: the goal list's (oldest first) - the strategies impose
 * their own.
 *
 * Read-only and standalone: nothing here feeds the check-in's goal funding.
 */
export async function listDebtGoals(context: AppContext): Promise<DebtGoal[]> {
  const goals = await listGoals(context);
  const debts: DebtGoal[] = [];
  for (const goal of goals) {
    if (!goal.isDebt || !goal.plan.open) continue;
    debts.push({
      goalId: goal.id,
      name: goal.name,
      balance: goal.displayRemaining,
      minimum: goal.targetDate ? goal.plan.pace : 0,
      paidThisPeriod: goal.targetDate ? goal.plan.contributed : 0,
      targetPeriod: goal.plan.periodsLeft === null ? undefined : Math.max(1, goal.plan.periodsLeft),
      targetDate: goal.targetDate,
    });
  }
  return debts;
}
