/**
 * Monthly spending pace: a calendar-month view of spending that sits alongside
 * (never replaces) the pay-period budgets in src/lib/data/period-summary.ts.
 *
 * Core ideas, kept as separate named steps so each is independently testable:
 *   - completed month windows  -> getCompletedMonthWindows
 *   - matching/dedup           -> matchRecurringToTransactions
 *   - one month's breakdown    -> computeMonthActuals / classifyCompletedMonth
 *   - historical average       -> getHistoricalMonthlyAverage
 *   - current-month projection -> getCurrentMonthPace
 *   - the two combined         -> getMonthlyPace (what the dashboard card renders)
 *
 * Classification rules (see AGENTS.md for the full spec):
 *   lifestyle          = EXPENSE transactions, not Savings/Investment category,
 *                        not matched to a subscription/contribution recurring item.
 *                        For a completed month, also not a one-off the user
 *                        confirmed extraordinary (Transaction.isExtraordinary),
 *                        and a shared expense counts only the user's own part
 *                        (Transaction.yourShare): the historical average is
 *                        typical spending only. The month in progress is
 *                        projected from that same typical spending; what it
 *                        leaves out (a one-off in full, other people's part of
 *                        a shared expense) is reported apart as setAsideSoFar,
 *                        never extrapolated and never compared with the average.
 *   committed          = SUBSCRIPTION charges - every RECURRING transaction the
 *                        posting job wrote for one, plus, only for a month with
 *                        no such charge, the item's scheduled monthly-equivalent
 *                        amount, from the month of its first occurrence on (see
 *                        firstOccurrenceOf) and never for the month in progress
 *                        (see committedStillDueThisMonth).
 *   savings/investing  = GoalContribution rows with no Transaction standing in
 *                        for them + CONTRIBUTION charges (same actual-or-
 *                        scheduled rule as committed) + EXPENSE transactions
 *                        categorized Savings/Investment that nothing else
 *                        already accounted for. A hand-logged contribution's
 *                        own Transaction (source MANUAL, externalId
 *                        "goal-contribution:<id>") is never read as spending:
 *                        its GoalContribution already counts the money.
 *   transfers & income = never read by this module (all queries filter to EXPENSE).
 *
 * How a charge is recognised, in order:
 *
 *   1. A transaction the posting job wrote carries "<itemId>:<YYYY-MM-DD>" in
 *      externalId, and the GoalContribution posted beside it carries the same
 *      key. That pairing is read first and is the reliable half of this module:
 *      it holds however the RecurringItem is edited, paused or deleted
 *      afterwards, because none of that can change a key already written. It
 *      also means an auto-posted contribution's two rows are one event, counted
 *      once, whether or not the item behind them still exists. A charge the
 *      user entered that posting settled an occurrence with (RecurringSettlement)
 *      carries the same key through its settlement and is read the same way.
 *   2. Anything else is heuristic, because Cadence has no link between an item
 *      and a charge it did not write itself: same currency, amount within one
 *      cent, and either the item's category or its name in the note. See
 *      matchRecurringToTransactions for what that deliberately refuses to match.
 *
 * A real charge logged under a different category with no matching note text,
 * or an item whose configured amount has drifted from the real charge, will not
 * be matched by step 2 - the month then falls back to the item's scheduled
 * amount, and only for months from the item's first occurrence on. Only currently
 * active items are considered for that fallback, since Cadence does not keep a
 * history of when an item was paused.
 */
