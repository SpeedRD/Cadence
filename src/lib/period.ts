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
  MONTHS_LONG,
  MONTHS_SHORT,
  civilDate,
  daysBetween,
  daysInMonth,
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
  /** "Aug 16-31" */
  label: string;
  /** "August 16-31, 2026" */
  longLabel: string;
  /** "2026-08-B" */
  key: string;
}

export const PERIOD_A_LAST_DAY = 15;

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
  const monthShort = MONTHS_SHORT[ref.month - 1];
  const monthLong = MONTHS_LONG[ref.month - 1];
  return {
    ...ref,
    start,
    end,
    totalDays: endDay - startDay + 1,
    label: `${monthShort} ${startDay}-${endDay}`,
    longLabel: `${monthLong} ${startDay}-${endDay}, ${ref.year}`,
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
 * How many pay periods a plan still has to run: every period that ends on or
 * after `from` and on or before `to`. The current (partly elapsed) period counts
 * when its end date still fits inside the deadline.
 */
export function periodsRemaining(from: Date, to: Date): number {
  const target = startOfDay(to);
  if (target.getTime() < startOfDay(from).getTime()) return 0;
  let cursor = periodForDate(from);
  let count = 0;
  // Guard against runaway loops on absurd target dates (~40 years).
  for (let i = 0; i < 1000; i += 1) {
    if (cursor.end.getTime() > target.getTime()) break;
    count += 1;
    cursor = periodInfo(nextPeriod(cursor));
  }
  return count;
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
