/**
 * Pure calculation logic for the Afford calculator: can a purchase paid in
 * installments be carried by the pay periods its installments fall in?
 *
 * No I/O here. src/lib/data/afford.ts assembles the per-period projections
 * from history and calls evaluateAffordability(); the "I bought this" action
 * runs the very same evaluation server-side before it writes anything, so the
 * verdict the user acknowledged is the one that gates the write.
 *
 * Two checks per affected period, both against projected figures - or, for a
 * period whose payday check-in is confirmed, against what it confirmed (see
 * projectPeriods in src/lib/data/afford.ts):
 *
 *   account buffer   the chosen account's projected income, less what its
 *                    recurring items owe in the period, less its share of the
 *                    period's essential fixed spending, less this purchase's
 *                    installment(s) due in the period, must stay at or above
 *                    that account's own protected buffer (the same
 *                    defaultProtectedBuffer() the check-in applies per account).
 *   flexible room    the period's projected available-for-flexible - income
 *                    across every active account, less every recurring item
 *                    due in the period, the essential fixed categories and
 *                    every account's buffer, the app's own definition in
 *                    availableForFlexibleCategories() - less the installment(s),
 *                    must stay non-negative.
 *
 * Installments landing in the same period are summed before either check runs;
 * a period is never judged one installment at a time.
 */
import { convert, type RateTable } from "@/lib/currency";
import { startOfDay } from "@/lib/date";
import { round2 } from "@/lib/money";
import { flexibleRoomFrom, type FlexibleRoom } from "@/lib/flexible-room";
import type { GoalFundingDraw } from "@/lib/payday";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { advanceDate } from "@/lib/recurring";

import type { RecurringFrequency } from "@/generated/prisma/enums";

/** The most installments one purchase can be split into (ten years of monthly payments). */
export const MAX_INSTALLMENTS = 120;

/**
 * The one amount every installment is: `total` divided into `count` equal
 * parts, rounded to the cent. Every row of the schedule, every figure the
 * checks subtract and the amount the RecurringItem posts are this same number,
 * so nothing the calculator evaluated can differ from what later posts.
 * Rounding can leave the parts a few cents off the entered price
 * (100 / 3 -> 33.33 x 3 = 99.99); the schedule shows that difference rather
 * than hiding it in a larger last installment, which a single-amount
 * recurring item could never post. 0 when there is nothing to split.
 */
export function equalInstallmentAmount(total: number, count: number): number {
  if (count <= 0 || !Number.isFinite(total) || total <= 0) return 0;
  return round2(total / count);
}

/**
 * The due date of each installment: `firstDate`, then advanceDate() applied
 * with the first date's own day as the anchor - exactly the walk posting will
 * take once the plan is a RecurringItem, so the calculator and the ledger
 * agree on every date (Jan 31 -> Feb 28 -> Mar 31, never Mar 28).
 */
export function installmentDates(
  firstDate: Date,
  frequency: RecurringFrequency,
  count: number,
): Date[] {
  const anchorDay = firstDate.getUTCDate();
  const dates: Date[] = [];
  let cursor = startOfDay(firstDate);
  for (let i = 0; i < count; i += 1) {
    dates.push(cursor);
    cursor = advanceDate(cursor, frequency, anchorDay);
  }
  return dates;
}

export interface Installment {
  /** 1-based position in the plan. */
  index: number;
  date: Date;
  /** In the purchase's currency. */
  amount: number;
  /** periodForDate(date).key - which pay period carries this installment. */
  periodKey: string;
}

/** One installment per date, each for the same `amount`, tagged with the pay period it lands in. */
export function buildInstallments(dates: Date[], amount: number): Installment[] {
  return dates.map((date, i) => ({
    index: i + 1,
    date,
    amount: round2(amount),
    periodKey: periodForDate(date).key,
  }));
}

/**
 * An installment dated before `today` is already paid: the purchase was made
 * and the money has left, so it belongs to no check ahead and is never
 * posted. One dated today or later is still owed.
 */
export function isPaidInstallment(date: Date, today: Date): boolean {
  return date.getTime() < today.getTime();
}

