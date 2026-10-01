import { convert } from "@/lib/currency";
import { addDays } from "@/lib/date";
import { savedFromContributions } from "@/lib/goals";
import { num, round2 } from "@/lib/money";
import {
  nextPeriod,
  periodClock,
  periodForDate,
  periodInfo,
  type PeriodInfo,
} from "@/lib/period";
import { completedPeriodsFrom, isCompletePeriod } from "@/lib/history-window";
import { prisma } from "@/lib/prisma";

import { goalPeriodPlans, type GoalPeriodPlan } from "@/lib/data/goal-plan";

import type { AppContext } from "@/lib/data/context";

/**
 * Native fields (targetAmount/savedAmount/remaining/perPeriod/pacePerPeriod)
 * stay in the goal's own stored currency - that is what the edit and
 * contribution forms write back. The `display*` twins are the same figures
 * converted once into the global display currency, which is what every
 * presentation surface shows; see the note on `displayCurrency` below.
 */
export interface GoalSummary {
  id: string;
  name: string;
  currency: string;
  targetAmount: number;
  /** Saved as of today: contributions dated after today are not in it (savedAhead holds them), as a balance leaves out rows dated later (K8). */
  savedAmount: number;
  /** Contributions dated after today, in the goal's currency: shown apart, counted once their day comes. */
  savedAhead: number;
  remaining: number;
  progress: number;
  targetDate: Date | null;
  achievedAt: Date | null;
  /** Marked as a debt on the goal form; what the Goals page's payoff comparator reads. */
  isDebt: boolean;
  /**
   * What the check-in funds by hand in the plan period to land on the target
   * date: the plan's `byHand` (src/lib/goal-plan.ts). Null for a goal with no
   * target date or none left to save.
   */
  perPeriod: number | null;
  /** Periods whose pay lands by the target date, from the plan period; 0 when the target is already behind it. */
  periodsLeft: number | null;
  /**
   * No target date: the average contributed per completed pay period since
   * the first contribution (the current period's own contributions and days
   * are not counted until it ends). Not a pace the roadmap asks for.
   */
  pacePerPeriod: number | null;
  projectedEnd: Date | null;
  contributionCount: number;
  /** The goal's plan for the plan period (periodClock's `plan`): pace, scheduled, by hand, planned, contributed. */
  plan: GoalPeriodPlan;
  /**
   * The global display currency every `display*` field below is expressed in.
   * Always derived from the stored native amount, never from another
   * `display*` value, so switching DOP -> USD -> DOP recovers the original.
   */
  displayCurrency: string;
  displayTarget: number;
  displaySaved: number;
  displaySavedAhead: number;
  displayRemaining: number;
  displayPerPeriod: number | null;
  displayPacePerPeriod: number | null;
}

function summarize(
  goal: {
    id: string;
    name: string;
    currency: string;
    targetAmount: unknown;
    savedAmount: unknown;
    targetDate: Date | null;
    achievedAt: Date | null;
    createdAt: Date;
    isDebt: boolean;
  },
  contributions: { amount: unknown; currency: string; date: Date }[],
  context: AppContext,
  plan: GoalPeriodPlan,
): GoalSummary {
  const targetAmount = num(goal.targetAmount as never);
  // Saved as of today (D42): the cached total holds every contribution, so
  // the ones dated after today are taken out of it here, by the same formula
  // the total is built with, and shown apart until their day comes.
  const ahead = contributions.filter((row) => row.date.getTime() > context.today.getTime());
  const savedAhead =
    ahead.length > 0
      ? savedFromContributions(ahead.map((row) => ({ amount: num(row.amount as never), currency: row.currency })), goal.currency, context.rates)
      : 0;
  const savedAmount = round2(num(goal.savedAmount as never) - savedAhead);
  const toDate = contributions.filter((row) => row.date.getTime() <= context.today.getTime());
  const remaining = Math.max(0, round2(targetAmount - savedAmount));
  const progress = targetAmount > 0 ? Math.min(1, savedAmount / targetAmount) : 0;

  // The plan period's own figures (K3): what the check-in funds by hand, net
  // of the recurring contributions scheduled in it, over the periods whose pay
  // lands by the target date - the same plan the check-in recommends from.
  const dated = Boolean(goal.targetDate) && remaining > 0;
  const perPeriod = dated ? plan.nativeByHand : null;
  const periodsLeft = dated ? plan.periodsLeft : null;

  // No target date: the average per completed period since the first
  // contribution, projected forward to a finish date.
  let pacePerPeriod: number | null = null;
  let projectedEnd: Date | null = null;
  if (!goal.targetDate && toDate.length > 0) {
    pacePerPeriod = averagePerCompletedPeriod(toDate, goal.currency, context);
    if (pacePerPeriod > 0 && remaining > 0) {
      const periodsNeeded = Math.ceil(remaining / pacePerPeriod);
      let cursor: PeriodInfo = context.currentPeriod;
      for (let i = 0; i < Math.min(periodsNeeded, 600); i += 1) {
        cursor = periodInfo(nextPeriod(cursor));
      }
      projectedEnd = cursor.end;
    }
  }

  const toDisplay = (amount: number) =>
    round2(convert(amount, goal.currency, context.displayCurrency, context.rates));

  return {
    id: goal.id,
    name: goal.name,
    currency: goal.currency,
    targetAmount: round2(targetAmount),
    savedAmount: round2(savedAmount),
    savedAhead,
    remaining,
    progress,
    targetDate: goal.targetDate,
    achievedAt: goal.achievedAt,
    isDebt: goal.isDebt,
    perPeriod,
    periodsLeft,
    pacePerPeriod,
    projectedEnd,
    contributionCount: contributions.length,
    plan,
    displayCurrency: context.displayCurrency,
    displayTarget: toDisplay(targetAmount),
    displaySaved: toDisplay(savedAmount),
    displaySavedAhead: toDisplay(savedAhead),
    displayRemaining: toDisplay(remaining),
    displayPerPeriod: dated ? plan.byHand : null,
    displayPacePerPeriod: pacePerPeriod === null ? null : toDisplay(pacePerPeriod),
  };
}

