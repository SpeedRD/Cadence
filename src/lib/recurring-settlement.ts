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
 *
 * The reverse question - a charge brought in after posting already wrote the
 * occurrence's RECURRING row, or a deposit after a check-in recorded the
 * paycheck - is planPostedDuplicates below, on the same window, guard and
 * one-to-one rule.
 */
import { convert, type RateTable } from "@/lib/currency";
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
 * Whether `charge` names `item`: the item's name in the note, or - unless
 * `categoryIsAmbiguous` - the item's category. The identity half of
 * chargeMatchesItem, without the amount.
 */
export function chargeIdentifiesItem(
  item: MatchableItem,
  charge: Pick<MatchableCharge, "categoryId" | "note">,
  categoryIsAmbiguous: boolean,
): boolean {
  const normalizedName = normalizeForMatch(item.name);
  const nameMatches =
    normalizedName.length > 0 && Boolean(charge.note) && normalizeForMatch(charge.note as string).includes(normalizedName);
  const categoryMatches = item.categoryId !== null && charge.categoryId === item.categoryId && !categoryIsAmbiguous;
  return nameMatches || categoryMatches;
}

/**
 * Whether `charge` looks like one of `item`'s charges: same currency, amount
 * within a cent, and either the item's name in the note or - unless
 * `categoryIsAmbiguous` - the item's category.
 */
export function chargeMatchesItem(item: MatchableItem, charge: MatchableCharge, categoryIsAmbiguous: boolean): boolean {
  if (charge.currency !== item.currency) return false;
  if (Math.abs(charge.amount - item.amount) > AMOUNT_MATCH_TOLERANCE) return false;
  return chargeIdentifiesItem(item, charge, categoryIsAmbiguous);
}

/** "<itemId>:<YYYY-MM-DD>": one occurrence's key - the RECURRING row's externalId, the settlement's occurrenceKey. */
export function recurringExternalId(itemId: string, due: Date): string {
  return `${itemId}:${toISODate(due)}`;
}

