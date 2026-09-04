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
 *   committed          = SUBSCRIPTION charges - every RECURRING transaction the
 *                        posting job wrote for one, plus, only for a month with
 *                        no such charge, the item's scheduled monthly-equivalent
 *                        amount (nothing at all for the month in progress; see
 *                        committedStillDueThisMonth).
 *   savings/investing  = GoalContribution rows with no Transaction standing in
 *                        for them + CONTRIBUTION charges (same actual-or-
 *                        scheduled rule as committed) + EXPENSE transactions
 *                        categorized Savings/Investment that nothing else
 *                        already accounted for.
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
 *      once, whether or not the item behind them still exists.
 *   2. Anything else is heuristic, because Cadence has no link between an item
 *      and a charge it did not write itself: same currency, amount within one
 *      cent, and either the item's category or its name in the note. See
 *      matchRecurringToTransactions for what that deliberately refuses to match.
 *
 * A real charge logged under a different category with no matching note text,
 * or an item whose configured amount has drifted from the real charge, will not
 * be matched by step 2 - the month then falls back to the item's scheduled
 * amount, and only for months the item already existed in. Only currently
 * active items are considered for that fallback, since Cadence does not keep a
 * history of when an item was paused.
 */
import { convert } from "@/lib/currency";
import { addDays, minDate } from "@/lib/date";
import { num, round2, sum } from "@/lib/money";
import { daysElapsedInMonth, monthForDate, monthWindow, previousMonth, type MonthRef, type MonthWindow } from "@/lib/month";
import { prisma } from "@/lib/prisma";
import { monthlyEquivalent, owedOccurrences } from "@/lib/recurring";

import type { AppContext } from "@/lib/data/context";
import type { CategoryLine } from "@/lib/data/period-summary";
import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

export const MIN_HISTORICAL_MONTHS = 3;
export const MAX_HISTORICAL_MONTHS = 6;

/** Amounts within a cent of each other are treated as the same charge. */
const AMOUNT_MATCH_TOLERANCE = 0.01;

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
  createdAt: Date;
}

interface MatchableTransaction {
  id: string;
  amount: number;
  currency: string;
  categoryId: string | null;
  note: string | null;
}

