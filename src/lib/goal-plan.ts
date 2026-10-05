/**
 * A goal's period plan (QUANTITIES_MAP.md, K3): the one definition of what a
 * goal asks of a pay period and what the period gave it, which every goal
 * reader shares - the Goals list, detail and Dashboard card, the check-in's
 * recommendation, the Inbox, the goal forecast, Afford's goal estimate and
 * the debt comparator. Pure and database-free; the loader is
 * src/lib/data/goal-plan.ts.
 *
 *   pace       what reaching the target asks of each period, fixed where
 *              the funding window of the period it is computed for opens -
 *              the day its pay landed, else its payday (contributionWindow):
 *              (target - saved from contributions dated before that day -
 *              for the plan period, money already dated in a later period of
 *              the goal's window, which is committed to it) / the periods
 *              left from the period (goalPeriodsLeft). A contribution made
 *              from that day on does not move that period's bar. A period
 *              after the plan
 *              period is asked the plan period's pace - it recomputes from its
 *              own payday once it becomes the plan period. Gross: recurring
 *              contributions are part of it. A goal with no target date has no
 *              per-period pace; its figure is the whole remaining balance on
 *              that day, asked of the one period being planned.
 *   scheduled  the goal's recurring contributions in the period (K2's whole
 *              occurrences: posted, settled and outstanding; one posting will
 *              skip counts for nothing)
 *   byHand     max(0, pace - scheduled): what the check-in funds by hand
 *   planned    the period's confirmed GOAL rows; 0 when the period is
 *              confirmed with none for the goal, null when it is not confirmed
 *   contributed  contributions dated in the period's funding window
 *              (contributionWindow), logged and posted: money moved from the
 *              day the period's pay landed until the next period's lands is
 *              that period's, though it is dated before its first day
 *
 * Two statements are read off a plan (decision 5.3, option C):
 *   planning shortfall        at confirm: byHand - planned
 *   follow-through shortfall  as the period runs: planned + scheduled -
 *                             contributed - the scheduled still to post
 */
import { addDays } from "@/lib/date";
import { round2 } from "@/lib/money";
import { fundingWindow, goalPeriodsLeft, type PayLanded, type PeriodInfo, type PeriodRef } from "@/lib/period";

/**
 * How many days before a plan period ends a follow-through shortfall is
 * raised: the last three days of the period (its end day and the two before
 * it). Earlier than that most of the period's money has simply not moved yet,
 * and every plan would read as behind.
 */
export const FOLLOW_THROUGH_ALERT_DAYS = 3;

/** Half a cent: a difference below it is no difference, the tolerance every goal note uses. */
const TOLERANCE = 0.005;

/**
 * A goal's pace, in whatever currency `target` and `savedBefore` share:
 * what reaching the target by its date asks of each period from the one
 * starting on `periodStart`, spread over the periods left from there
 * (goalPeriodsLeft). `savedBefore` is what was saved before that period's
 * payday. Never below zero. A goal with no target date asks its whole
 * remaining balance.
 */
export function goalRoadmapAmount(
  goal: { target: number; savedBefore: number; targetDate: Date | null },
  periodStart: Date,
): number {
  const periodsLeft = goal.targetDate ? goalPeriodsLeft(periodStart, goal.targetDate) : 1;
  return round2(Math.max(0, goal.target - goal.savedBefore) / periodsLeft);
}

/**
 * The period whose pace `period` is asked: its own, or the plan period's for a
 * period after it (asked the plan period's pace until it becomes the plan
 * period itself).
 */
export function pacePeriodFor(period: PeriodInfo, plan: PeriodInfo): PeriodInfo {
  return period.start.getTime() > plan.start.getTime() ? plan : period;
}

/**
 * The days whose contributions belong to `period`: its funding window
 * (fundingWindow in src/lib/period.ts) - from the day its pay landed
 * (`payLanded`, when recorded between five days before its first day and its
 * payday), otherwise its payday, up to where the next period's window starts
 * by the same rule. A contribution made the day the salary lands belongs to
 * the period that salary funds, and one made before the next period's pay
 * has arrived is still this period's. The pace of `period` is fixed on
 * `from`.
 */