/** The item id inside a recurringExternalId, or null for anything not shaped like one. */
export function itemIdFromOccurrenceKey(key: string): string | null {
  const separator = key.lastIndexOf(":");
  return separator > 0 ? key.slice(0, separator) : null;
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

// ---------------------------------------------------------------------------
// The other direction: a charge brought in (a CSV row, an approved receipt, a
// manual entry) after posting already wrote the occurrence's RECURRING row, or
// a deposit after a payday check-in recorded the paycheck. planSettlements
// cannot see these - the occurrence is claimed - so without this the same
// money lands twice. Same window, same look-alike guard, same one-to-one rule;
// the loader is src/lib/data/posted-duplicates.ts, and nothing here decides
// anything: a match is put to the user, who says whether it is the same money.
// ---------------------------------------------------------------------------

/**
 * How far a charge in another currency may land from the posted amount,
 * converted into the charge's currency at the current rate table, and still
 * be shown as a possible match - a share of the converted amount. A card
 * charge settles within a few tenths of a percent of the published bank rate,
 * a foreign-transaction margin can add one or two points on top, and the rate
 * table is today's while the charge is from up to a period ago. Three percent
 * covers all of that for one charge; two genuinely different subscriptions
 * rarely sit that close, and when they do the look-alike guard and the user
 * still decide - a cross-currency match is only ever a warning.
 */
export const CROSS_CURRENCY_MATCH_TOLERANCE = 0.03;

/** A row being brought in, before it is written (or just after, for a manual entry). */
export interface IncomingEntry {
  /** The caller's handle for it: a CSV row index, a staged row id, a transaction id. */
  key: string;
  accountId: string;
  type: "EXPENSE" | "INCOME";
  date: Date;
  amount: number;
  currency: string;
  categoryId: string | null;
  note: string | null;
}

/** A row the app wrote itself: an occurrence's RECURRING row, or a check-in's paycheck. */
export interface PostedEntry {
  id: string;
  kind: "recurring" | "paycheck";
  accountId: string;
  type: "EXPENSE" | "INCOME";
  date: Date;
  amount: number;
  currency: string;
  /**
   * The days an incoming row may fall on to be this row's money: the
   * occurrence's settlementWindow, or for a paycheck that of the first day of
   * the period its check-in planned (paycheckWindow).
   */
  window: { start: Date; end: Date };
  /** RECURRING only: the item it was posted from, or null once that item is gone. */
  item: MatchableItem | null;
}

export interface PostedDuplicate {
  /** The posted row the incoming one most likely is: the nearest in date among those left after the guard. */
  postedId: string;
  /** Every posted row still in the running after the guard, nearest first, one per item; more than one only when `ambiguous`. */
  candidateIds: string[];
  /** The amounts agree only after converting between currencies: a warning, never resolved on its own. */
  possible: boolean;
  /** Candidates from more than one item survive the look-alike guard, so which one it is cannot be told. */
  ambiguous: boolean;
}

/**
 * The window a paycheck's deposit may land in: the settlement window of the
 * first day of the period the check-in planned. A period's pay lands on the
 * last day of the period before, pulled back to Friday over a weekend, which
 * is the same few days before the period that let a bill due on the 1st be
 * paid from it (SETTLEMENT_LEAD_DAYS).
 */
export function paycheckWindow(plannedPeriodStart: Date): { start: Date; end: Date } {
  return settlementWindow(plannedPeriodStart);
}

/** Which series a posted row belongs to: several occurrences of one item (or several paychecks) are one series. */
function seriesOf(entry: PostedEntry): string {
  if (entry.kind === "paycheck") return "paycheck";
  return entry.item ? `item:${entry.item.id}` : `row:${entry.id}`;
}

/**
 * Pairs incoming rows with the posted rows they most likely duplicate. A
 * posted row is a candidate for an incoming one when both are on the same
 * account and go the same way (an expense against RECURRING rows, a deposit
 * against paychecks), the incoming date is inside the posted row's window,
 * and the amounts agree: in the same currency to within a cent
 * (AMOUNT_MATCH_TOLERANCE), or - only when no same-currency candidate exists -
 * in another currency to within CROSS_CURRENCY_MATCH_TOLERANCE after
 * converting the posted amount with `rates`, which makes it a possible match.
 *
 * Several candidates from different items go through the look-alike guard:
 * only the items the incoming row names survive (chargeIdentifiesItem, with
 * the category not counting for items whose category cannot tell them apart,
 * judged over every active item in `items`). If that leaves exactly one item,
 * it is that item; otherwise the items still standing (all of them, when the
 * row names none) are listed and the match is ambiguous. Within one item (weekly occurrences in one period, or
 * two periods' paychecks whose windows overlap) the nearest date wins - that
 * is which occurrence, not which bill.
 *
 * One incoming row, one posted row: rows are taken in date order, each pairs
 * with the nearest candidate still free, and an ambiguous row holds that
 * nearest one too, so two identical incoming rows and one posted row flag only
 * one of them. `incoming` is one batch; rows already in the ledger are never
 * counted against it.
 */
export function planPostedDuplicates(input: {
  incoming: readonly IncomingEntry[];
  posted: readonly PostedEntry[];
  items: readonly MatchableItem[];
  rates: RateTable;
}): Map<string, PostedDuplicate> {
  const ambiguousCategory = itemsWithAmbiguousCategory(input.items);
  const incoming = [...input.incoming].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.key.localeCompare(b.key),
  );
  const taken = new Set<string>();
  const result = new Map<string, PostedDuplicate>();

  for (const entry of incoming) {
    const eligible = input.posted.filter(
      (posted) =>
        !taken.has(posted.id) &&
        posted.accountId === entry.accountId &&
        posted.type === entry.type &&
        entry.date.getTime() >= posted.window.start.getTime() &&
        entry.date.getTime() <= posted.window.end.getTime(),
    );
    let pool = eligible.filter(
      (posted) => posted.currency === entry.currency && Math.abs(posted.amount - entry.amount) <= AMOUNT_MATCH_TOLERANCE,
    );
    const possible = pool.length === 0;
    if (possible) {
      pool = eligible.filter((posted) => {
        if (posted.currency === entry.currency) return false;
        const converted = convert(posted.amount, posted.currency, entry.currency, input.rates);
        return converted > 0 && Math.abs(entry.amount - converted) <= CROSS_CURRENCY_MATCH_TOLERANCE * converted;
      });
    }
    if (pool.length === 0) continue;

    if (new Set(pool.map(seriesOf)).size > 1) {
      const named = pool.filter(
        (posted) => posted.item !== null && chargeIdentifiesItem(posted.item, entry, ambiguousCategory.has(posted.item.id)),
      );
      // Named items win; when the row names none of them, all stay listed.
      if (named.length > 0) pool = named;
    }

    const distance = (posted: PostedEntry) => Math.abs(posted.date.getTime() - entry.date.getTime());
    const ordered = [...pool].sort(
      (a, b) => distance(a) - distance(b) || a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id),
    );
    const seen = new Set<string>();
    const nearestPerSeries = ordered.filter((posted) => {
      const series = seriesOf(posted);
      if (seen.has(series)) return false;
      seen.add(series);
      return true;
    });
    const primary = nearestPerSeries[0];
    taken.add(primary.id);
    result.set(entry.key, {
      postedId: primary.id,
      candidateIds: nearestPerSeries.map((posted) => posted.id),
      possible,
      ambiguous: nearestPerSeries.length > 1,
    });
  }
  return result;
}