/** The installments already behind `today` and the ones still ahead, each in plan order. */
export function splitPaidInstallments(
  installments: Installment[],
  today: Date,
): { paid: Installment[]; upcoming: Installment[] } {
  return {
    paid: installments.filter((installment) => isPaidInstallment(installment.date, today)),
    upcoming: installments.filter((installment) => !isPaidInstallment(installment.date, today)),
  };
}

/**
 * One goal's share of a period's estimated goal funding, in the display
 * currency: what the period is assumed to put toward the goal at the goal's
 * current pace, because no confirmed check-in has said what it really will.
 * Only ever present on a period with no confirmed check-in, and only for a
 * goal the accounts' projected room let something be set aside for.
 */
export interface EstimatedGoalFunding {
  goalId: string;
  name: string;
  amount: number;
}

/**
 * The plan one dated goal's estimate came from, kept whole: planGoalFunding's
 * recommendation for the goal in a period with no confirmed check-in, against
 * the room each account has left there after its scheduled commitments, its
 * buffer and the goals ahead of this one. `pace` is what the goal's roadmap
 * asks of the period, recurring contributions included; `scheduled` the
 * goal's own recurring contributions in that period (already among its
 * scheduled commitments); `byHand` the rest, max(0, pace - scheduled) - what
 * the room is asked for. `recommended` is what the room could give (the
 * `estimatedGoals` figure when positive); `shortfall` the rest of `byHand` -
 * what Step 3 would report as "room couldn't cover", here for a period that
 * has not happened yet. Display currency throughout; each draw in its
 * account's own.
 */
export interface ProjectedGoalPlan {
  goalId: string;
  name: string;
  pace: number;
  scheduled: number;
  byHand: number;
  recommended: number;
  shortfall: number;
  draws: GoalFundingDraw[];
}

/**
 * Below this many comparable pay periods of income history, the income figure
 * is an average of too little to lean on - one paycheck, or two - and the
 * results page and the Recurring form's room check say so beside it. Three is
 * the smallest count where one unusual period (a late paycheck, a bonus) no
 * longer decides the average on its own: it moves it by a third at most.
 */
export const MIN_INCOME_HISTORY_PERIODS = 3;

/**
 * Where a period's essential fixed figure came from, the way the payday
 * check-in would fill its essential categories for that period:
 *   budget       every essential category has a budget already saved for the
 *                period (or a confirmed check-in's allocation for it)
 *   suggestion   at least one comes from getCategorySuggestions() - the last
 *                comparable budget, or average spending - carried from the
 *                most recent period whose history is known
 *   none         essential categories exist but nothing was ever budgeted or
 *                spent in them, so nothing is assumed; the copy says so
 *                rather than presenting 0 as a known figure
 *   unset        no category is marked essential fixed: nothing to project,
 *                and the period is exactly what it was before
 */
export type EssentialFixedBasis = "budget" | "suggestion" | "none" | "unset";