export function contributionWindow(period: PeriodRef, payLanded: PayLanded): { from: Date; until: Date } {
  return fundingWindow(period, payLanded);
}

/** One goal in one period, every figure in the display currency. */
export interface GoalPeriodFigures {
  /** Gross: what reaching the target asks of the period, recurring contributions included. */
  pace: number;
  /** The goal's recurring contributions in the period, posted, paid and still to post. */
  scheduled: number;
  /** The part of `scheduled` still to post. */
  outstandingScheduled: number;
  /** max(0, pace - scheduled): what the check-in funds by hand. */
  byHand: number;
  /** The period's confirmed GOAL rows; 0 when confirmed without one, null when the period is not confirmed. */
  planned: number | null;
  /** What the accounts' room let the plan recommend at confirm (the rows' recommendedAmount); null when not confirmed. */
  recommended: number | null;
  /** Contributions dated in the period, logged and posted. */
  contributed: number;
  /**
   * The follow-through figures again in the goal's own currency, each summed
   * from the stored amounts without rounding on the way: what
   * followThroughShortfall compares planned and contributed in, so the
   * rounding of conversions into the display currency (a ledger row rounded
   * in the account's currency beside a contribution rounded in the goal's)
   * cannot read as money not contributed. Absent: judged in the display
   * currency alone.
   */
  native?: { planned: number | null; scheduled: number; outstandingScheduled: number; contributed: number };
}

export function goalPeriodFigures(input: Omit<GoalPeriodFigures, "byHand">): GoalPeriodFigures {
  return { ...input, byHand: round2(Math.max(0, input.pace - input.scheduled)) };
}

/**
 * The planning statement: what the confirmed plan left of what the roadmap
 * asks the check-in to fund by hand. 0 when the plan covers it (or there is
 * no confirmed plan to judge).
 */
export function planningShortfall(figures: GoalPeriodFigures): number {
  if (figures.planned === null) return 0;
  const shortfall = round2(figures.byHand - figures.planned);
  return shortfall > TOLERANCE ? shortfall : 0;
}

/**
 * What the accounts' room could not cover of the roadmap at confirm:
 * byHand - what the plan recommended. Both are fixed for the period, so the
 * note reads the same all period.
 */
export function roomShortfall(figures: GoalPeriodFigures): number {
  if (figures.recommended === null) return 0;
  const shortfall = round2(figures.byHand - figures.recommended);
  return shortfall > TOLERANCE ? shortfall : 0;
}

/**
 * The follow-through statement: what was planned for the period (by hand
 * and scheduled) that has neither been contributed nor is still due to post.
 * 0 when everything planned went in, or there is no confirmed plan.
 *
 * Whether anything is missing is judged in the goal's own currency
 * (`native`), where the contributions are stored: a shortfall that rounds to
 * less than a cent there is the conversions' rounding, not money, and is no
 * shortfall; one of a cent or more is, and is stated in the display currency.
 */
export function followThroughShortfall(figures: GoalPeriodFigures): number {
  if (figures.planned === null) return 0;
  const own = figures.native;
  if (own && own.planned !== null && round2(own.planned + own.scheduled - own.contributed - own.outstandingScheduled) <= TOLERANCE) {
    return 0;
  }
  const shortfall = round2(
    figures.planned + figures.scheduled - figures.contributed - figures.outstandingScheduled,
  );
  return shortfall > TOLERANCE ? shortfall : 0;
}

/**
 * Whether a follow-through shortfall in `period` is raised on `today`: in the
 * last FOLLOW_THROUGH_ALERT_DAYS of the period, or once it has ended.
 */
export function followThroughDue(period: PeriodInfo, today: Date): boolean {
  return today.getTime() >= addDays(period.end, 1 - FOLLOW_THROUGH_ALERT_DAYS).getTime();
}
