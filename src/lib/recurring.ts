import { addDays, civilDate, daysInMonth } from "@/lib/date";

import type { RecurringFrequency } from "@/generated/prisma/enums";

/**
 * The occurrence `months` after `date`, placed on `anchorDay` of the target
 * month (clamped to that month's real length).
 *
 * The clamp deliberately reads the anchor rather than `date`'s own day, so a
 * short month never compounds: an item anchored on the 31st runs
 * Jan 31 -> Feb 28 -> Mar 31, where taking the day from the previous (already
 * clamped) occurrence would have stranded it on the 28th for good.
 */
function occurrenceAfter(date: Date, months: number, anchorDay: number): Date {
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  return civilDate(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

/**
 * The next occurrence after `date` for a given frequency.
 *
 * `anchorDay` is RecurringItem.anchorDay - the day of the month the item is
 * really due on. It matters only for MONTHLY and YEARLY, the two frequencies
 * that can land in a month too short to hold the day. Omitting it falls back to
 * `date`'s own day, which is correct only for an occurrence that has never been
 * clamped; every caller that has an item in hand should pass the stored anchor.
 */
export function advanceDate(
  date: Date,
  frequency: RecurringFrequency,
  anchorDay?: number | null,
): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDays(date, 7);
    case "BIWEEKLY":
      return addDays(date, 14);
    case "YEARLY":
      return occurrenceAfter(date, 12, anchorDay ?? date.getUTCDate());
    case "MONTHLY":
    default:
      return occurrenceAfter(date, 1, anchorDay ?? date.getUTCDate());
  }
}

/** The schedule fields every occurrence walk needs, whatever loaded the row. */
export interface ScheduledItem {
  nextDate: Date;
  frequency: RecurringFrequency;
  anchorDay?: number | null;
  /**
   * RecurringItem.remainingOccurrences: how many more times the item posts,
   * counted from nextDate, before it switches itself off. Null or absent
   * means unbounded.
   */
  remainingOccurrences?: number | null;
}

/** Never walk more occurrences than this, however far behind an item has fallen. */
const MAX_OCCURRENCE_WALK = 400;

/**
 * Every occurrence of `item` owed within [from, to].
 *
 * Two things this does that reading `nextDate` alone cannot. An item due more
 * than once in the window (anything weekly or biweekly, and a monthly item in a
 * long window) contributes each of its due dates, not just the first. And an
 * item whose `nextDate` has already passed `from` is still owed - the posting
 * job leaves an item it cannot post exactly where it is - so its outstanding
 * date is counted rather than dropped for being in the past. A long-broken item
 * counts once for that backlog rather than once per missed occurrence, so one
 * unpostable item cannot swamp a period's committed total.
 *
 * A finite item (remainingOccurrences set - an installment plan) has only that
 * many occurrences left, counted from nextDate the way posting counts them
 * down, so the walk stops there: a two-payment plan never owes a third date
 * however long the window is, and a plan with nothing left owes nothing.
 *
 * Returns an empty list when the window is already over (`from` after `to`).
 */
export function owedOccurrences(item: ScheduledItem, from: Date, to: Date): Date[] {
  if (from.getTime() > to.getTime()) return [];
  const remaining = item.remainingOccurrences ?? Number.POSITIVE_INFINITY;
  if (remaining <= 0) return [];

  const dates: Date[] = [];
  if (item.nextDate.getTime() < from.getTime()) dates.push(item.nextDate);

  // `i` counts occurrences from nextDate whether or not they land in the
  // window, so the countdown is spent exactly as posting will spend it.
  let cursor = item.nextDate;
  for (let i = 0; i < MAX_OCCURRENCE_WALK && i < remaining && cursor.getTime() <= to.getTime(); i += 1) {
    if (cursor.getTime() >= from.getTime()) dates.push(cursor);
    cursor = advanceDate(cursor, item.frequency, item.anchorDay);
  }
  return dates;
}

/** Cost per calendar month, used for the subscriptions total. */
export function monthlyEquivalent(
  amount: number,
  frequency: RecurringFrequency,
): number {
  switch (frequency) {
    case "WEEKLY":
      return (amount * 52) / 12;
    case "BIWEEKLY":
      return (amount * 26) / 12;
    case "YEARLY":
      return amount / 12;
    case "MONTHLY":
    default:
      return amount;
  }
}
