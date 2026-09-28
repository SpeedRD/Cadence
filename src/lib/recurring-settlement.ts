/**
 * Which charge the user entered (a manual entry, a CSV row, an approved
 * receipt) stands for which occurrence of a recurring item - the one matcher
 * behind recurring posting's "already logged" and the payday check-in's
 * "Already paid this period". Pure and database-free: the loader is
 * src/lib/data/recurring-settlement.ts, the only writer of the pairing is
 * postDueRecurringItems (src/lib/recurring-posting.ts), and the pairing itself
 * is the RecurringSettlement table.
 *
 * The rules, all of them here so both readers get the same verdict:
 *
 *   - Predicate: the monthly pace's own (chargeMatchesItem, also used by
 *     matchRecurringToTransactions) - same currency, amount within a cent, and
 *     either the item's name in the note or its category. When two active
 *     items share a currency, an amount and a category, the category cannot
 *     tell them apart, so for both of them only the name counts. That guard is
 *     judged over every active item, never over the ones that happen to be due
 *     on a given day, or posting and the check-in would disagree about it.
 *   - Candidates: every account, and only charges no RecurringSettlement row
 *     has already paired. RECURRING rows are posting's own output, never a
 *     candidate.
 *   - Window: the occurrence's pay period, reaching back SETTLEMENT_LEAD_DAYS
 *     before the due date when that falls before the period starts - see
 *     settlementWindow.
 *   - One charge, one occurrence: occurrences take charges in due-date order
 *     (item id breaking ties), each the earliest eligible charge still free.
 *     Because an occurrence's choice depends only on the ones due before it,
 *     planning through today (posting) and through a plan period's end (the
 *     check-in) agree on every occurrence both cover.
 *   - Contributions: a hand-logged contribution's own expense (externalId
 *     "goal-contribution:<id>") settles an occurrence of an item paying into
 *     the same goal, and nothing else - its GoalContribution already counts
 *     the money. Any other matched charge settles a contribution occurrence
 *     only together with a GoalContribution posting writes for it, carrying
 *     the occurrence key, so the charge becomes that contribution's twin.
 */
import { addDays, maxDate, minDate, toISODate } from "@/lib/date";
import { periodForDate } from "@/lib/period";

import type { RecurringKind } from "@/generated/prisma/enums";

/** Amounts within a cent of each other are treated as the same charge. */
export const AMOUNT_MATCH_TOLERANCE = 0.01;

/**
 * How many days before its due date a charge can settle an occurrence due
 * early in a pay period. A period's paycheck lands on the last day of the
 * period before, pulled back to Friday when that is a weekend - up to three
 * days before the period starts - and bills due on the 1st or 2nd are
 * commonly paid from it that day. Five days covers that with a day of slack
 * for card posting dates, and stays shorter than a week, so it reaches back
 * past the period start only for an occurrence due in the period's first few
 * days. Anything paid earlier than that is too far from its due date to be
 * presumed the same bill.
 */
export const SETTLEMENT_LEAD_DAYS = 5;

/** The item fields the predicate reads. */
export interface MatchableItem {
  id: string;
  name: string;
  amount: number;
  currency: string;
  categoryId: string | null;
}

/** The charge fields the predicate reads. */
export interface MatchableCharge {
  id: string;
  amount: number;
  currency: string;
  categoryId: string | null;
  note: string | null;
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Currency, amount and category: everything a category-only match can see. */
function shapeKey(item: MatchableItem): string {
  return `${item.currency}|${item.amount.toFixed(2)}|${item.categoryId ?? ""}`;
}

/**
 * The ids of the items whose category cannot tell them apart from another
 * item's: two or more share a currency, an amount and a category.
 */
export function itemsWithAmbiguousCategory(items: readonly MatchableItem[]): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(shapeKey(item), (counts.get(shapeKey(item)) ?? 0) + 1);
  return new Set(items.filter((item) => (counts.get(shapeKey(item)) ?? 0) > 1).map((item) => item.id));
}

/**
 * Whether `charge` looks like one of `item`'s charges: same currency, amount
 * within a cent, and either the item's name in the note or - unless
 * `categoryIsAmbiguous` - the item's category.
 */
