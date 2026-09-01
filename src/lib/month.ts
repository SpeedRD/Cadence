/**
 * Calendar months, for the monthly spending pace feature.
 *
 * This is deliberately separate from src/lib/period.ts: pay periods (A/B) drive
 * budgets and safe-to-spend, and are never touched by this file. A "month
 * window" here is the actual calendar month (1st through its real last day -
 * 28/29/30/31), used only for the monthly pace card and monthly reports.
 */
import {
  MONTHS_LONG,
  MONTHS_SHORT,
  civilDate,
  daysBetween,
  daysInMonth,
  startOfDay,
} from "@/lib/date";

export interface MonthRef {
  year: number;
  month: number; // 1-12
}

export interface MonthWindow extends MonthRef {
  start: Date;
  end: Date;
  totalDays: number;
  /** "Aug 2026" */
  label: string;
  /** "August 2026" */
  longLabel: string;
  /** "2026-08" */
  key: string;
}

export function monthWindow(ref: MonthRef): MonthWindow {
  const totalDays = daysInMonth(ref.year, ref.month);
  return {
    ...ref,
    start: civilDate(ref.year, ref.month, 1),
    end: civilDate(ref.year, ref.month, totalDays),
    totalDays,
    label: `${MONTHS_SHORT[ref.month - 1]} ${ref.year}`,
    longLabel: `${MONTHS_LONG[ref.month - 1]} ${ref.year}`,
    key: monthKey(ref),
  };
}

export function monthForDate(date: Date): MonthWindow {
  const day = startOfDay(date);
  return monthWindow({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1 });
}

export function monthKey(ref: MonthRef): string {
  return `${ref.year}-${String(ref.month).padStart(2, "0")}`;
}

export function previousMonth(ref: MonthRef): MonthRef {
  if (ref.month === 1) return { year: ref.year - 1, month: 12 };
  return { year: ref.year, month: ref.month - 1 };
}

/**
 * Days elapsed in the month containing `date`, counting `date` itself (so the
 * 1st of the month counts as 1 day elapsed, never 0) - this is what the
 * current-month projection formula divides by.
 */
export function daysElapsedInMonth(date: Date, window?: MonthWindow): number {
  const win = window ?? monthForDate(date);
  return daysBetween(win.start, startOfDay(date)) + 1;
}
