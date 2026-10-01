/**
 * One history window (QUANTITIES_MAP.md K9): which past pay periods an
 * average may read, for every average Cadence keeps - Afford's income
 * estimate, the category suggestions, the Reports per-period average, the
 * monthly windows and an undated goal's average so far.
 *
 * Three rules, the same everywhere:
 *
 *   - Only a complete period is history. A period is complete for income once
 *     its dates have passed or its check-in is confirmed (the paycheck is then
 *     known in full); for spending only once its dates have passed - a
 *     confirmed plan says nothing about what the rest of the period will cost.
 *   - Settings' "count history from" date (Settings.incomeHistoryStartDate) is
 *     applied by period: the first period that counts is the first one that
 *     starts on or after it, so nothing dated before it is ever read. The
 *     monthly windows start at the first calendar month that starts on or after
 *     that same period.
 *   - Spending skips a partial first period: the period of the first recorded
 *     activity counts only when the activity starts within its first
 *     FIRST_PERIOD_MAX_START_DAY days, the coverage the monthly average asks of
 *     a first month (FIRST_MONTH_MAX_START_DAY in src/lib/data/monthly.ts).
 *     Income needs no such rule: an average of income counts from the oldest
 *     period that had any (incomeHistoryDepth), so a period with no pay in it
 *     yet is never one of its periods.
 *
 * Pure - no Prisma - so the client-free readers and scripts/verify-domain.ts
 * share it; src/lib/data/history-window.ts loads the inputs.
 */
import { monthForDate, nextMonth, type MonthRef } from "@/lib/month";
import { nextPeriod, periodForDate, periodInfo, previousComparablePeriod, type PeriodInfo, type PeriodRef } from "@/lib/period";

/** How many comparable (same-half) periods an average walks back over. */
export const HISTORY_PERIODS = 6;

/**
 * The first period of activity is a full period of history only when that
 * activity starts on or before this day of it (the 4th or the 19th): at least
 * 12 of its 13-16 days covered, as day 7 leaves a first month 24 of its days.
 */
export const FIRST_PERIOD_MAX_START_DAY = 4;

/** What an average is of: income (a confirmed period is complete) or spending (only an ended one is). */
export type HistoryPurpose = "income" | "spending";

/** The two lower bounds of any history: Settings' date and the first recorded activity. */
export interface HistoryBounds {
  /** Settings.incomeHistoryStartDate ("count history from"); null or absent is no bound. */
  historyStart?: Date | null;
  /** The first recorded activity (getFirstActivityDate); read for spending only. */
  firstActivity?: Date | null;
}

/** The first period that starts on or after `date`: the history date applied by period. */
export function firstPeriodFrom(date: Date): PeriodInfo {
  const own = periodForDate(date);
  return own.start.getTime() >= date.getTime() ? own : periodInfo(nextPeriod(own));
}

/** The first period that is a full period of history for a first activity on `date`. */
export function firstUsablePeriod(date: Date): PeriodInfo {
  const own = periodForDate(date);
  const day = Math.round((date.getTime() - own.start.getTime()) / 86_400_000) + 1;
  return day <= FIRST_PERIOD_MAX_START_DAY ? own : periodInfo(nextPeriod(own));
}

/**
 * The start of the first period an average for `purpose` may read, or null
 * when nothing bounds it: the later of the history date's first period and,
 * for spending, the first full period of activity.
 */
export function historyBoundary(bounds: HistoryBounds, purpose: HistoryPurpose): Date | null {
  const starts: Date[] = [];
  if (bounds.historyStart) starts.push(firstPeriodFrom(bounds.historyStart).start);
  if (purpose === "spending" && bounds.firstActivity) starts.push(firstUsablePeriod(bounds.firstActivity).start);
  if (starts.length === 0) return null;
  return starts.reduce((latest, start) => (start.getTime() > latest.getTime() ? start : latest));
}

/** Whether `period` is on the counted side of `boundary` (historyBoundary): it starts on or after it. */
export function countsInHistory(period: PeriodInfo, boundary: Date | null): boolean {
  return !boundary || period.start.getTime() >= boundary.getTime();
}

/** Whether `period` is complete history for `purpose` on `today`. */
export function isCompletePeriod(
  period: PeriodInfo,
  today: Date,
  purpose: HistoryPurpose,
  confirmed: ReadonlySet<string> = new Set(),
): boolean {
  return period.end.getTime() < today.getTime() || (purpose === "income" && confirmed.has(period.key));
}

/**
 * The comparable periods an average for `ref` reads, newest first:
 * HISTORY_PERIODS same-half periods stepping one full cycle back each time,
 * starting at the newest comparable one that is complete (isCompletePeriod) -
 * an installment can land a year out, and the same-half periods between now
 * and then that are not complete have no history to give - and keeping only
 * those on the counted side of the boundary (historyBoundary). A period
 * before the boundary is dropped, not counted as zero.
 */
export function comparableHistory(
  ref: PeriodRef,
  today: Date,
  purpose: HistoryPurpose,
  options: { confirmed?: ReadonlySet<string>; bounds?: HistoryBounds } = {},
): PeriodInfo[] {
  const confirmed = options.confirmed ?? new Set<string>();
  let cursor = periodInfo(previousComparablePeriod(ref));
  // Bounded for an absurdly distant first payment (~40 years).
  for (let i = 0; i < 1000 && !isCompletePeriod(cursor, today, purpose, confirmed); i += 1) {
    cursor = periodInfo(previousComparablePeriod(cursor));
  }
  const boundary = historyBoundary(options.bounds ?? {}, purpose);
  const periods: PeriodInfo[] = [];
  for (let i = 0; i < HISTORY_PERIODS; i += 1) {
    if (countsInHistory(cursor, boundary)) periods.push(cursor);
    cursor = periodInfo(previousComparablePeriod(cursor));
  }
  return periods;
}

/**
 * The periods of `periods` a per-period spending average reads: the complete
 * ones (ended before `today`) on the counted side of the boundary.
 */
export function completedHistoryPeriods(periods: readonly PeriodInfo[], today: Date, bounds: HistoryBounds): PeriodInfo[] {
  const boundary = historyBoundary(bounds, "spending");
  return periods.filter((period) => isCompletePeriod(period, today, "spending") && countsInHistory(period, boundary));
}

/**
 * How many complete periods there are from `from` through the last one that
 * has ended by `today`, inclusive; 0 when none has. An undated goal's average
 * so far divides by this.
 */
export function completedPeriodsFrom(from: PeriodInfo, today: Date): number {
  let count = 0;
  let cursor = from;
  while (isCompletePeriod(cursor, today, "spending") && count < 1000) {
    count += 1;
    cursor = periodInfo(nextPeriod(cursor));
  }
  return count;
}

/** The first calendar month that starts on or after `boundary`: where the monthly windows begin. */
export function firstMonthFrom(boundary: Date): MonthRef {
  const own = monthForDate(boundary);
  return own.start.getTime() >= boundary.getTime() ? own : nextMonth(own);
}

