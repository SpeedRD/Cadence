/**
 * Loads each goal's period plan (src/lib/goal-plan.ts) for a set of pay
 * periods: the goals and their contributions, the periods' commitments (K2,
 * src/lib/data/period-commitments.ts) for what recurring contributions put in,
 * and the periods' confirmed check-ins for what was planned. Every goal reader
 * goes through here - the Goals pages and card, the check-in, the Inbox, the
 * forecast, Afford's estimate and the debt comparator - so a goal's pace,
 * scheduled funding, planned and contributed amounts are one computation.
 */
import { convert } from "@/lib/currency";
import {
  goalPeriodFigures,
  goalRoadmapAmount,
  contributionWindow,
  pacePeriodFor,
  type GoalPeriodFigures,
} from "@/lib/goal-plan";
import { savedFromContributions } from "@/lib/goals";
import { num, round2 } from "@/lib/money";
import { periodClock, periodsRemaining, type PayLanded, type PeriodClock, type PeriodInfo } from "@/lib/period";
import {
  outstanding,
  outstandingAmount,
  sumOccurrences,
  whole,
  wholeAmount,
  type CommitmentOccurrence,
} from "@/lib/period-commitments";
import { prisma } from "@/lib/prisma";

import { loadCommitments } from "@/lib/data/period-commitments";
import { loadPayLanded } from "@/lib/data/period-income";

import type { AppContext } from "@/lib/data/context";

/** One goal's plan for one period. Figures are in the display currency unless named native. */
export interface GoalPeriodPlan extends GoalPeriodFigures {
  goalId: string;
  name: string;
  /** The goal's own stored currency. */
  currency: string;
  targetDate: Date | null;
  achievedAt: Date | null;
  /** Still being saved for: not reached, and something left to save (live). */
  open: boolean;
  period: PeriodInfo;
  /**
   * Periods whose pay lands by the target date, counted from the pace
   * period (periodsRemaining); 0 when the target is already behind
   * it, and the pace then asks the whole remainder. Null without a target date.
   */
  periodsLeft: number | null;
  /** `pace` and `byHand` in the goal's own currency, from the same figures. */
  nativePace: number;
  nativeByHand: number;
}

export type GoalRow = Awaited<ReturnType<typeof loadGoalRows>>[number];

