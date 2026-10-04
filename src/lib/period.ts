/**
 * Pay periods.
 *
 * The user is paid twice a month, so every month is two budgeting periods:
 *   A = 1st -> 15th
 *   B = 16th -> last day of the month (28/29/30/31)
 *
 * Budgets, "safe to spend" and goal roadmaps are all keyed to a period, never to
 * a calendar month.
 */
import {
  addDays,
  civilDate,
  daysBetween,
  daysInMonth,
  minDate,
  startOfDay,
} from "@/lib/date";

export type PayPeriodCode = "A" | "B";

export interface PeriodRef {
  year: number;
  month: number; // 1-12
  period: PayPeriodCode;
}

export interface PeriodInfo extends PeriodRef {
  start: Date;
  end: Date;
  totalDays: number;
  /** "2026-08-B". Its text label is formatPeriodShort / formatPeriodLong (src/lib/date-format.ts), in the app's language. */
  key: string;
}

export const PERIOD_A_LAST_DAY = 15;

/**
 * A pay boundary that lands on a weekend is paid on the preceding Friday:
 * Saturday moves back 1 day, Sunday 2. Weekdays are returned untouched.
 * Weekends only - deliberately no holiday calendar.
 *
 * Neither shift can cross out of the month for a *pay* boundary (the
 * earliest one is the 15th) - but the function itself doesn't assume that:
 * civilDate()'s own day-overflow handling means a boundary near the 1st
 * legitimately resolves into the previous month, which is exactly what
 * RecurringItem.SEMI_MONTHLY needs (src/lib/recurring.ts reuses this
 * directly, rather than a second copy of the same rule, for its two anchor
 * days) and what src/lib/recurring-detection.ts's own pattern-matching copy
 * mirrors for the same reason.
 */
export function payDayOfMonth(year: number, month: number, boundaryDay: number): number {
  const weekday = civilDate(year, month, boundaryDay).getUTCDay();
  if (weekday === 6) return boundaryDay - 1; // Saturday -> Friday
  if (weekday === 0) return boundaryDay - 2; // Sunday -> Friday
  return boundaryDay;
}

/**
 * True on the day the user is actually paid for a period boundary: the 15th or
 * the real last calendar day of the month (Feb/leap-year safe), each pulled
 * back to the preceding Friday when it falls on a weekend. The period's own
 * start/end dates are unaffected - only what counts as payday moves.
 */
export function isPaydayDate(date: Date): boolean {
  const day = startOfDay(date);
  const dayOfMonth = day.getUTCDate();
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth() + 1;
  const lastDay = daysInMonth(year, month);
  return (
    dayOfMonth === payDayOfMonth(year, month, PERIOD_A_LAST_DAY) ||
    dayOfMonth === payDayOfMonth(year, month, lastDay)
  );
}

/** The day of the month `ref`'s own pay lands on, pulled back off a weekend. */
export function paydayOfPeriod(ref: PeriodRef): number {
  const boundaryDay =
    ref.period === "A" ? PERIOD_A_LAST_DAY : daysInMonth(ref.year, ref.month);
  return payDayOfMonth(ref.year, ref.month, boundaryDay);
}

/**
 * The calendar date the pay that funds `ref` lands on. Pay for the 16th-end
 * period arrives on the 15th (period A's payday, same month); pay for the
 * 1st-15th period arrives at the end of the previous month (the previous
 * period's payday). Each pulled back off a weekend like paydayOfPeriod.
 */
export function paydayDateFor(ref: PeriodRef): Date {
  if (ref.period === "B") {
    return new Date(Date.UTC(ref.year, ref.month - 1, paydayOfPeriod({ ...ref, period: "A" })));
  }
  const previous = previousPeriod(ref);
  return new Date(Date.UTC(previous.year, previous.month - 1, paydayOfPeriod(previous)));
}

/**
 * True from the day this period's pay lands until the period ends - the whole
 * stretch during which planning should already be looking at the *next* period.
 *
 * isPaydayDate() answers a narrower question ("is today a payday?") and is the
 * wrong test for planning: when a boundary is pulled back to the preceding
 * Friday, the Saturday and Sunday after it are past the pay but still inside
 * the ending period, and would otherwise send the planner back to a period
 * whose money has already been budgeted.
 */
export function isAfterPaydayInPeriod(date: Date): boolean {
  const day = startOfDay(date);
  return day.getUTCDate() >= paydayOfPeriod(periodForDate(day));
}

/**
 * The period clock: one answer to "what day is it, which period are we in,
 * and which period does the money in hand belong to".
 *
 *   today       the civil day, as given (today() in src/lib/date.ts for a request)
 *   current     the calendar period containing today
 *   plan        the period a check-in opened today plans for: the next one
 *               from the day the current period's pay lands until it ends
 *               (isAfterPaydayInPeriod), otherwise the current one
 *   planPayday  the day the plan period's pay lands (paydayDateFor)
 *
 * Every screen that counts "this period" for money already planned - the
 * check-in, the goal pages, the roadmap - reads `plan`; the hero, Budgets'
 * default and anything about spending so far read `current`.
 */