export interface RecurringMatchResult {
  matchedTransactionIds: Set<string>;
  actualNativeByItemId: Map<string, number>;
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Currency, amount and category: everything a category-only match can see. */
function shapeKey(item: RecurringForMatch): string {
  return `${item.currency}|${item.amount.toFixed(2)}|${item.categoryId ?? ""}`;
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
 */
export function matchRecurringToTransactions(
  items: RecurringForMatch[],
  transactions: MatchableTransaction[],
): RecurringMatchResult {
  const matchedTransactionIds = new Set<string>();
  const actualNativeByItemId = new Map<string, number>();

  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const shapeCounts = new Map<string, number>();
  for (const item of ordered) {
    const key = shapeKey(item);
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
  }

  for (const item of ordered) {
    const normalizedName = normalizeForMatch(item.name);
    const categoryIsAmbiguous = (shapeCounts.get(shapeKey(item)) ?? 0) > 1;

    for (const tx of transactions) {
      if (matchedTransactionIds.has(tx.id)) continue;
      if (tx.currency !== item.currency) continue;
      if (Math.abs(tx.amount - item.amount) > AMOUNT_MATCH_TOLERANCE) continue;
      const nameMatches =
        normalizedName.length > 0 &&
        Boolean(tx.note) &&
        normalizeForMatch(tx.note as string).includes(normalizedName);
      const categoryMatches =
        item.categoryId !== null && tx.categoryId === item.categoryId && !categoryIsAmbiguous;
      if (!nameMatches && !categoryMatches) continue;

      matchedTransactionIds.add(tx.id);
      actualNativeByItemId.set(item.id, (actualNativeByItemId.get(item.id) ?? 0) + tx.amount);
    }
  }

  return { matchedTransactionIds, actualNativeByItemId };
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

async function loadActiveRecurringForMatch(): Promise<RecurringForMonth[]> {
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
      createdAt: true,
    },
  });
  return items.map((item) => ({ ...item, amount: num(item.amount) }));
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
async function getFirstActivityDate(): Promise<Date | null> {
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
 * Pure boundary logic for getCompletedMonthWindows, kept separate so it can be
 * unit-tested without a database: given "now" and the month of the first
 * recorded activity (or null if there is none at all), returns up to
 * `maxCount` completed months, oldest first, ending the month before
 * `currentMonth`. Never includes `currentMonth` itself, and never reaches
 * further back than `firstActivityMonth` - no fake zero-history months before
 * the user started using Cadence.
 */
export function computeCompletedMonthWindows(
  currentMonth: MonthRef,
  firstActivityMonth: MonthRef | null,
  maxCount = MAX_HISTORICAL_MONTHS,
): MonthWindow[] {
  if (!firstActivityMonth) return [];

  const firstActivityWindow = monthWindow(firstActivityMonth);
  let cursor: MonthRef = previousMonth(currentMonth);
  const windows: MonthWindow[] = [];

  for (let i = 0; i < maxCount; i += 1) {
    const window = monthWindow(cursor);
    if (window.start.getTime() < firstActivityWindow.start.getTime()) break;
    windows.unshift(window);
    cursor = previousMonth(cursor);
  }
  return windows;
}

/**
 * Up to `maxCount` completed calendar months, oldest first, ending the month
 * before the current one. See computeCompletedMonthWindows for the boundary
 * rules - this just wires it up to the real first-activity date and "today".
 */
export async function getCompletedMonthWindows(
  context: AppContext,
  maxCount = MAX_HISTORICAL_MONTHS,
): Promise<MonthWindow[]> {
  const firstActivity = await getFirstActivityDate();
  if (!firstActivity) return [];
  return computeCompletedMonthWindows(monthForDate(context.today), monthForDate(firstActivity), maxCount);
}

interface MonthActuals {
  lifestyle: number;
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
 */
async function computeMonthActuals(
  window: MonthWindow,
  throughDate: Date,
  context: AppContext,
  recurringItems: RecurringForMonth[],
  categories: CategoryMeta[],
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

  const matchable: MatchableTransaction[] = transactions.map((tx) => ({
    id: tx.id,
    amount: num(tx.amount),
    currency: tx.currency,
    categoryId: tx.categoryId,
    note: tx.note,
  }));
  const itemById = new Map(recurringItems.map((item) => [item.id, item]));

  // An auto-posted occurrence is one event written as two rows. The pairing key
  // both rows carry survives anything that can happen to the RecurringItem
  // afterwards - editing its amount, pausing it, deleting it - which is exactly
  // what reading the item's current fields did not.
  const postedExternalIds = new Set(
    transactions
      .filter((tx) => tx.source === "RECURRING" && tx.externalId !== null)
      .map((tx) => tx.externalId as string),
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
    if (tx.source !== "RECURRING" || tx.externalId === null) continue;
    const itemId = recurringItemIdFromExternalId(tx.externalId);
    const item = itemId ? itemById.get(itemId) : undefined;
    // A contribution is known by its GoalContribution twin first and by the
    // item's kind second, so an occurrence stays savings even after the item
    // behind it is gone.
    const isContribution =
      pairedContributionKeys.has(tx.externalId) || item?.kind === "CONTRIBUTION";
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
  const unposted = matchable.filter((tx) => !postedTransactionIds.has(tx.id));
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
    ...subscriptionMatch.matchedTransactionIds,
    ...contributionMatch.matchedTransactionIds,
  ]);
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  let lifestyle = 0;
  let savingsFromCategory = 0;
  const lifestyleByCategoryMap = new Map<string | null, { name: string; color: string; total: number }>();

  for (const tx of matchable) {
    if (accountedForIds.has(tx.id)) continue;
    const category = tx.categoryId ? categoryById.get(tx.categoryId) : undefined;
    const amount = toDisplay(tx.amount, tx.currency);
    if (category?.isSavingsDefault) {
      savingsFromCategory += amount;
      continue;
    }
    lifestyle += amount;
    const key = tx.categoryId;
    const existing = lifestyleByCategoryMap.get(key) ?? {
      name: category?.name ?? "Uncategorized",
      color: category?.color ?? "#7a8590",
      total: 0,
    };
    existing.total += amount;
    lifestyleByCategoryMap.set(key, existing);
  }

  const lifestyleByCategory: CategoryLine[] = [...lifestyleByCategoryMap.entries()]
    .map(([categoryId, value]) => ({
      categoryId,
      name: value.name,
      color: value.color,
      spent: round2(value.total),
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
  const actuals = await computeMonthActuals(window, window.end, context, recurringItems, categories);
  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);

  // An item cannot have cost anything in a month that ended before it existed,
  // so its scheduled amount must not stand in for one. Without this a new
  // subscription rewrote every month of history behind it.
  const existedIn = (item: RecurringForMonth) =>
    item.createdAt.getTime() <= window.end.getTime();

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

  const [recurringItems, categories] = await Promise.all([loadActiveRecurringForMatch(), loadCategoryMeta()]);
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
  lifestyleSpentSoFar: number;
  projectedLifestyle: number;
  committedSpentSoFar: number;
  committedStillDueThisMonth: number;
  projectedNormalSpending: number;
  savingsInvestingSoFar: number;
}

/**
 * The month in progress: actual spending so far, projected out to the full
 * month using days-elapsed / days-in-month, plus committed subscription
 * charges still ahead this month. Savings/investing is never projected - only
 * what has actually happened so far (see module doc comment).
 */
export async function getCurrentMonthPace(context: AppContext): Promise<MonthlyPace> {
  const window = monthForDate(context.today);
  const daysElapsed = daysElapsedInMonth(context.today, window);

  const [recurringItems, categories] = await Promise.all([loadActiveRecurringForMatch(), loadCategoryMeta()]);
  const actuals = await computeMonthActuals(window, context.today, context, recurringItems, categories);
  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);

  const projectedLifestyle = round2((actuals.lifestyle / Math.max(daysElapsed, 1)) * window.totalDays);

  // Every occurrence still ahead this month, not just the next one: a weekly
  // subscription owes the rest of its month, and an item that has already been
  // charged once keeps whatever it owes after that. Occurrences already posted
  // are behind nextDate and so are never counted twice.
  const stillDueFrom = addDays(context.today, 1);
  let committedStillDueThisMonth = 0;
  for (const item of recurringItems) {
    if (item.kind !== "SUBSCRIPTION") continue;
    const occurrences = owedOccurrences(item, stillDueFrom, window.end);
    // owedOccurrences also reports an outstanding date behind the window, which
    // is right for "what is owed" but not here: if the item has already been
    // charged this month, that charge is in committedSpentSoFar and the
    // outstanding occurrence it settled would be counted a second time. Only
    // that one occurrence is dropped - everything still ahead stays.
    const stillDue = actuals.actualSubscriptionItemIds.has(item.id)
      ? occurrences.filter((due) => due.getTime() >= stillDueFrom.getTime())
      : occurrences;
    committedStillDueThisMonth += stillDue.length * toDisplay(item.amount, item.currency);
  }
  committedStillDueThisMonth = round2(committedStillDueThisMonth);

  const committedSpentSoFar = round2(actuals.committedActual);
  const savingsInvestingSoFar = round2(
    actuals.contributionActual + actuals.savingsFromCategory + actuals.goalContributionTotal,
  );

  return {
    window,
    daysElapsed,
    lifestyleSpentSoFar: round2(actuals.lifestyle),
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