export function chargeMatchesItem(item: MatchableItem, charge: MatchableCharge, categoryIsAmbiguous: boolean): boolean {
  if (charge.currency !== item.currency) return false;
  if (Math.abs(charge.amount - item.amount) > AMOUNT_MATCH_TOLERANCE) return false;
  const normalizedName = normalizeForMatch(item.name);
  const nameMatches =
    normalizedName.length > 0 && Boolean(charge.note) && normalizeForMatch(charge.note as string).includes(normalizedName);
  const categoryMatches = item.categoryId !== null && charge.categoryId === item.categoryId && !categoryIsAmbiguous;
  return nameMatches || categoryMatches;
}

/** "<itemId>:<YYYY-MM-DD>": one occurrence's key - the RECURRING row's externalId, the settlement's occurrenceKey. */
export function recurringExternalId(itemId: string, due: Date): string {
  return `${itemId}:${toISODate(due)}`;
}

/**
 * The days a charge may fall on to settle the occurrence due on `due`: its
 * pay period, starting SETTLEMENT_LEAD_DAYS before `due` when that is earlier
 * than the period's first day. Rent due on the 1st and paid on the 30th is in
 * its window; rent due on the 10th and paid on the 30th is not.
 */
export function settlementWindow(due: Date): { start: Date; end: Date } {
  const period = periodForDate(due);
  return { start: minDate(period.start, addDays(due, -SETTLEMENT_LEAD_DAYS)), end: period.end };
}

export interface SettlementItem extends MatchableItem {
  kind: RecurringKind;
  /** CONTRIBUTION only: the goal it pays into. */
  goalId: string | null;
}

export interface SettlementCharge extends MatchableCharge {
  date: Date;
  /**
   * Set only on a hand-logged contribution's own expense: the goal its
   * GoalContribution is on. Such a charge settles a contribution to that goal
   * and nothing else.
   */
  contributionGoalId: string | null;
}

export interface SettlementOccurrence {
  itemId: string;
  due: Date;
}

/**
 * Pairs occurrences with the charges that already paid them. `items` is every
 * active item (the population the look-alike guard is judged over);
 * `occurrences` are the ones still unclaimed and without a RECURRING row;
 * `charges` are the candidates no settlement has paired yet. Returns the
 * charge id for each settled occurrence, keyed by recurringExternalId.
 */
export function planSettlements(input: {
  items: readonly SettlementItem[];
  occurrences: readonly SettlementOccurrence[];
  charges: readonly SettlementCharge[];
}): Map<string, string> {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const ambiguous = itemsWithAmbiguousCategory(input.items);
  const charges = [...input.charges].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
  );
  const ordered = [...input.occurrences].sort(
    (a, b) => a.due.getTime() - b.due.getTime() || a.itemId.localeCompare(b.itemId),
  );

  const taken = new Set<string>();
  const settled = new Map<string, string>();
  for (const occurrence of ordered) {
    const item = itemById.get(occurrence.itemId);
    if (!item) continue;
    const window = settlementWindow(occurrence.due);
    const match = charges.find((charge) => {
      if (taken.has(charge.id)) return false;
      if (charge.date.getTime() < window.start.getTime() || charge.date.getTime() > window.end.getTime()) return false;
      if (charge.contributionGoalId !== null) {
        return (
          item.kind === "CONTRIBUTION" &&
          item.goalId === charge.contributionGoalId &&
          charge.currency === item.currency &&
          Math.abs(charge.amount - item.amount) <= AMOUNT_MATCH_TOLERANCE
        );
      }
      return chargeMatchesItem(item, charge, ambiguous.has(item.id));
    });
    if (!match) continue;
    taken.add(match.id);
    settled.set(recurringExternalId(item.id, occurrence.due), match.id);
  }
  return settled;
}

/** The earliest and latest day any of these occurrences' windows reach, or null for none. */
export function settlementSpan(dues: readonly Date[]): { start: Date; end: Date } | null {
  let span: { start: Date; end: Date } | null = null;
  for (const due of dues) {
    const window = settlementWindow(due);
    span = span ? { start: minDate(span.start, window.start), end: maxDate(span.end, window.end) } : window;
  }
  return span;
}