import { convert } from "@/lib/currency";
import { appTimeZone, civilDateInZone, minDate, startOfDay } from "@/lib/date";
import { num, round2, sum } from "@/lib/money";
import { daysElapsedInMonth, monthForDate, monthWindow, nextMonth, previousMonth, type MonthRef, type MonthWindow } from "@/lib/month";
import { prisma } from "@/lib/prisma";
import { nextPeriod, periodForDate, periodInfo } from "@/lib/period";
import { outstanding, outstandingAmount, sumOccurrences } from "@/lib/period-commitments";
import { monthlyEquivalent } from "@/lib/recurring";
import { chargeMatchesItem, itemsWithAmbiguousCategory } from "@/lib/recurring-settlement";
import { ownShare } from "@/lib/shared-expense";
import { MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import { loadCommitments } from "@/lib/data/period-commitments";
import type { CategoryLine } from "@/lib/data/period-summary";
import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

export const MIN_HISTORICAL_MONTHS = 3;
export const MAX_HISTORICAL_MONTHS = 6;

/**
 * The month of the first recorded activity is a full month of history only when
 * that activity starts on or before this day of it (day 7 leaves at least 24 of
 * the month's 28-31 days covered). Later than that, the month is a partial one
 * - a first expense on Jun 25 says nothing about what June costs - and the
 * average starts at the next month instead (see firstUsableMonth).
 */
export const FIRST_MONTH_MAX_START_DAY = 7;

/** "On pace" band: within 2% of the average, or $1-equivalent, whichever is larger. */
const ON_PACE_TOLERANCE_RATIO = 0.02;
const ON_PACE_TOLERANCE_MIN = 1;

interface CategoryMeta {
  id: string;
  name: string;
  color: string;
  isSavingsDefault: boolean;
}

export interface RecurringForMatch {
  id: string;
  name: string;
  amount: number;
  currency: string;
  categoryId: string | null;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  nextDate: Date;
}

/** A recurring item with the extra schedule/history fields month maths needs. */
export interface RecurringForMonth extends RecurringForMatch {
  anchorDay: number | null;
  secondAnchorDay: number | null;
  createdAt: Date;
  /** The date of the earliest RECURRING row posting wrote for the item, or null if it has posted none. */
  firstPostedDate: Date | null;
}

type ActiveRecurringItem = Omit<RecurringForMonth, "firstPostedDate">;

/**
 * When an item's first occurrence fell: the earliest RECURRING row posting wrote
 * for it, else its nextDate, which is the first occurrence for as long as
 * nothing has posted (a posted item's nextDate has moved on, so the earlier of
 * the two is the row). Until then the item owes nothing to a month, so its
 * scheduled amount must not stand in for one.
 */
function firstOccurrenceOf(item: RecurringForMonth): Date {
  return item.firstPostedDate ? minDate(item.firstPostedDate, item.nextDate) : item.nextDate;
}

interface MatchableTransaction {
  id: string;
  amount: number;
  currency: string;
  categoryId: string | null;
  note: string | null;
}

/** MatchableTransaction plus the user's one-off flag and share, for the classification loop. */
interface ClassifiableTransaction extends MatchableTransaction {
  isExtraordinary: boolean;
  /** The user's own part of a shared expense's amount, or null (see src/lib/shared-expense.ts). */
  yourShare: number | null;
}

export interface RecurringMatchResult {
  matchedTransactionIds: Set<string>;
  actualNativeByItemId: Map<string, number>;
  /** How many transactions each item matched - one per occurrence it can answer for. */
  matchedCountByItemId: Map<string, number>;
}

/**
 * Matches recurring items (subscriptions or contributions) to actual expense
 * transactions in the same set, so a real charge and its recurring item are
 * never both counted. See the module doc comment for the matching rule and its
 * limitations. A transaction satisfies at most one item.
 *
 * Three things this is careful about:
 *
 *   - An item takes *every* transaction it matches, not just the first. A
 *     weekly subscription charged four times in a month is four charges of that
 *     item, and counting one left the other three to be read as lifestyle
 *     spending and then projected.
 *   - Items are matched in id order, never in the order the database happened
 *     to return them, so which of two candidates wins a contested transaction
 *     is stable between requests.
 *   - When two items share a currency, an amount and a category, those three
 *     cannot tell them apart, so for both of them a category match alone is not
 *     enough and the item's name must appear in the note. Without that, a $50
 *     doctor's visit filed under Health could satisfy a $50 gym membership.
 *
 * The per-pair predicate is chargeMatchesItem (src/lib/recurring-settlement.ts),
 * the one recurring posting and the payday check-in settle occurrences with.
 */
export function matchRecurringToTransactions(
  items: RecurringForMatch[],
  transactions: MatchableTransaction[],
): RecurringMatchResult {
  const matchedTransactionIds = new Set<string>();
  const actualNativeByItemId = new Map<string, number>();
  const matchedCountByItemId = new Map<string, number>();

  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const ambiguous = itemsWithAmbiguousCategory(ordered);

  for (const item of ordered) {
    for (const tx of transactions) {
      if (matchedTransactionIds.has(tx.id)) continue;
      if (!chargeMatchesItem(item, tx, ambiguous.has(item.id))) continue;

      matchedTransactionIds.add(tx.id);
      actualNativeByItemId.set(item.id, (actualNativeByItemId.get(item.id) ?? 0) + tx.amount);
      matchedCountByItemId.set(item.id, (matchedCountByItemId.get(item.id) ?? 0) + 1);
    }
  }

  return { matchedTransactionIds, actualNativeByItemId, matchedCountByItemId };
}

/**
 * The RecurringItem id encoded in a RECURRING transaction's externalId
 * ("<itemId>:<YYYY-MM-DD>", see recurringExternalId). Splitting on the last
 * colon is safe: the date part never contains one and cuid ids never do.
 */
export function recurringItemIdFromExternalId(externalId: string): string | null {
  const separator = externalId.lastIndexOf(":");
  return separator > 0 ? externalId.slice(0, separator) : null;
}

async function loadActiveRecurringForMatch(): Promise<ActiveRecurringItem[]> {
  const items = await prisma.recurringItem.findMany({
    where: { active: true, kind: { in: ["SUBSCRIPTION", "CONTRIBUTION"] } },
    select: {
      id: true,
      name: true,
      amount: true,
      currency: true,
      categoryId: true,
      kind: true,
      frequency: true,
      nextDate: true,
      anchorDay: true,
      secondAnchorDay: true,
      createdAt: true,
    },
  });
  return items.map((item) => ({ ...item, amount: num(item.amount) }));
}

/** The same items with the date of the first RECURRING row posted for each (see firstOccurrenceOf). */
async function withFirstPostedDates(items: ActiveRecurringItem[]): Promise<RecurringForMonth[]> {
  if (items.length === 0) return [];
  const rows = await prisma.transaction.findMany({
    where: {
      source: "RECURRING",
      OR: items.map((item) => ({ externalId: { startsWith: `${item.id}:` } })),
    },
    select: { externalId: true, date: true },
  });
  const earliest = new Map<string, Date>();
  for (const row of rows) {
    const itemId = row.externalId ? recurringItemIdFromExternalId(row.externalId) : null;
    if (!itemId) continue;
    const seen = earliest.get(itemId);
    if (!seen || row.date.getTime() < seen.getTime()) earliest.set(itemId, row.date);
  }
  return items.map((item) => ({ ...item, firstPostedDate: earliest.get(item.id) ?? null }));
}

async function loadCategoryMeta(): Promise<CategoryMeta[]> {
  return prisma.category.findMany({
    select: { id: true, name: true, color: true, isSavingsDefault: true },
  });
}

/**
 * The earliest date Cadence has any recorded financial *activity* for.
 *
 * Only cashflow counts. An OPENING_BALANCE dated "as of" some date long before
 * the user started using Cadence is a starting position, not a month of
 * spending, and letting it in opened months of fabricated history: every one of
 * them scored zero lifestyle spending while still collecting each recurring
 * item's scheduled amount, which both deflated the lifestyle average and
 * inflated the committed one.
 */
export async function getFirstActivityDate(): Promise<Date | null> {
  const [txMin, goalMin] = await Promise.all([
    prisma.transaction.aggregate({
      _min: { date: true },
      where: { type: { in: ["EXPENSE", "INCOME"] } },
    }),
    prisma.goalContribution.aggregate({ _min: { date: true } }),
  ]);
  const dates = [txMin._min.date, goalMin._min.date].filter((d): d is Date => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((earliest, date) => (date.getTime() < earliest.getTime() ? date : earliest));
}

/**
 * The first month that counts as a full month of history for a first activity
 * on `firstActivity`: its own month when the activity starts on or before
 * FIRST_MONTH_MAX_START_DAY, the next month otherwise. Feeds
 * computeCompletedMonthWindows as its `firstActivityMonth`.
 */
export function firstUsableMonth(firstActivity: Date): MonthRef {
  const day = startOfDay(firstActivity);
  const own = monthForDate(day);
  return day.getUTCDate() <= FIRST_MONTH_MAX_START_DAY ? own : nextMonth(own);
}

/**
 * Pure boundary logic for getCompletedMonthWindows, kept separate so it can be
 * unit-tested without a database: given "now" and the month of the first
 * recorded activity (or null if there is none at all), returns up to
 * `maxCount` completed months, oldest first, ending the month before
 * `currentMonth`. Never includes `currentMonth` itself, and never reaches
 * further back than `firstActivityMonth` - no fake zero-history months before
 * the user started using Cadence.
 *
 * `incomeHistoryStartMonth` (Settings' "count income history from", already
 * bounding comparableHistory and getCategorySuggestions the same way) is a
 * second, independent lower bound of the same kind, not a parallel mechanism:
 * the walk stops at whichever of the two boundaries is later (more
 * restrictive), using the exact same break condition below. Null (the
 * default) leaves the walk exactly as it was before this parameter existed.
 * A boundary that leaves fewer than MIN_HISTORICAL_MONTHS is not special-cased
 * here - getHistoricalMonthlyAverage's existing "not enough history" rule
 * already covers it, honestly, the same way a brand-new account's own
 * firstActivityMonth does.
 */
export function computeCompletedMonthWindows(
  currentMonth: MonthRef,
  firstActivityMonth: MonthRef | null,
  maxCount = MAX_HISTORICAL_MONTHS,
  incomeHistoryStartMonth: MonthRef | null = null,
): MonthWindow[] {
  if (!firstActivityMonth) return [];

  const firstActivityWindow = monthWindow(firstActivityMonth);
  const incomeHistoryWindow = incomeHistoryStartMonth ? monthWindow(incomeHistoryStartMonth) : null;
  const earliestWindow =
    incomeHistoryWindow && incomeHistoryWindow.start.getTime() > firstActivityWindow.start.getTime()
      ? incomeHistoryWindow
      : firstActivityWindow;
  let cursor: MonthRef = previousMonth(currentMonth);
  const windows: MonthWindow[] = [];

  for (let i = 0; i < maxCount; i += 1) {
    const window = monthWindow(cursor);
    if (window.start.getTime() < earliestWindow.start.getTime()) break;
    windows.unshift(window);
    cursor = previousMonth(cursor);
  }
  return windows;
}

/**
 * Up to `maxCount` completed calendar months, oldest first, ending the month
 * before the current one. See computeCompletedMonthWindows for the boundary
 * rules - this just wires it up to the real first-activity date (through
 * firstUsableMonth, so a partial first month is not a month of history),
 * "today", and (converted to a month the same way every other date here is)
 * Settings' incomeHistoryStartDate.
 */
export async function getCompletedMonthWindows(
  context: AppContext,
  maxCount = MAX_HISTORICAL_MONTHS,
): Promise<MonthWindow[]> {
  const firstActivity = await getFirstActivityDate();
  if (!firstActivity) return [];
  return computeCompletedMonthWindows(
    monthForDate(context.today),
    firstUsableMonth(firstActivity),
    maxCount,
    context.incomeHistoryStartDate ? monthForDate(context.incomeHistoryStartDate) : null,
  );
}

interface MonthActuals {
  lifestyle: number;
  /** The part of `lifestyle` that is typical spending: one-offs left out, shared expenses at the user's share. */
  typicalLifestyle: number;
  lifestyleByCategory: CategoryLine[];
  committedActual: number;
  contributionActual: number;
  savingsFromCategory: number;
  goalContributionTotal: number;
  /** Items with at least one real charge in the window, so no scheduled amount may stand in for them. */
  actualSubscriptionItemIds: Set<string>;
  actualContributionItemIds: Set<string>;
}

/**
 * Everything actually logged in `window`, from its start through `throughDate`
 * (inclusive). Used both for a fully completed month (throughDate = window.end)
 * and for "so far this month" (throughDate = today) - the only difference
 * between historical and current-month figures is how the caller fills the gap
 * between "actual" and "scheduled" (see classifyCompletedMonth vs
 * getCurrentMonthPace).
 *
 * `typicalOnly` reads a completed month as what it usually costs, so it feeds
 * the historical average with typical spending only: transactions the user
 * confirmed as one-offs (Transaction.isExtraordinary, see
 * src/lib/extraordinary.ts) are left out, and a shared expense counts the
 * user's own part rather than the whole amount (Transaction.yourShare, see
 * src/lib/shared-expense.ts). The month in progress keeps both as they are in
 * `lifestyle`: "spent so far" is a statement of fact about what left the
 * accounts. Its `typicalLifestyle` is the same read as typicalOnly, which is
 * what getCurrentMonthPace projects.
 */
async function computeMonthActuals(
  window: MonthWindow,
  throughDate: Date,
  context: AppContext,
  recurringItems: RecurringForMatch[],
  categories: CategoryMeta[],
  typicalOnly = false,
): Promise<MonthActuals> {
  const rangeEnd = minDate(window.end, throughDate);
  const [transactions, goalContributions] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "EXPENSE", date: { gte: window.start, lte: rangeEnd } },
      select: {
        id: true,
        amount: true,
        currency: true,
        categoryId: true,
        note: true,
        source: true,
        externalId: true,
        isExtraordinary: true,
        yourShare: true,
        recurringSettlement: { select: { occurrenceKey: true, kind: true } },
      },
    }),
    // Every contribution in the window; which of them are already represented
    // by a Transaction is decided below, by pairing keys rather than by the
    // recurringItemId foreign key (see the module doc comment).
    prisma.goalContribution.findMany({
      where: { date: { gte: window.start, lte: rangeEnd } },
      select: { amount: true, currency: true, recurringExternalId: true },
    }),
  ]);

  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);

  const matchable: ClassifiableTransaction[] = transactions.map((tx) => ({
    id: tx.id,
    amount: num(tx.amount),
    currency: tx.currency,
    categoryId: tx.categoryId,
    note: tx.note,
    isExtraordinary: tx.isExtraordinary,
    yourShare: tx.yourShare === null ? null : num(tx.yourShare),
  }));
  const itemById = new Map(recurringItems.map((item) => [item.id, item]));

  // A hand-logged contribution that moved money is one event as two rows: the
  // GoalContribution, counted below in goalContributionTotal, and the MANUAL
  // Transaction it wrote (see manualContributionExternalId). The Transaction is
  // set aside here so it is neither lifestyle spending nor a heuristic match
  // for some CONTRIBUTION item that happens to share its amount.
  const manualContributionTwinIds = new Set(
    transactions
      .filter(
        (tx) =>
          tx.source === "MANUAL" &&
          tx.externalId !== null &&
          tx.externalId.startsWith(MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX),
      )
      .map((tx) => tx.id),
  );

  // The ledger row standing for one recurring occurrence: the RECURRING row
  // posting wrote, keyed "<itemId>:<YYYY-MM-DD>", or the charge the user
  // entered that posting settled the occurrence with instead
  // (RecurringSettlement, same key). A hand-logged contribution's own expense
  // can settle one too, but it stays the manual twin above.
  const occurrenceKeyOf = (tx: (typeof transactions)[number]): string | null => {
    if (tx.source === "RECURRING") return tx.externalId;
    if (manualContributionTwinIds.has(tx.id)) return null;
    return tx.recurringSettlement?.occurrenceKey ?? null;
  };

  // An auto-posted occurrence is one event written as two rows. The pairing key
  // both rows carry survives anything that can happen to the RecurringItem
  // afterwards - editing its amount, pausing it, deleting it - which is exactly
  // what reading the item's current fields did not.
  const postedExternalIds = new Set(
    transactions.map(occurrenceKeyOf).filter((key): key is string => key !== null),
  );
  const pairedContributionKeys = new Set(
    goalContributions
      .map((contribution) => contribution.recurringExternalId)
      .filter((key): key is string => key !== null && postedExternalIds.has(key)),
  );

  let committedActual = 0;
  let contributionActual = 0;
  const actualSubscriptionItemIds = new Set<string>();
  const actualContributionItemIds = new Set<string>();
  const postedTransactionIds = new Set<string>();

  for (const tx of transactions) {
    const key = occurrenceKeyOf(tx);
    if (key === null) continue;
    const itemId = recurringItemIdFromExternalId(key);
    const item = itemId ? itemById.get(itemId) : undefined;
    // A contribution is known by its GoalContribution twin first and by the
    // item's kind second (as recorded on a settlement, then as it is now), so
    // an occurrence stays savings even after the item behind it is gone.
    const isContribution =
      pairedContributionKeys.has(key) ||
      tx.recurringSettlement?.kind === "CONTRIBUTION" ||
      item?.kind === "CONTRIBUTION";
    const amount = toDisplay(num(tx.amount), tx.currency);

    if (isContribution) {
      contributionActual += amount;
      if (itemId) actualContributionItemIds.add(itemId);
    } else {
      committedActual += amount;
      if (itemId) actualSubscriptionItemIds.add(itemId);
    }
    postedTransactionIds.add(tx.id);
  }

  // Whatever posting did not already account for falls to the heuristic, which
  // is all that is available for a charge Cadence did not write itself.
  const unposted = matchable.filter(
    (tx) => !postedTransactionIds.has(tx.id) && !manualContributionTwinIds.has(tx.id),
  );
  const subscriptionItems = recurringItems.filter((item) => item.kind === "SUBSCRIPTION");
  const contributionItems = recurringItems.filter((item) => item.kind === "CONTRIBUTION");

  const subscriptionMatch = matchRecurringToTransactions(subscriptionItems, unposted);
  const remaining = unposted.filter((tx) => !subscriptionMatch.matchedTransactionIds.has(tx.id));
  const contributionMatch = matchRecurringToTransactions(contributionItems, remaining);

  for (const item of subscriptionItems) {
    const native = subscriptionMatch.actualNativeByItemId.get(item.id);
    if (native === undefined) continue;
    committedActual += toDisplay(native, item.currency);
    actualSubscriptionItemIds.add(item.id);
  }
  for (const item of contributionItems) {
    const native = contributionMatch.actualNativeByItemId.get(item.id);
    if (native === undefined) continue;
    contributionActual += toDisplay(native, item.currency);
    actualContributionItemIds.add(item.id);
  }

  const accountedForIds = new Set([
    ...postedTransactionIds,
    ...manualContributionTwinIds,
    ...subscriptionMatch.matchedTransactionIds,
    ...contributionMatch.matchedTransactionIds,
  ]);
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  let lifestyle = 0;
  let typicalLifestyle = 0;
  let savingsFromCategory = 0;
  const lifestyleByCategoryMap = new Map<
    string | null,
    { name: string; color: string; total: number; extraordinary: number; othersShare: number }
  >();

  for (const tx of matchable) {
    if (accountedForIds.has(tx.id)) continue;
    // A confirmed one-off is real spending but not typical spending: excluded
    // here, alongside the rows a recurring item already accounts for, when
    // the caller is measuring what a month usually costs.
    if (typicalOnly && tx.isExtraordinary) continue;
    const category = tx.categoryId ? categoryById.get(tx.categoryId) : undefined;
    // On the same terms, a shared expense's typical cost is the user's own
    // part; the whole amount matched the recurring items above and stays the
    // fact "spent so far" reports. ownShare() is the amount itself for every
    // row with no share, so an ordinary row is read exactly as before.
    const fullAmount = toDisplay(tx.amount, tx.currency);
    const ownCost = toDisplay(ownShare(tx), tx.currency);
    const amount = typicalOnly ? ownCost : fullAmount;
    if (category?.isSavingsDefault) {
      savingsFromCategory += amount;
      continue;
    }
    lifestyle += amount;
    if (!tx.isExtraordinary) typicalLifestyle += ownCost;
    const key = tx.categoryId;
    const existing = lifestyleByCategoryMap.get(key) ?? {
      name: category?.name ?? "Uncategorized",
      color: category?.color ?? "#7a8590",
      total: 0,
      extraordinary: 0,
      othersShare: 0,
    };
    existing.total += amount;
    if (tx.isExtraordinary) existing.extraordinary += amount;
    // Reported the way getPeriodSummary reports it: the part of the line's
    // total that is other people's money - nothing once the share has already
    // been read in the amount's place, and nothing for a one-off whose whole
    // amount is already set aside.
    else if (tx.yourShare !== null && !typicalOnly) existing.othersShare += fullAmount - ownCost;
    lifestyleByCategoryMap.set(key, existing);
  }

  const lifestyleByCategory: CategoryLine[] = [...lifestyleByCategoryMap.entries()]
    .map(([categoryId, value]) => ({
      categoryId,
      name: value.name,
      color: value.color,
      spent: round2(value.total),
      extraordinarySpent: round2(value.extraordinary),
      othersShareSpent: round2(value.othersShare),
      // RECURRING rows never reach lifestyleByCategoryMap - accountedForIds
      // (built above) skips them before this map is built - so there is
      // nothing left to exclude here.
      spentExcludingRecurring: round2(value.total),
      spentExcludingOccurrences: round2(value.total),
      budget: null,
    }))
    .sort((a, b) => b.spent - a.spent);

  // Only the contributions with no Transaction standing in for them, so an
  // auto-posted occurrence counts once however its recurring item ended up.
  const goalContributionTotal = sum(
    goalContributions
      .filter(
        (contribution) =>
          contribution.recurringExternalId === null ||
          !postedExternalIds.has(contribution.recurringExternalId),
      )
      .map((contribution) => toDisplay(num(contribution.amount), contribution.currency)),
  );

  return {
    lifestyle,
    typicalLifestyle,
    lifestyleByCategory,
    committedActual,
    contributionActual,
    savingsFromCategory,
    goalContributionTotal,
    actualSubscriptionItemIds,
    actualContributionItemIds,
  };
}

