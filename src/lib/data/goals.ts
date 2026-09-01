import { convert } from "@/lib/currency";
import { addDays } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import {
  nextPeriod,
  periodForDate,
  periodInfo,
  periodsRemaining,
  type PeriodInfo,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";

import type { AppContext } from "@/lib/data/context";

export interface GoalSummary {
  id: string;
  name: string;
  currency: string;
  targetAmount: number;
  savedAmount: number;
  remaining: number;
  progress: number;
  targetDate: Date | null;
  achievedAt: Date | null;
  /** Contribution needed per pay period to land on the target date. */
  perPeriod: number | null;
  periodsLeft: number | null;
  /** Averaged from history when there is no target date. */
  pacePerPeriod: number | null;
  projectedEnd: Date | null;
  contributionCount: number;
  displayTarget: number;
  displaySaved: number;
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
  },
  contributions: { amount: unknown; date: Date }[],
  context: AppContext,
): GoalSummary {
  const targetAmount = num(goal.targetAmount as never);
  const savedAmount = num(goal.savedAmount as never);
  const remaining = Math.max(0, round2(targetAmount - savedAmount));
  const progress = targetAmount > 0 ? Math.min(1, savedAmount / targetAmount) : 0;

  let perPeriod: number | null = null;
  let periodsLeft: number | null = null;
  if (goal.targetDate && remaining > 0) {
    periodsLeft = periodsRemaining(context.today, goal.targetDate);
    perPeriod = round2(remaining / Math.max(1, periodsLeft));
  }

  // No target date: infer pace from history and project a finish date.
  let pacePerPeriod: number | null = null;
  let projectedEnd: Date | null = null;
  if (!goal.targetDate && contributions.length > 0) {
    const earliest = contributions.reduce(
      (oldest, contribution) =>
        contribution.date < oldest ? contribution.date : oldest,
      contributions[0].date,
    );
    const elapsed = Math.max(
      1,
      countPeriodsInclusive(periodForDate(earliest), context.currentPeriod),
    );
    pacePerPeriod = round2(savedAmount / elapsed);
    if (pacePerPeriod > 0 && remaining > 0) {
      const periodsNeeded = Math.ceil(remaining / pacePerPeriod);
      let cursor: PeriodInfo = context.currentPeriod;
      for (let i = 0; i < Math.min(periodsNeeded, 600); i += 1) {
        cursor = periodInfo(nextPeriod(cursor));
      }
      projectedEnd = cursor.end;
    }
  }

  return {
    id: goal.id,
    name: goal.name,
    currency: goal.currency,
    targetAmount: round2(targetAmount),
    savedAmount: round2(savedAmount),
    remaining,
    progress,
    targetDate: goal.targetDate,
    achievedAt: goal.achievedAt,
    perPeriod,
    periodsLeft,
    pacePerPeriod,
    projectedEnd,
    contributionCount: contributions.length,
    displayTarget: round2(
      convert(targetAmount, goal.currency, context.displayCurrency, context.rates),
    ),
    displaySaved: round2(
      convert(savedAmount, goal.currency, context.displayCurrency, context.rates),
    ),
  };
}

function countPeriodsInclusive(from: PeriodInfo, to: PeriodInfo): number {
  if (from.start.getTime() > to.start.getTime()) return 1;
  let count = 1;
  let cursor = from;
  while (cursor.start.getTime() < to.start.getTime() && count < 1000) {
    cursor = periodInfo(nextPeriod(cursor));
    count += 1;
  }
  return count;
}

export async function listGoals(context: AppContext): Promise<GoalSummary[]> {
  const goals = await prisma.goal.findMany({
    include: { contributions: { select: { amount: true, date: true } } },
    orderBy: [{ achievedAt: "asc" }, { createdAt: "asc" }],
  });
  return goals.map((goal) => summarize(goal, goal.contributions, context));
}

export async function getGoalDetail(id: string, context: AppContext) {
  const goal = await prisma.goal.findUnique({
    where: { id },
    include: {
      contributions: { orderBy: [{ date: "desc" }, { createdAt: "desc" }] },
    },
  });
  if (!goal) return null;

  const summary = summarize(goal, goal.contributions, context);
  const contributions = goal.contributions.map((contribution) => ({
    id: contribution.id,
    amount: num(contribution.amount),
    currency: contribution.currency,
    date: contribution.date,
    note: contribution.note,
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
    nextPeriodStart: addDays(context.currentPeriod.end, 1),
  };
}