/** Everything a period's two checks need, as projected by src/lib/data/afford.ts. */
export interface PeriodProjection {
  period: PeriodInfo;
  /** A payday check-in is confirmed for this period, so its real GOAL rows (not an estimate) are in the commitments. */
  confirmed: boolean;
  /** The chosen account's own figures, in its own currency. */
  account: {
    accountId: string;
    name: string;
    currency: string;
    /** Comparable-period average of what this account received. */
    income: number;
    /**
     * What the active recurring items charged to this account owe in the
     * period, enumerated from their schedules - exact, never an average -
     * plus what the period puts toward goals from this account: the confirmed
     * check-in's GOAL rows when it has one, `estimatedGoalFunding` otherwise.
     */
    committed: number;
    /** defaultProtectedBuffer() over `income`. */
    buffer: number;
    /**
     * This account's share of the period's essential fixed spending
     * (`flexible.essentialFixed`), in its own currency: the check-in keeps
     * essential categories period-wide, with no account, so each account
     * carries them in proportion to its part of the period's projected
     * income - the money they are paid from. 0 when nothing is essential.
     */
    essentialFixed: number;
    /**
     * "confirmed" when the period's check-in is confirmed: `income` is the
     * paycheck it recorded for this account and `buffer` the buffer it kept
     * (K4). "none" when no comparable period had any income for this account
     * - the projection is then a floor, not an average.
     */
    basis: "average" | "none" | "confirmed";
    /**
     * How many comparable periods `income` is the average of: the divisor,
     * counted from the oldest period with income in any account (see
     * incomeHistoryDepth in src/lib/data/afford.ts), so it is the same for
     * every account in one period. 0 when no account has any income history.
     */
    incomePeriods: number;
    /**
     * The part of `committed` that is only an estimate: this account's share
     * of every dated goal's current pace, for a period with no confirmed
     * check-in (see `estimatedGoals`). 0 when the period has one - its real
     * GOAL rows are in `committed` instead - or nothing is being saved for.
     */
    estimatedGoalFunding: number;
  };
  /** The whole period across every active account, in the display currency. */
  flexible: {
    currency: string;
    income: number;
    /** Every active recurring item's occurrences due in the period, whichever account (or none) funds it, plus the period's goal funding - confirmed or, failing that, estimated - like `account.committed`. */
    committed: number;
    /** Every income-receiving account's buffer, summed - the check-in's plannedBuffer. */
    buffer: number;
    /** The estimated part of `committed`: `estimatedGoals` summed. 0 for a period with a confirmed check-in. */
    estimatedGoalFunding: number;
    /** The essential fixed categories' figure for the period, what the check-in's Step 4 subtracts as essentialFixed - see `essentialFixedBasis`. */
    essentialFixed: number;
    /** The divisor behind `income` - the same one every account's average used (see account.incomePeriods). */
    incomePeriods: number;
    /** The recurring contributions' part of `committed` (the rest is subscriptions and goal funding). Absent reads as 0. */
    contributions?: number;
    /** The goal funding part of `committed`: the confirmed GOAL rows, or the estimate. Absent reads as `estimatedGoalFunding`. */
    goalPlan?: number;
    /**
     * For a period whose check-in is confirmed, the carryover its plan counts
     * and its reconciliation cap (K4, src/lib/data/flexible-room.ts). A
     * projected period has neither: absent reads as 0.
     */
    carryover?: number;
    cap?: number;
  };
  /** Where `flexible.essentialFixed` came from, so the results page can say what was assumed. */
  essentialFixedBasis: EssentialFixedBasis;
  /**
   * What the period is estimated to put toward each dated goal, one entry per
   * goal with a positive amount, in the order the check-in funds them (oldest
   * goal first). Empty for a period with a confirmed check-in - its GOAL rows
   * are the real figure, and no estimate is added on top - and for a period
   * with nothing to estimate. An undated goal never appears: its roadmap
   * figure is a whole balance, not a pace, and cannot be repeated period
   * after period (see projectPeriods in src/lib/data/afford.ts). The results
   * page names each so the user can see that this much of the period's
   * commitments is not yet confirmed.
   */
  estimatedGoals: EstimatedGoalFunding[];
  /**
   * The plan behind `estimatedGoals`, one entry per dated goal in funding
   * order whether or not the room gave it anything - so a goal the room
   * could not fund at all, absent from `estimatedGoals`, is here with its
   * whole pace as shortfall. Empty exactly when `estimatedGoals` is empty for
   * want of anything to estimate: a period with a confirmed check-in, or no
   * dated goal to save for. Not read by the checks or the results page.
   */
  goalPlans: ProjectedGoalPlan[];
  /**
   * How many comparable periods were looked at - up to HISTORY_PERIODS, fewer
   * when Settings' "count history from" date drops some of them (see
   * comparableHistory in src/lib/data/afford.ts). Not the divisor
   * (`flexible.incomePeriods` is): the results page reads it only to say how
   * far back an account with no income at all was checked.
   */
  historyPeriods: number;
}

export interface AccountCheck {
  accountId: string;
  name: string;
  currency: string;
  income: number;
  committed: number;
  buffer: number;
  /** This account's share of the period's essential fixed spending - see PeriodProjection.account.essentialFixed. */
  essentialFixed: number;
  basis: "average" | "none" | "confirmed";
  /** The divisor behind `income` - see PeriodProjection.account.incomePeriods. */
  incomePeriods: number;
  /** The estimated part of `committed` - see PeriodProjection.account.estimatedGoalFunding. */
  estimatedGoalFunding: number;
  /** income - committed - essentialFixed - buffer: the room above the buffer before this purchase. */
  headroomBefore: number;
  /** This purchase's installment(s) due in the period, in the account's currency. */
  installment: number;
  headroomAfter: number;
  passes: boolean;
  /** How far below its buffer the account would land - 0 when it stays above. */
  shortfall: number;
}

