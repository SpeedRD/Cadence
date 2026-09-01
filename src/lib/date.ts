/**
 * Calendar-day helpers.
 *
 * Every date the app treats as a "day" (transaction dates, budget periods,
 * recurring due dates) is stored in a Postgres `date` column and represented in
 * JS as a Date pinned to UTC midnight. All arithmetic and formatting here works
 * in UTC so a day never shifts under a timezone offset. The one place local
 * time matters is deciding what "today" is, which uses APP_TIMEZONE.
 */

import type { Dictionary } from "@/lib/i18n";

export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MS_PER_DAY = 86_400_000;

/** Build a UTC-midnight date from calendar parts (month is 1-12). */
export function civilDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Strip any time component, keeping the UTC calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export const DEFAULT_APP_TIMEZONE = "America/Santo_Domingo";

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The app's business timezone: APP_TIMEZONE if set to a valid IANA zone,
 * otherwise DEFAULT_APP_TIMEZONE. This is the single source of truth for
 * "what timezone is Cadence's business logic in" - every place that needs it
 * (today(), display formatting, the settings page) should call this rather
 * than reading process.env.APP_TIMEZONE directly, so a missing or malformed
 * value can never silently fall through to the runtime's own timezone (UTC
 * on Vercel).
 */
export function appTimeZone(): string {
  const configured = process.env.APP_TIMEZONE;
  if (configured && isValidTimeZone(configured)) return configured;
  return DEFAULT_APP_TIMEZONE;
}

/** The civil calendar day `instant` falls on in `timeZone`, as UTC midnight. */
export function civilDateInZone(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  const [year, month, day] = parts.split("-").map(Number);
  return civilDate(year, month, day);
}

/** Today's calendar day in APP_TIMEZONE (defaults to America/Santo_Domingo), as UTC midnight. */
export function today(): Date {
  return civilDateInZone(new Date(), appTimeZone());
}

/** "YYYY-MM-DD" for a UTC-midnight date. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse "YYYY-MM-DD" into a UTC-midnight date. Returns null if invalid. */
export function fromISODate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return civilDate(year, month, day);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Add months, clamping the day to the end of the target month. */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(
    date.getUTCDate(),
    daysInMonth(targetYear, targetMonth + 1),
  );
  return civilDate(targetYear, targetMonth + 1, day);
}

export function addYears(date: Date, years: number): Date {
  return addMonths(date, years * 12);
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_PER_DAY);
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** "Aug 16, 2026" */
export function formatDate(date: Date): string {
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "Aug 16" */
export function formatDayMonth(date: Date): string {
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "in 3 days" / "today" / "5 days ago" */
export function formatRelativeDays(
  from: Date,
  to: Date,
  common: Pick<Dictionary["common"], "today" | "tomorrow" | "yesterday" | "inDays" | "daysAgo">,
): string {
  const diff = daysBetween(from, to);
  if (diff === 0) return common.today;
  if (diff === 1) return common.tomorrow;
  if (diff === -1) return common.yesterday;
  if (diff > 0) return common.inDays(diff);
  return common.daysAgo(Math.abs(diff));
}