export interface MonthlyBreakdown {
  window: MonthWindow;
  lifestyle: number;
  lifestyleByCategory: CategoryLine[];
  committed: number;
  savingsInvesting: number;
  normalSpending: number;
  totalOutflow: number;
}

/**
 * A month that has fully ended: actual transactions where matched, the
 * recurring item's scheduled monthly-equivalent amount where not (see the
 * module doc comment for why this fallback is safe for a month already over).
 */
export async function classifyCompletedMonth(
  window: MonthWindow,
  context: AppContext,
  recurringItems: RecurringForMonth[],
  categories: CategoryMeta[],
): Promise<MonthlyBreakdown> {
  // Typical spending only - confirmed one-offs left out, shared expenses at
  // the user's own share: a completed month's figures exist to be averaged
  // into what a month usually costs (getHistoricalMonthlyAverage).
  const actuals = await computeMonthActuals(window, window.end, context, recurringItems, categories, true);
  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);

  // An item cannot have cost anything in a month that ended before it existed,
  // nor before its first occurrence (an installment plan created in August
  // whose first payment is October 1 owes August nothing), so its scheduled
  // amount must not stand in for one. Without this a new subscription rewrote
  // every month of history behind it.
  //
  // Created on or before the month's last day, which is to say before the start
  // of the day after it: the instant is read as the calendar day it fell on in
  // the app's timezone, so an item made during the last day (or after 8pm local
  // on it, already the next UTC day) counts for that month rather than being
  // compared with the month end at UTC midnight.
  const existedIn = (item: RecurringForMonth) =>
    civilDateInZone(item.createdAt, appTimeZone()).getTime() <= window.end.getTime() &&
    firstOccurrenceOf(item).getTime() <= window.end.getTime();

  let committed = actuals.committedActual;
  for (const item of recurringItems) {
    if (item.kind !== "SUBSCRIPTION") continue;
    if (actuals.actualSubscriptionItemIds.has(item.id)) continue;
    if (!existedIn(item)) continue;
    committed += toDisplay(monthlyEquivalent(item.amount, item.frequency), item.currency);
  }

  let savingsInvesting = actuals.contributionActual + actuals.savingsFromCategory + actuals.goalContributionTotal;
  for (const item of recurringItems) {
    if (item.kind !== "CONTRIBUTION") continue;
    if (actuals.actualContributionItemIds.has(item.id)) continue;
    if (!existedIn(item)) continue;
    savingsInvesting += toDisplay(monthlyEquivalent(item.amount, item.frequency), item.currency);
  }

  const lifestyle = round2(actuals.lifestyle);
  committed = round2(committed);
  savingsInvesting = round2(savingsInvesting);

  return {
    window,
    lifestyle,
    lifestyleByCategory: actuals.lifestyleByCategory,
    committed,
    savingsInvesting,
    normalSpending: round2(lifestyle + committed),
    totalOutflow: round2(lifestyle + committed + savingsInvesting),
  };
}

