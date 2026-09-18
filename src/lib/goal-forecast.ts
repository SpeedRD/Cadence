/**
 * Pure helpers for the goal forecast: Afford's projection walked from the plan
 * period to a dated goal's target date, asking of each period whether the
 * accounts' projected room can keep funding the goal at its pace.
 *
 * Nothing here projects anything. src/lib/data/goal-forecast.ts runs Afford's
 * own projectPeriods() over the periods a goal's pace is spread over and
 * hands each period's goal plan here (PeriodProjection.goalPlans - the same
 * planGoalFunding recommendation the check-in's Step 3 makes, over the room
 * each account has left once its income, scheduled commitments, buffer and
 * the goals ahead of this one are projected). A period the room cannot cover
 * the pace in is one the goal's plan for the period would fall short in by
 * that much - the "room couldn't cover" figure, ahead of time - and the
 * first such period is what the Inbox's goal-forecast insight names
 * (detectGoalForecastRisk in src/lib/insights.ts). Kept free of Prisma so
 * client components can import the shapes.
 *
 * This is a different question from the goal page's "behind the roadmap"
 * note (GoalRoadmapStatus): that measures what the plan period's confirmed
 * check-in set aside against the pace; this asks whether the periods ahead
 * have room for the pace at all. A period with a confirmed check-in is never
 * in the walk - its GOAL rows are the real plan.
 */
import type { GoalFundingDraw } from "@/lib/payday";
import type { PeriodInfo } from "@/lib/period";

/** One projected period of a goal's walk: its plan for the goal, from PeriodProjection.goalPlans. */
export interface GoalForecastPeriod {
  period: PeriodInfo;
  /** What the goal's roadmap asks of the period, in the display currency - its pace as of today (getGoalRoadmapAmounts), the same for every period of the walk. */
  pace: number;
  /** What the accounts' projected room could put toward it, in the display currency - the estimate Afford itself carries for the goal in the period. */
  recommended: number;
  /** pace - recommended when the room could not cover the pace, 0 otherwise. Display currency. */
  shortfall: number;
  /** Each account with room in the period and what the goal draws from it, in the account's own currency - planGoalFunding's draws; an account earlier goals used up is here with room 0. */
  draws: GoalFundingDraw[];
}

/** One dated goal's walk to its target date. */
export interface GoalForecast {
  goalId: string;
  name: string;
  targetDate: Date;
  /** What `pace`, `recommended` and `shortfall` are in: the display currency. */
  currency: string;
  /**
   * The projected periods from the plan period through the one the target
   * date falls in, in order - the periods the pace is spread over
   * (goalRoadmapAmount's own count), less any with a confirmed check-in,
   * which Afford does not estimate and the goal page already measures.
   * Empty when every period of the walk is confirmed.
   */
  periods: GoalForecastPeriod[];
}

/**
 * What the insight says: "short" names the first period of the walk the room
 * falls short in. A shortfall within half a cent is covered - the goal page's
 * own tolerance for "on the roadmap".
 */
export type GoalForecastSummary =
  | { status: "on_track" }
  | { status: "short"; period: GoalForecastPeriod };

export function summarizeGoalForecast(forecast: GoalForecast): GoalForecastSummary {
  const period = forecast.periods.find((candidate) => candidate.shortfall > 0.005);
  return period ? { status: "short", period } : { status: "on_track" };
}
