import { addDays, civilDate, daysInMonth } from "@/lib/date";
import { payDayOfMonth } from "@/lib/period";

import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

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
export function semiMonthlyRealization(date: Date, monthsAhead: number, anchor: number): Date {
  const monthIndex = date.getUTCMonth() + monthsAhead;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const rawDay = Math.min(anchor, daysInMonth(year, month));
  return civilDate(year, month, payDayOfMonth(year, month, rawDay));
}

const ANCHOR_COLLISION_FROM_YEAR = 2000;
const ANCHOR_COLLISION_TO_YEAR = 2099;
const anchorCollisions = new Map<number, boolean>();

/**
 * Whether two SEMI_MONTHLY anchors can resolve to the same date in some month,
 * in which case posting (which advances to the sooner of the two realizations,
 * strictly after the last) posts one charge for that month instead of two.
 * Judged with semiMonthlyRealization itself over every month of 2000-2099,
 * which holds every leap year and every alignment of weekday and day of the
 * month (the Gregorian calendar repeats every 400 years, and the 28-year
 * weekday cycle runs unbroken through 2001-2099). Realizations can spill into
 * the neighbouring month (an anchor of 1 on a Saturday lands on the last day of
 * the month before), so the two anchors' dates are compared as a whole, not
 * month by month.
 */
export function semiMonthlyAnchorsCollide(anchor: number, secondAnchor: number): boolean {
  const key = Math.min(anchor, secondAnchor) * 100 + Math.max(anchor, secondAnchor);
  const known = anchorCollisions.get(key);
  if (known !== undefined) return known;
  const first = new Set<number>();
  for (let year = ANCHOR_COLLISION_FROM_YEAR; year <= ANCHOR_COLLISION_TO_YEAR; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      first.add(semiMonthlyRealization(civilDate(year, month, 1), 0, anchor).getTime());
    }
  }
  let collide = false;
  for (let year = ANCHOR_COLLISION_FROM_YEAR; year <= ANCHOR_COLLISION_TO_YEAR && !collide; year += 1) {
    for (let month = 1; month <= 12 && !collide; month += 1) {
      collide = first.has(semiMonthlyRealization(civilDate(year, month, 1), 0, secondAnchor).getTime());
    }
  }
  anchorCollisions.set(key, collide);
  return collide;
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

/**
 * The first occurrence of `item` on or after `today`, walking from its own
 * nextDate with the rules posting walks by (advanceDate: the stored anchor,
 * SEMI_MONTHLY's weekend shift, month-end clamping), so the date it lands on
 * is one posting itself would have reached. An item already due on or after
 * today is returned unchanged. Used where an item becomes postable again
 * after a stretch in which it could not post, to skip the occurrences that
 * stretch covered instead of charging them (see skipMissedOccurrences in
 * src/lib/data/recurring.ts).
 */
export function firstOccurrenceOnOrAfter(
  item: Pick<ScheduledItem, "nextDate" | "frequency" | "anchorDay" | "secondAnchorDay">,
  today: Date,
): Date {
  let cursor = item.nextDate;
  // Bounded defensively: every step moves forward, and 5,000 weekly steps is
  // ninety years of standing still.
  for (let i = 0; i < MAX_SKIP_WALK && cursor.getTime() < today.getTime(); i += 1) {
    cursor = advanceDate(cursor, item.frequency, item.anchorDay, item.secondAnchorDay);
  }
  return cursor;
}

const MAX_SKIP_WALK = 5000;

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

/**
 * How many elapsed occurrences a single posting run posts per item. Bounds the
 * work (and the surprise) when the app has been untouched for a long time; a
 * longer backlog finishes over the following runs.
 */
export const MAX_OCCURRENCES_PER_ITEM = 24;

/** What posting will write for an item whose nextDate is already behind. */
export interface PostingPreview {
  /** Charges the first run posts: everything owed, up to MAX_OCCURRENCES_PER_ITEM. */
  count: number;
  first: Date;
  last: Date;
  /** More occurrences are owed than one run posts; the rest follow on later runs. */
  capped: boolean;
}

/**
 * What saving `item` would have posting write, as of `today`: the occurrences
 * owedOccurrences() finds from nextDate up to today - the same walk, stopping
 * at a finite item's countdown - of which one run posts the first
 * MAX_OCCURRENCES_PER_ITEM. Null when nextDate is today or later (the form's
 * note has nothing to say) or nothing is owed. Blind to a charge the user
 * already entered, which posting may settle an occurrence with instead.
 */
export function previewPostingFrom(item: ScheduledItem, today: Date): PostingPreview | null {
  if (item.nextDate.getTime() >= today.getTime()) return null;
  const owed = owedOccurrences(item, item.nextDate, today);
  if (owed.length === 0) return null;
  const posted = owed.slice(0, MAX_OCCURRENCES_PER_ITEM);
  return {
    count: posted.length,
    first: posted[0],
    last: posted[posted.length - 1],
    capped: owed.length > MAX_OCCURRENCES_PER_ITEM,
  };
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

export type RecurringSkipReason =
  | "missing_account"
  | "missing_goal"
  | "missing_account_and_goal"
  | "account_archived"
  /** A contribution whose goal is already fully funded: nothing more to put in. */
  | "goal_achieved";

/** What a RecurringItem is linked to, as far as posting needs it to be. */
export interface PostingLinks {
  kind: RecurringKind;
  accountId: string | null;
  goalId: string | null;
  account: { status: string } | null;
  goal: { achievedAt: Date | null } | null;
}

/**
 * Why posting would skip this item, or null when its links let it post.
 * Says nothing about `active`: a paused item is filtered out before this is
 * asked. The one definition behind postDueRecurringItems' skip and every
 * place that has to know whether an item is postable (the transitions that
 * make one postable again, see skipMissedOccurrences).
 */
export function skipReasonFor(item: PostingLinks): RecurringSkipReason | null {
  const missingAccount = !item.accountId;
  const missingGoal = item.kind === "CONTRIBUTION" && !item.goalId;
  if (missingAccount && missingGoal) return "missing_account_and_goal";
  if (missingAccount) return "missing_account";
  if (missingGoal) return "missing_goal";
  if (item.account?.status === "ARCHIVED") return "account_archived";
  // A contribution to a goal that has reached its target is skipped, never
  // advanced and never paused: the item stays exactly as it is until the
  // goal is open again (which clears achievedAt, see rebuildGoalSaved).
  if (item.kind === "CONTRIBUTION" && item.goal?.achievedAt) return "goal_achieved";
  return null;
}
