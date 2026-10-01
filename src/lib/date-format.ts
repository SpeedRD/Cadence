/**
 * Month names and the date and period labels built from them, in the app's
 * language: the one place the UI turns a calendar day, a pay period or a
 * calendar month into text. Pure and database-free, like src/lib/date.ts,
 * whose UTC-midnight dates it reads (a date never shifts under a timezone).
 *
 * The names are tables here rather than Intl's so the output is the same on
 * every runtime's ICU build and the abbreviations stay as short as the phone
 * layouts need ("sep", never "sept."). Nothing else in the app spells out a
 * month; a new label goes here.
 *
 *   formatDate        "Aug 16, 2026"            "16 ago 2026"
 *   formatDayMonth    "Aug 16"                  "16 ago"
 *   formatPeriodShort "Sep 16-30"               "16-30 sep"
 *   formatPeriodLong  "September 16-30, 2026"   "16-30 de septiembre de 2026"
 *   formatMonthShort  "Aug 2026"                "ago 2026"
 *   formatMonthLong   "August 2026"             "agosto de 2026"
 */
import type { Locale } from "@/lib/i18n";

const MONTH_NAMES: Record<Locale, { short: readonly string[]; long: readonly string[] }> = {
  en: {
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    long: [
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
    ],
  },
  es: {
    short: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
    long: [
      "enero",
      "febrero",
      "marzo",
      "abril",
      "mayo",
      "junio",
      "julio",
      "agosto",
      "septiembre",
      "octubre",
      "noviembre",
      "diciembre",
    ],
  },
};

/** The abbreviated name of `month` (1-12). */
export function monthShort(month: number, locale: Locale): string {
  return MONTH_NAMES[locale].short[month - 1];
}

/** The full name of `month` (1-12). */
export function monthLong(month: number, locale: Locale): string {
  return MONTH_NAMES[locale].long[month - 1];
}

/** A calendar day: "Aug 16, 2026" / "16 ago 2026". */
export function formatDate(date: Date, locale: Locale): string {
  const month = monthShort(date.getUTCMonth() + 1, locale);
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  return locale === "es" ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
}

/** A calendar day without its year: "Aug 16" / "16 ago". */
export function formatDayMonth(date: Date, locale: Locale): string {
  const month = monthShort(date.getUTCMonth() + 1, locale);
  const day = date.getUTCDate();
  return locale === "es" ? `${day} ${month}` : `${month} ${day}`;
}

/** What a period label reads: the pay period's month and its first and last day. */
export interface PeriodLabelSource {
  year: number;
  month: number;
  start: Date;
  end: Date;
}

/** A pay period, short: "Sep 16-30" / "16-30 sep". */
export function formatPeriodShort(period: PeriodLabelSource, locale: Locale): string {
  const days = `${period.start.getUTCDate()}-${period.end.getUTCDate()}`;
  const month = monthShort(period.month, locale);
  return locale === "es" ? `${days} ${month}` : `${month} ${days}`;
}

/** A pay period with its year: "September 16-30, 2026" / "16-30 de septiembre de 2026". */
export function formatPeriodLong(period: PeriodLabelSource, locale: Locale): string {
  const days = `${period.start.getUTCDate()}-${period.end.getUTCDate()}`;
  const month = monthLong(period.month, locale);
  return locale === "es" ? `${days} de ${month} de ${period.year}` : `${month} ${days}, ${period.year}`;
}

/** A calendar month, short: "Aug 2026" / "ago 2026". */
export function formatMonthShort(ref: { year: number; month: number }, locale: Locale): string {
  return `${monthShort(ref.month, locale)} ${ref.year}`;
}

/** A calendar month: "August 2026" / "agosto de 2026". */
export function formatMonthLong(ref: { year: number; month: number }, locale: Locale): string {
  const month = monthLong(ref.month, locale);
  return locale === "es" ? `${month} de ${ref.year}` : `${month} ${ref.year}`;
}