export interface HistoricalMonthlyAverage {
  sufficient: boolean;
  monthsUsed: number;
  months: MonthlyBreakdown[];
  averageLifestyle: number;
  averageCommitted: number;
  averageSavingsInvesting: number;
  averageNormalSpending: number;
  averageTotalOutflow: number;
  averageLifestyleByCategory: CategoryLine[];
}

function emptyHistoricalAverage(monthsUsed: number): HistoricalMonthlyAverage {
  return {
    sufficient: false,
    monthsUsed,
    months: [],
    averageLifestyle: 0,
    averageCommitted: 0,
    averageSavingsInvesting: 0,
    averageNormalSpending: 0,
    averageTotalOutflow: 0,
    averageLifestyleByCategory: [],
  };
}

/**
 * Average normal spending (lifestyle + committed) over up to the last six
 * completed calendar months, requiring at least MIN_HISTORICAL_MONTHS of
 * usable history. Never includes the current, in-progress month.
 */
export async function getHistoricalMonthlyAverage(context: AppContext): Promise<HistoricalMonthlyAverage> {
  const windows = await getCompletedMonthWindows(context);
  if (windows.length < MIN_HISTORICAL_MONTHS) return emptyHistoricalAverage(windows.length);

  const [activeItems, categories] = await Promise.all([loadActiveRecurringForMatch(), loadCategoryMeta()]);
  const recurringItems = await withFirstPostedDates(activeItems);
  const months = await Promise.all(
    windows.map((window) => classifyCompletedMonth(window, context, recurringItems, categories)),
  );

  const n = months.length;
  const averageLifestyle = round2(sum(months.map((m) => m.lifestyle)) / n);
  const averageCommitted = round2(sum(months.map((m) => m.committed)) / n);
  const averageSavingsInvesting = round2(sum(months.map((m) => m.savingsInvesting)) / n);

  const categoryTotals = new Map<string | null, { name: string; color: string; total: number }>();
  for (const month of months) {
    for (const line of month.lifestyleByCategory) {
      const existing = categoryTotals.get(line.categoryId) ?? { name: line.name, color: line.color, total: 0 };
      existing.total += line.spent;
      categoryTotals.set(line.categoryId, existing);
    }
  }
  const averageLifestyleByCategory: CategoryLine[] = [...categoryTotals.entries()]
    .map(([categoryId, value]) => ({
      categoryId,
      name: value.name,
      color: value.color,
      spent: round2(value.total / n),
      // Completed months already leave confirmed one-offs out and read a
      // shared expense at the user's own share (classifyCompletedMonth).
      extraordinarySpent: 0,
      othersShareSpent: 0,
      // Same as lifestyleByCategory above: RECURRING rows never reach this
      // total in the first place.
      spentExcludingRecurring: round2(value.total / n),
      spentExcludingOccurrences: round2(value.total / n),
      budget: null,
    }))
    .sort((a, b) => b.spent - a.spent);

  return {
    sufficient: true,
    monthsUsed: n,
    months,
    averageLifestyle,
    averageCommitted,
    averageSavingsInvesting,
    averageNormalSpending: round2(averageLifestyle + averageCommitted),
    averageTotalOutflow: round2(averageLifestyle + averageCommitted + averageSavingsInvesting),
    averageLifestyleByCategory,
  };
}