export interface FlexibleCheck {
  currency: string;
  income: number;
  committed: number;
  buffer: number;
  /** The estimated part of `committed` - see PeriodProjection.flexible.estimatedGoalFunding. */
  estimatedGoalFunding: number;
  /** The essential fixed categories' figure - see PeriodProjection.flexible.essentialFixed. */
  essentialFixed: number;
  /** The divisor behind `income` - see PeriodProjection.flexible.incomePeriods. */
  incomePeriods: number;
  /** The confirmed plan's carryover and cap - see PeriodProjection.flexible; 0 for a projected period. */
  carryover: number;
  cap: number;
  /** K4's `available` for the period (roomFromProjection): what the purchase is taken from. */
  availableBefore: number;
  /** In the display currency. */
  installment: number;
  availableAfter: number;
  passes: boolean;
  shortfall: number;
}

export interface PeriodVerdict {
  key: string;
  period: PeriodInfo;
  /** PeriodProjection.confirmed as projected. */
  confirmed: boolean;
  /** Every installment of this purchase that lands in the period, in plan order. */
  installments: Installment[];
  /** Their sum, in the purchase's currency - what both checks subtract. */
  installmentTotal: number;
  account: AccountCheck;
  flexible: FlexibleCheck;
  /** PeriodProjection.estimatedGoals as projected: the goals whose pace both checks' commitments include as an estimate. */
  estimatedGoals: EstimatedGoalFunding[];
  /** PeriodProjection.essentialFixedBasis as projected. */
  essentialFixedBasis: EssentialFixedBasis;
  /** PeriodProjection.historyPeriods as projected. */
  historyPeriods: number;
  passes: boolean;
}

/**
 * How many of the evaluated periods have a confirmed payday check-in: every
 * one, none, or a mix. The results page words its projection note from this,
 * so it never says no check-in exists for a period whose GOAL rows are counted.
 */
export function checkInCoverage(periods: ReadonlyArray<{ confirmed: boolean }>): "all" | "none" | "some" {
  const confirmed = periods.filter((period) => period.confirmed).length;
  if (periods.length > 0 && confirmed === periods.length) return "all";
  return confirmed === 0 ? "none" : "some";
}

export interface AffordVerdict {
  viable: boolean;
  /** The purchase's currency, which every installment amount is in. */
  currency: string;
  /** The installments still ahead - the ones the periods below judge and "I bought this" records. */
  installments: Installment[];
  /** Installments dated before today, treated as already paid: judged nowhere and never recorded (see isPaidInstallment). */
  paidInstallments: Installment[];
  /** One per affected period, earliest first. */
  periods: PeriodVerdict[];
  /** The periods that fail either check, earliest first. */
  failing: PeriodVerdict[];
}

/**
 * Whether the results page gives essential fixed spending its own column and
 * per-period lines: only when at least one projected period assumes an amount
 * above zero. Otherwise every cell would read "-", so the page says once that
 * none are assumed instead.
 */
export function showsEssentialFixed(periods: { flexible: { essentialFixed: number } }[]): boolean {
  return periods.some((period) => period.flexible.essentialFixed > 0);
}

/** Sum of each period's installments, keyed by period; a period with none is absent. */
export function installmentTotalsByPeriod(installments: Installment[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const installment of installments) {
    totals.set(installment.periodKey, round2((totals.get(installment.periodKey) ?? 0) + installment.amount));
  }
  return totals;
}

/**
 * K4 (src/lib/flexible-room.ts) over one period's projection: "confirmed"
 * when its check-in is, its figures then being the confirmed ones (see
 * projectPeriods), "projected" otherwise. The goal funding - the confirmed
 * GOAL rows, or the estimate - is the goal plan; the rest of `committed` is
 * the period's commitments.
 */
