import { addDays, civilDate, daysInMonth } from "@/lib/date";
import { payDayOfMonth } from "@/lib/period";

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
 * `anchor`'s realization `monthsAhead` months after `date`'s own month (0 =
 * the same month), weekend-shifted the way a pay boundary is - Saturday
 * pulled back a day, Sunday two (src/lib/period.ts's own payDayOfMonth,
 * reused directly rather than re-implemented here). That shift can spill
 * into the previous calendar month (an anchor of 1 falling on a Saturday
 * lands on the last day of the month before) - civilDate()'s day-overflow
 * handling resolves that correctly, the same way it resolves anchorDay 31
 * clamped to a short month.
 */
function semiMonthlyRealization(date: Date, monthsAhead: number, anchor: number): Date {
  const monthIndex = date.getUTCMonth() + monthsAhead;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const rawDay = Math.min(anchor, daysInMonth(year, month));
  return civilDate(year, month, payDayOfMonth(year, month, rawDay));
}

/**
 * The next SEMI_MONTHLY realization of `anchor` strictly after `date`,
 * walking forward a month at a time. Bounded defensively (realizations
 * strictly increase by roughly a month each step, so this never takes more
 * than a couple of tries in practice) rather than trusting that to hold for
 * every possible input.
 */
function nextAnchorRealizationAfter(date: Date, anchor: number): Date {
  let monthsAhead = 0;
  let candidate = semiMonthlyRealization(date, monthsAhead, anchor);
  while (candidate.getTime() <= date.getTime() && monthsAhead < 24) {
    monthsAhead += 1;
    candidate = semiMonthlyRealization(date, monthsAhead, anchor);
  }
  return candidate;
}

/**
 * The next SEMI_MONTHLY occurrence after `date`: the sooner of the two
 * anchors' own next realizations, found independently of each other rather
 * than by asking "which anchor does `date` itself stand in for, in which
 * month" - that classification breaks exactly when a shift has pushed an
 * anchor's realization into the *previous* calendar month (anchorDay 1
 * shifted onto the last Friday of the month before), where `date`'s own
 * .getUTCMonth() no longer names the month the anchor was really due in.
 */
function semiMonthlyAdvance(date: Date, anchorDay: number, secondAnchorDay: number): Date {
  const first = nextAnchorRealizationAfter(date, anchorDay);
  const second = nextAnchorRealizationAfter(date, secondAnchorDay);
  return first.getTime() <= second.getTime() ? first : second;
}

/**
 * The next occurrence after `date` for a given frequency.
 *
 * `anchorDay` is RecurringItem.anchorDay - the day of the month the item is
 * really due on. It matters only for MONTHLY, YEARLY and SEMI_MONTHLY, the
 * frequencies that can land in a month too short to hold the day. Omitting it
 * falls back to `date`'s own day, which is correct only for an occurrence
 * that has never been clamped; every caller that has an item in hand should
 * pass the stored anchor.
 *
 * `secondAnchorDay` is RecurringItem.secondAnchorDay, the other of
 * SEMI_MONTHLY's two due days - both weekend-shifted the way a payday is
 * (see semiMonthlyAdvance). Omitting it degrades a SEMI_MONTHLY item to a
 * plain single-anchor monthly advance rather than crashing, for a caller
 * that has not been extended for the second anchor; every real
 * RecurringItem row always carries both.
 */
export function advanceDate(
  date: Date,
  frequency: RecurringFrequency,
  anchorDay?: number | null,
  secondAnchorDay?: number | null,
): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDays(date, 7);
    case "BIWEEKLY":
      return addDays(date, 14);
    case "SEMI_MONTHLY": {
      const first = anchorDay ?? date.getUTCDate();
      if (secondAnchorDay === null || secondAnchorDay === undefined) {
        return occurrenceAfter(date, 1, first);
      }
      return semiMonthlyAdvance(date, first, secondAnchorDay);
    }
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
  /** RecurringItem.secondAnchorDay - only meaningful when frequency is SEMI_MONTHLY. */
  secondAnchorDay?: number | null;
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
    cursor = advanceDate(cursor, item.frequency, item.anchorDay, item.secondAnchorDay);
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
    case "SEMI_MONTHLY":
      return amount * 2;
    case "YEARLY":
      return amount / 12;
    case "MONTHLY":
    default:
      return amount;
  }
}

/**
 * A finite item that has posted (or been marked as having paid) its last
 * occurrence. Distinct from a paused item, which the user switched off with
 * payments still owed: resuming a finished plan needs new Payments left first,
 * or posting would retire it again on its next run (see the countdown branch
 * in src/lib/recurring-posting.ts).
 */
export function isFinishedPlan(item: { active: boolean; remainingOccurrences: number | null }): boolean {
  return !item.active && item.remainingOccurrences !== null && item.remainingOccurrences <= 0;
}