export interface MonthlyPace {
  window: MonthWindow;
  daysElapsed: number;
  /** Everything that left the accounts as lifestyle spending so far - one-offs and other people's shares included. */
  lifestyleSpentSoFar: number;
  /** The typical part of it (what the historical average is made of): the only part that is projected. */
  typicalLifestyleSoFar: number;
  /**
   * The rest of lifestyleSpentSoFar: confirmed one-offs in full and other
   * people's part of shared expenses. Real money already spent, but neither
   * projected nor compared with the average.
   */
  setAsideSoFar: number;
  projectedLifestyle: number;
  committedSpentSoFar: number;
  committedStillDueThisMonth: number;
  projectedNormalSpending: number;
  savingsInvestingSoFar: number;
}

/**
 * The month in progress: typical spending so far, projected out to the full
 * month using days-elapsed / days-in-month, plus committed subscription
 * charges still ahead this month. Only typical spending is projected, the
 * population the historical average is made of: a one-off or other people's
 * share of a shared expense is real money but not a daily rate, so it is
 * reported apart (setAsideSoFar). Savings/investing is never projected - only
 * what has actually happened so far (see module doc comment).
 */
export async function getCurrentMonthPace(context: AppContext): Promise<MonthlyPace> {
  const window = monthForDate(context.today);
  const daysElapsed = daysElapsedInMonth(context.today, window);

  const [recurringItems, categories] = await Promise.all([loadActiveRecurringForMatch(), loadCategoryMeta()]);
  const actuals = await computeMonthActuals(window, context.today, context, recurringItems, categories);
  const projectedLifestyle = round2((actuals.typicalLifestyle / Math.max(daysElapsed, 1)) * window.totalDays);

  // Every subscription occurrence still to leave this month: the outstanding
  // ones in the month's pay periods from today's on (src/lib/period-
  // commitments.ts) - a weekly subscription owes the rest of its month, a
  // finite plan stops at its countdown, a backlog posting will still charge
  // counts in full, and an occurrence already posted or paid by a charge the
  // user entered is in committedSpentSoFar, never here. An item posting will
  // skip charges nothing.
  const current = periodForDate(context.today);
  const monthPeriods = [current];
  if (current.period === "A") monthPeriods.push(periodInfo(nextPeriod(current)));
  const commitments = await loadCommitments(monthPeriods, context);
  const committedStillDueThisMonth = round2(
    sumOccurrences(
      monthPeriods
        .flatMap((period) => outstanding(commitments.get(period.key) ?? []))
        .filter((occurrence) => occurrence.kind === "SUBSCRIPTION"),
      context.displayCurrency,
      context.rates,
      outstandingAmount,
    ),
  );

  const committedSpentSoFar = round2(actuals.committedActual);
  const savingsInvestingSoFar = round2(
    actuals.contributionActual + actuals.savingsFromCategory + actuals.goalContributionTotal,
  );

  return {
    window,
    daysElapsed,
    lifestyleSpentSoFar: round2(actuals.lifestyle),
    typicalLifestyleSoFar: round2(actuals.typicalLifestyle),
    setAsideSoFar: round2(actuals.lifestyle - actuals.typicalLifestyle),
    projectedLifestyle,
    committedSpentSoFar,
    committedStillDueThisMonth,
    projectedNormalSpending: round2(projectedLifestyle + committedSpentSoFar + committedStillDueThisMonth),
    savingsInvestingSoFar,
  };
}

export type PaceComparison = { direction: "above" | "below" | "onPace"; amount: number };

/** Within tolerance counts as "on pace" rather than a noisy few-cents difference. */
export function compareToAverage(projected: number, average: number): PaceComparison {
  const diff = round2(projected - average);
  const tolerance = Math.max(ON_PACE_TOLERANCE_MIN, round2(average * ON_PACE_TOLERANCE_RATIO));
  if (Math.abs(diff) <= tolerance) return { direction: "onPace", amount: 0 };
  return { direction: diff > 0 ? "above" : "below", amount: Math.abs(diff) };
}

export interface MonthlyPaceCardData {
  window: MonthWindow;
  pace: MonthlyPace;
  history: HistoricalMonthlyAverage;
  comparison: PaceComparison | null;
}

/** Everything the dashboard's monthly pace card needs, in one call. */
export async function getMonthlyPace(context: AppContext): Promise<MonthlyPaceCardData> {
  const [pace, history] = await Promise.all([
    getCurrentMonthPace(context),
    getHistoricalMonthlyAverage(context),
  ]);
  const comparison = history.sufficient
    ? compareToAverage(pace.projectedNormalSpending, history.averageNormalSpending)
    : null;
  return { window: pace.window, pace, history, comparison };
}