export interface PeriodClock {
  today: Date;
  current: PeriodInfo;
  plan: PeriodInfo;
  planPayday: Date;
}

export function periodClock(today: Date): PeriodClock {
  const day = startOfDay(today);
  const current = periodForDate(day);
  const plan = isAfterPaydayInPeriod(day) ? periodInfo(nextPeriod(current)) : current;
  return { today: day, current, plan, planPayday: paydayDateFor(plan) };
}

/**
 * How many days before a period's first day its pay may land and still be
 * that period's. A period's pay is modelled to land on its payday
 * (paydayDateFor), the last business day before it starts, but banks often
 * pay a day or two earlier still - the user's salary has landed on a Friday
 * three days before a Monday payday. Five days covers that with a day of
 * slack and stays well short of the period before's own pay.
 */
export const PAYCHECK_LEAD_DAYS = 5;

function incomeWindowStart(ref: PeriodRef): Date {
  return minDate(paydayDateFor(ref), addDays(periodInfo(ref).start, -PAYCHECK_LEAD_DAYS));
}

/**
 * The days an ordinary deposit is attributed to `ref`: from the earlier of
 * its payday and PAYCHECK_LEAD_DAYS before its first day, up to, not
 * including, where the next period's income window starts. Period income
 * (src/lib/period-income.ts) counts pay over it, and a check-in paycheck's
 * duplicate check (paycheckWindow in src/lib/recurring-settlement.ts) is
 * bounded by it.
 */
export function incomeWindow(ref: PeriodRef): { from: Date; until: Date } {
  return { from: incomeWindowStart(ref), until: incomeWindowStart(nextPeriod(ref)) };
}

/** The period whose income window contains `date`: the next one once its window has opened. */
export function fundedPeriodFor(date: Date): PeriodInfo {
  const current = periodForDate(date);
  const following = periodInfo(nextPeriod(current));
  return startOfDay(date).getTime() >= incomeWindowStart(following).getTime() ? following : current;
}

/** The day a period's pay was recorded as landing, if it has been (see fundingWindow). */
export type PayLanded = (ref: PeriodRef) => Date | null;

function fundingWindowStart(ref: PeriodRef, landed: Date | null): Date {
  const payday = paydayDateFor(ref);
  if (!landed) return payday;
  const day = startOfDay(landed);
  return day.getTime() >= incomeWindowStart(ref).getTime() && day.getTime() <= payday.getTime() ? day : payday;
}

/**
 * The days whose money is `ref`'s to move toward a goal: from the day its pay
 * actually landed - the recorded paycheck (a check-in's income transaction for
 * it, or a deposit attributed to it by its income window) when one falls
 * between PAYCHECK_LEAD_DAYS before its first day and its payday - otherwise
 * from its payday, up to, not including, where the next period's window
 * starts by the same rule. Until the next period's pay arrives, what is moved
 * is still this period's money.
 */
export function fundingWindow(ref: PeriodRef, payLanded: PayLanded): { from: Date; until: Date } {
  const next = nextPeriod(ref);
  return { from: fundingWindowStart(ref, payLanded(ref)), until: fundingWindowStart(next, payLanded(next)) };
}

/**
 * The period whose funding window (fundingWindow) holds `date`: the period
 * money moved that day is counted for - the one a goal contribution dated
 * then counts in (K3), and the one a recurring contribution due then is
 * filed in (src/lib/period-commitments.ts). A window opens before its
 * period's first day and never before the previous period's, so it is the
 * date's own period or, once the next period's window has opened, the next.
 */
export function fundingPeriodFor(date: Date, payLanded: PayLanded): PeriodInfo {
  const own = periodForDate(date);
  const next = periodInfo(nextPeriod(own));
  return startOfDay(date).getTime() >= fundingWindow(next, payLanded).from.getTime() ? next : own;
}

/** Which pay period a date falls into, with that month's real start/end dates. */
export function periodForDate(date: Date): PeriodInfo {
  const day = startOfDay(date);
  return periodInfo({
    year: day.getUTCFullYear(),
    month: day.getUTCMonth() + 1,
    period: day.getUTCDate() <= PERIOD_A_LAST_DAY ? "A" : "B",
  });
}

export function periodInfo(ref: PeriodRef): PeriodInfo {
  const lastDay = daysInMonth(ref.year, ref.month);
  const startDay = ref.period === "A" ? 1 : PERIOD_A_LAST_DAY + 1;
  const endDay = ref.period === "A" ? PERIOD_A_LAST_DAY : lastDay;
  const start = civilDate(ref.year, ref.month, startDay);
  const end = civilDate(ref.year, ref.month, endDay);
  return {
    ...ref,
    start,
    end,
    totalDays: endDay - startDay + 1,
    key: periodKey(ref),
  };
}