function loadGoalRows() {
  // listGoals' order - reached goals by when, then the rest oldest first -
  // which is also the order the check-in funds the open ones in.
  return prisma.goal.findMany({
    select: {
      id: true,
      name: true,
      currency: true,
      targetAmount: true,
      savedAmount: true,
      targetDate: true,
      achievedAt: true,
      contributions: { select: { amount: true, currency: true, date: true } },
    },
    orderBy: [{ achievedAt: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Every goal's plan for every period in `periods`, keyed by period key, each
 * list in the goals' order. `commitments` may be passed when the caller has
 * already loaded the same periods' commitments (Afford does), so they are
 * not enumerated twice.
 */
export async function loadGoalPeriodPlans(
  periods: readonly PeriodInfo[],
  context: Pick<AppContext, "today" | "rates" | "displayCurrency">,
  options: { commitments?: Map<string, CommitmentOccurrence[]> } = {},
): Promise<Map<string, GoalPeriodPlan[]>> {
  const result = new Map<string, GoalPeriodPlan[]>();
  if (periods.length === 0) return result;
  const clock = periodClock(context.today);
  const [goals, commitments, checkins, payLanded] = await Promise.all([
    loadGoalRows(),
    options.commitments ?? loadCommitments(periods, context),
    prisma.paydayCheckin.findMany({
      where: {
        status: "CONFIRMED",
        OR: periods.map((period) => ({ year: period.year, month: period.month, period: period.period })),
      },
      select: {
        year: true,
        month: true,
        period: true,
        allocations: {
          where: { type: "GOAL", goalId: { not: null } },
          select: { goalId: true, plannedAmount: true, recommendedAmount: true, currency: true },
        },
      },
    }),
    // When each period's pay landed, which opens its contribution window
    // (the plan period's too: a later period is paced from it).
    loadPayLanded([...periods, clock.plan], context),
  ]);

  for (const period of periods) {
    const checkin = checkins.find(
      (row) => row.year === period.year && row.month === period.month && row.period === period.period,
    );
    const occurrences = commitments.get(period.key) ?? [];
    result.set(
      period.key,
      goals.map((goal) => goalPeriodPlan(goal, period, clock, { occurrences, allocations: checkin?.allocations ?? null, payLanded }, context)),
    );
  }
  return result;
}

/**
 * K3's goalPeriodPlan: one goal's plan for one period, as of the clock's
 * day, from the period's commitments (K2), its confirmed check-in's GOAL
 * rows (null when the period is not confirmed) and when each period's pay
 * landed (loadPayLanded, for its contribution window). loadGoalPeriodPlans() loads
 * those inputs once for every goal and period and calls this for each pair.
 */
export function goalPeriodPlan(
  goal: GoalRow,
  period: PeriodInfo,
  clock: PeriodClock,
  inputs: {
    occurrences: readonly CommitmentOccurrence[];
    allocations: { goalId: string | null; plannedAmount: unknown; recommendedAmount: unknown; currency: string }[] | null;
    /** When each period's pay landed (loadPayLanded), for its contribution window. */
    payLanded: PayLanded;
  },
  context: Pick<AppContext, "rates" | "displayCurrency">,
): GoalPeriodPlan {
  const { occurrences, allocations, payLanded } = inputs;
  const toDisplay = (amount: number, currency: string) => convert(amount, currency, context.displayCurrency, context.rates);
  const target = num(goal.targetAmount);
  const pacePeriod = pacePeriodFor(period, clock.plan);
  const paceFrom = contributionWindow(pacePeriod, payLanded).from;
  const window = contributionWindow(period, payLanded);
  // Saved as every page shows it (Goal.savedAmount, the cached sum of the
  // contributions), less what is dated in or after the pace period's funding
  // window.
  const savedBefore = round2(
    num(goal.savedAmount) -
      savedFromContributions(
        goal.contributions.filter((contribution) => contribution.date.getTime() >= paceFrom.getTime()),
        goal.currency,
        context.rates,
      ),
  );
  const savedToDate = round2(
    num(goal.savedAmount) -
      savedFromContributions(
        goal.contributions.filter((contribution) => contribution.date.getTime() > clock.today.getTime()),
        goal.currency,
        context.rates,
      ),
  );
  const contributedNative = savedFromContributions(
    goal.contributions.filter(
      (contribution) =>
        contribution.date.getTime() >= window.from.getTime() && contribution.date.getTime() < window.until.getTime(),
    ),
    goal.currency,
    context.rates,
  );
  // One path for both currencies: the pace is the goal's remainder on the
  // pace period's payday, converted before it is divided, so the display
  // figure is never a rounded native figure converted again.
  const pace = goalRoadmapAmount(
    { target: toDisplay(target, goal.currency), savedBefore: toDisplay(savedBefore, goal.currency), targetDate: goal.targetDate },
    pacePeriod.start,
  );
  const nativePace = goalRoadmapAmount({ target, savedBefore, targetDate: goal.targetDate }, pacePeriod.start);

  const mine = occurrences.filter((occurrence) => occurrence.kind === "CONTRIBUTION" && occurrence.goalId === goal.id);
  const scheduled = round2(sumOccurrences(whole(mine), context.displayCurrency, context.rates, wholeAmount));
  const nativeScheduled = round2(sumOccurrences(whole(mine), goal.currency, context.rates, wholeAmount));
  const outstandingScheduled = round2(
    sumOccurrences(outstanding(mine), context.displayCurrency, context.rates, outstandingAmount),
  );

  // Each GOAL row summed into the display currency, rounded as each lands -
  // the fold the goal pages always ran. A confirmed period with no row for
  // the goal planned 0 for it.
  let planned: number | null = null;
  let recommended: number | null = null;
  if (allocations) {
    planned = 0;
    recommended = 0;
    for (const allocation of allocations) {
      if (allocation.goalId !== goal.id) continue;
      planned = round2(planned + toDisplay(num(allocation.plannedAmount as never), allocation.currency));
      recommended = round2(recommended + toDisplay(num(allocation.recommendedAmount as never), allocation.currency));
    }
  }

  const figures = goalPeriodFigures({
    pace,
    scheduled,
    outstandingScheduled,
    planned,
    recommended,
    contributed: round2(toDisplay(contributedNative, goal.currency)),
  });
  return {
    ...figures,
    goalId: goal.id,
    name: goal.name,
    currency: goal.currency,
    targetDate: goal.targetDate,
    achievedAt: goal.achievedAt,
    // Left to fund as of today, like every page's "still to go": a contribution
    // dated ahead is in the cached total but has not been saved yet.
    open: !goal.achievedAt && round2(target - savedToDate) > 0,
    period,
    periodsLeft: goal.targetDate ? periodsRemaining(pacePeriod.start, goal.targetDate) : null,
    nativePace,
    nativeByHand: round2(Math.max(0, nativePace - nativeScheduled)),
  };
}

/** loadGoalPeriodPlans() for one period. */
export async function goalPeriodPlans(
  period: PeriodInfo,
  context: Pick<AppContext, "today" | "rates" | "displayCurrency">,
): Promise<GoalPeriodPlan[]> {
  return (await loadGoalPeriodPlans([period], context)).get(period.key) ?? [];
}