/**
 * An undated goal's average, in its own currency: what was contributed in
 * the complete periods from the first contribution's period on, over how
 * many of them there were - the one history window's count of complete
 * periods (K9, completedPeriodsFrom in src/lib/history-window.ts). The
 * period in progress is left out of both until it ends, so the figure does
 * not halve overnight when a new period starts. With no complete period
 * yet, it is what the current period holds. `contributions` are the ones
 * dated today or earlier.
 */
function averagePerCompletedPeriod(
  contributions: { amount: unknown; currency: string; date: Date }[],
  currency: string,
  context: AppContext,
): number {
  const rows = contributions.map((row) => ({ amount: num(row.amount as never), currency: row.currency, date: row.date }));
  const earliest = rows.reduce((oldest, row) => (row.date < oldest ? row.date : oldest), rows[0].date);
  const periods = completedPeriodsFrom(periodForDate(earliest), context.today);
  if (periods === 0) return savedFromContributions(rows, currency, context.rates);
  const completed = rows.filter((row) => isCompletePeriod(periodForDate(row.date), context.today, "spending"));
  return round2(savedFromContributions(completed, currency, context.rates) / periods);
}

export async function listGoals(context: AppContext): Promise<GoalSummary[]> {
  const [goals, plans] = await Promise.all([
    prisma.goal.findMany({
      include: { contributions: { select: { amount: true, currency: true, date: true } } },
      orderBy: [{ achievedAt: "asc" }, { createdAt: "asc" }],
    }),
    goalPeriodPlans(periodClock(context.today).plan, context),
  ]);
  const planByGoal = new Map(plans.map((plan) => [plan.goalId, plan]));
  return goals.flatMap((goal) => {
    const plan = planByGoal.get(goal.id);
    // A goal created between the two reads has no plan yet; the next request has it.
    return plan ? [summarize(goal, goal.contributions, context, plan)] : [];
  });
}

export async function getGoalDetail(id: string, context: AppContext) {
  const [goal, plans] = await Promise.all([
    prisma.goal.findUnique({
      where: { id },
      include: {
        contributions: { orderBy: [{ date: "desc" }, { createdAt: "desc" }] },
      },
    }),
    goalPeriodPlans(periodClock(context.today).plan, context),
  ]);
  const plan = plans.find((candidate) => candidate.goalId === id);
  if (!goal || !plan) return null;

  const summary = summarize(goal, goal.contributions, context, plan);
  const contributions = goal.contributions.map((contribution) => ({
    id: contribution.id,
    amount: num(contribution.amount),
    currency: contribution.currency,
    date: contribution.date,
    note: contribution.note,
    /** Set when recurring posting wrote the row; such rows can be corrected in place. */
    recurringExternalId: contribution.recurringExternalId,
    /** Set for a hand-logged row with a paired Transaction; such rows can be corrected in place too. */
    accountId: contribution.accountId,
  }));

  // The cached savedAmount should equal this; surfaced so drift is visible.
  const contributionTotal = round2(
    contributions.reduce(
      (total, contribution) =>
        total +
        convert(
          contribution.amount,
          contribution.currency,
          goal.currency,
          context.rates,
        ),
      0,
    ),
  );

  return {
    summary,
    contributions,
    contributionTotal,
    displayContributionTotal: round2(
      convert(contributionTotal, goal.currency, context.displayCurrency, context.rates),
    ),
    nextPeriodStart: addDays(context.currentPeriod.end, 1),
  };
}