export function periodKey(ref: PeriodRef): string {
  return `${ref.year}-${String(ref.month).padStart(2, "0")}-${ref.period}`;
}

export function parsePeriodKey(value: string | null | undefined): PeriodRef | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-([AB])$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month, period: match[3] as PayPeriodCode };
}

export function nextPeriod(ref: PeriodRef): PeriodRef {
  if (ref.period === "A") return { ...ref, period: "B" };
  if (ref.month === 12) return { year: ref.year + 1, month: 1, period: "A" };
  return { year: ref.year, month: ref.month + 1, period: "A" };
}

export function previousPeriod(ref: PeriodRef): PeriodRef {
  if (ref.period === "B") return { ...ref, period: "A" };
  if (ref.month === 1) return { year: ref.year - 1, month: 12, period: "B" };
  return { year: ref.year, month: ref.month - 1, period: "B" };
}

/**
 * The most recent period sharing the same half-of-month as `ref` - one
 * previousPeriod() step lands on the opposite half (A<->B), so this composes
 * it twice to land one cycle back on the same half (e.g. this month's B ->
 * last month's B). Used wherever a "comparable prior period" is needed for
 * budget or spending comparisons, so a 1st-15th period is never compared
 * against a 16th-end one.
 */
export function previousComparablePeriod(ref: PeriodRef): PeriodRef {
  return previousPeriod(previousPeriod(ref));
}

/**
 * Days left in the period containing `date`, counting `date` itself, so a
 * per-day figure on the last day divides by 1 rather than 0.
 */
export function daysRemainingInPeriod(date: Date, info?: PeriodInfo): number {
  const period = info ?? periodForDate(date);
  const day = startOfDay(date);
  if (day.getTime() > period.end.getTime()) return 0;
  if (day.getTime() < period.start.getTime()) return period.totalDays;
  return daysBetween(day, period.end) + 1;
}

export function daysElapsedInPeriod(date: Date, info?: PeriodInfo): number {
  const period = info ?? periodForDate(date);
  return period.totalDays - daysRemainingInPeriod(date, period);
}

/**
 * How many pay periods a plan still has to run, from the period containing
 * `from`: every period whose pay lands (paydayDateFor) on or before `to`.
 * A period's money is in hand from its payday, so a target date in the middle
 * of a period - or on a weekend its pay was pulled back from - still has that
 * period's pay to fund it. 0 when `to` is before `from`.
 */
export function periodsRemaining(from: Date, to: Date): number {
  const target = startOfDay(to);
  if (target.getTime() < startOfDay(from).getTime()) return 0;
  let cursor = periodForDate(from);
  let count = 0;
  // Guard against runaway loops on absurd target dates (~40 years).
  for (let i = 0; i < 1000; i += 1) {
    if (paydayDateFor(cursor).getTime() > target.getTime()) break;
    count += 1;
    cursor = periodInfo(nextPeriod(cursor));
  }
  return count;
}

/**
 * How many pay periods a dated goal's roadmap spreads its pace over, counted
 * from the plan period's start: periodsRemaining(), but never fewer than the
 * plan period itself, so a target date already behind us still asks for the
 * whole remaining balance in the period being planned. The one rule the
 * roadmap pace, the goal forecast and Afford's per-period estimate share.
 */
export function goalPeriodsLeft(planStart: Date, targetDate: Date): number {
  return Math.max(1, periodsRemaining(planStart, targetDate));
}

/**
 * The periods a dated goal's roadmap pace covers: goalPeriodsLeft() of them,
 * from the plan period on. A period after the last of them is paid after the
 * goal's target date, where the pace has no meaning.
 */
export function goalWindow(planStart: Date, targetDate: Date): PeriodInfo[] {
  const window: PeriodInfo[] = [];
  let cursor = periodForDate(planStart);
  for (let i = goalPeriodsLeft(planStart, targetDate); i > 0; i -= 1) {
    window.push(cursor);
    cursor = periodInfo(nextPeriod(cursor));
  }
  return window;
}

/** The `count` most recent periods ending with `ref`, oldest first. */
export function periodSeries(ref: PeriodRef, count: number): PeriodInfo[] {
  const periods: PeriodInfo[] = [];
  let cursor: PeriodRef = ref;
  for (let i = 0; i < count; i += 1) {
    periods.unshift(periodInfo(cursor));
    cursor = previousPeriod(cursor);
  }
  return periods;
}

/** Prisma date filter for a period. */
export function periodRange(info: PeriodInfo) {
  return { gte: info.start, lte: info.end };
}