export function roomFromProjection(projection: PeriodProjection): FlexibleRoom {
  const goalPlan = projection.flexible.goalPlan ?? projection.flexible.estimatedGoalFunding;
  const contributions = projection.flexible.contributions ?? 0;
  return flexibleRoomFrom(projection.confirmed ? "confirmed" : "projected", {
    income: projection.flexible.income,
    carryover: projection.flexible.carryover ?? 0,
    provisionalCarryover: 0,
    subscriptions: round2(projection.flexible.committed - goalPlan - contributions),
    contributions,
    goalPlan,
    essential: projection.flexible.essentialFixed,
    buffer: projection.flexible.buffer,
    cap: projection.flexible.cap ?? 0,
    cushion: 0,
  });
}

/**
 * Judges every affected period and the purchase as a whole. `projections`
 * must hold an entry for each period key the installments touch; a missing
 * one is a programming error rather than a shortfall, so it throws.
 */
export function evaluateAffordability(input: {
  /** The installments still ahead; the caller has already set aside any that are paid. */
  installments: Installment[];
  currency: string;
  projections: Map<string, PeriodProjection>;
  rates: RateTable;
  /** Installments already paid, carried on the verdict for the schedule; judged nowhere. */
  paidInstallments?: Installment[];
}): AffordVerdict {
  const { installments, currency, projections, rates, paidInstallments = [] } = input;
  const totals = installmentTotalsByPeriod(installments);
  const keys = [...totals.keys()].sort();

  const periods: PeriodVerdict[] = keys.map((key) => {
    const projection = projections.get(key);
    if (!projection) throw new Error(`No projection for period ${key}`);
    const installmentTotal = totals.get(key) ?? 0;
    const own = installments.filter((installment) => installment.periodKey === key);

    const accountInstallment = round2(
      convert(installmentTotal, currency, projection.account.currency, rates),
    );
    const headroomBefore = round2(
      projection.account.income -
        projection.account.committed -
        projection.account.essentialFixed -
        projection.account.buffer,
    );
    const headroomAfter = round2(headroomBefore - accountInstallment);
    const account: AccountCheck = {
      accountId: projection.account.accountId,
      name: projection.account.name,
      currency: projection.account.currency,
      income: projection.account.income,
      committed: projection.account.committed,
      buffer: projection.account.buffer,
      essentialFixed: projection.account.essentialFixed,
      basis: projection.account.basis,
      incomePeriods: projection.account.incomePeriods,
      estimatedGoalFunding: projection.account.estimatedGoalFunding,
      headroomBefore,
      installment: accountInstallment,
      headroomAfter,
      passes: headroomAfter >= 0,
      shortfall: headroomAfter < 0 ? round2(-headroomAfter) : 0,
    };

    // K4 over the projection (roomFromProjection): for a period whose
    // check-in is confirmed, what it confirmed - the paycheck, its buffer,
    // carryover and cap - so the figure is the one the check-in and the
    // Dashboard show; for any other period, what history and the schedules
    // predict, with no carryover (it is chosen at check-in time) and no cap.
    const availableBefore = roomFromProjection(projection).available;
    const flexibleInstallment = round2(
      convert(installmentTotal, currency, projection.flexible.currency, rates),
    );
    const availableAfter = round2(availableBefore - flexibleInstallment);
    const flexible: FlexibleCheck = {
      currency: projection.flexible.currency,
      income: projection.flexible.income,
      committed: projection.flexible.committed,
      buffer: projection.flexible.buffer,
      estimatedGoalFunding: projection.flexible.estimatedGoalFunding,
      essentialFixed: projection.flexible.essentialFixed,
      incomePeriods: projection.flexible.incomePeriods,
      carryover: projection.flexible.carryover ?? 0,
      cap: projection.flexible.cap ?? 0,
      availableBefore,
      installment: flexibleInstallment,
      availableAfter,
      passes: availableAfter >= 0,
      shortfall: availableAfter < 0 ? round2(-availableAfter) : 0,
    };

    return {
      key,
      period: projection.period,
      confirmed: projection.confirmed,
      installments: own,
      installmentTotal,
      account,
      flexible,
      estimatedGoals: projection.estimatedGoals,
      essentialFixedBasis: projection.essentialFixedBasis,
      historyPeriods: projection.historyPeriods,
      passes: account.passes && flexible.passes,
    };
  });

  const failing = periods.filter((period) => !period.passes);
  return {
    viable: failing.length === 0,
    currency,
    installments,
    paidInstallments,
    periods,
    failing,
  };
}

