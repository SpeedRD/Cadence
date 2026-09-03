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
 *   committed          = active SUBSCRIPTION recurring items - actual matched
 *                        transaction when found, else the item's scheduled
 *                        monthly-equivalent amount for a completed month, or
 *                        nothing (see committedStillDueThisMonth) for the month
 *                        in progress.
 *   savings/investing  = GoalContribution rows not created by recurring posting
 *                        (recurringItemId null - i.e. manually logged) + active
 *                        CONTRIBUTION recurring items (actual-or-scheduled, same
 *                        rule as committed) + actual EXPENSE transactions
 *                        categorized Savings/Investment that weren't already
 *                        matched to a recurring item. An auto-posted contribution
 *                        occurrence writes both an EXPENSE Transaction and a
 *                        GoalContribution (src/lib/recurring-posting.ts); the
 *                        Transaction is what the recurring-item term matches, so
 *                        its GoalContribution twin is left out of the first term
 *                        to count that occurrence exactly once.
 *   transfers & income = never read by this module (all queries filter to EXPENSE).
 *
 * Subscription/contribution matching limitations (documented once, here):
 *   Cadence has no stored link between a RecurringItem and the Transaction that
 *   pays it, so matching is heuristic: same currency, amount within one cent,
 *   and either the same category as the recurring item or a note containing the
 *   item's normalized name. A transaction can satisfy at most one recurring
 *   item. A real charge logged under a different category with no matching note
 *   text, or a recurring item whose configured amount has drifted from the real
 *   charge, will not be matched - it falls back to the recurring item's
 *   scheduled amount for completed months (never fabricated for the current,
 *   in-progress month). Only currently-active recurring items are considered,
 *   since Cadence does not keep a history of when an item was paused.
 */
import { convert } from "@/lib/currency";
import { minDate } from "@/lib/date";
import { num, round2, sum } from "@/lib/money";
import { daysElapsedInMonth, monthForDate, monthWindow, previousMonth, type MonthRef, type MonthWindow } from "@/lib/month";
import { prisma } from "@/lib/prisma";
import { monthlyEquivalent } from "@/lib/recurring";

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

/**
 * Matches recurring items (subscriptions or contributions) to actual expense
 * transactions in the same set, so a real charge and its recurring item are
 * never both counted. See the module doc comment for the matching rule and its
 * limitations. Each transaction satisfies at most one item; items are matched
 * in the order given.
 */
export function matchRecurringToTransactions(
  items: RecurringForMatch[],
  transactions: MatchableTransaction[],
): RecurringMatchResult {
  const matchedTransactionIds = new Set<string>();
  const actualNativeByItemId = new Map<string, number>();

  for (const item of items) {
    const normalizedName = normalizeForMatch(item.name);
    const match = transactions.find((tx) => {
      if (matchedTransactionIds.has(tx.id)) return false;
      if (tx.currency !== item.currency) return false;
      if (Math.abs(tx.amount - item.amount) > AMOUNT_MATCH_TOLERANCE) return false;
      const categoryMatches = item.categoryId !== null && tx.categoryId === item.categoryId;
      const nameMatches =
        normalizedName.length > 0 &&
        Boolean(tx.note) &&
        normalizeForMatch(tx.note as string).includes(normalizedName);
      return categoryMatches || nameMatches;
    });
    if (match) {
      matchedTransactionIds.add(match.id);
      actualNativeByItemId.set(item.id, (actualNativeByItemId.get(item.id) ?? 0) + match.amount);
    }
  }

  return { matchedTransactionIds, actualNativeByItemId };
}

async function loadActiveRecurringForMatch(): Promise<RecurringForMatch[]> {
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
    },
  });
  return items.map((item) => ({ ...item, amount: num(item.amount) }));
}

async function loadCategoryMeta(): Promise<CategoryMeta[]> {
  return prisma.category.findMany({
    select: { id: true, name: true, color: true, isSavingsDefault: true },
  });
}

/** The earliest date Cadence has any recorded financial activity for. */
async function getFirstActivityDate(): Promise<Date | null> {
  const [txMin, goalMin] = await Promise.all([
    prisma.transaction.aggregate({ _min: { date: true } }),
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
  matchedSubscriptionItemIds: Set<string>;
  matchedContributionItemIds: Set<string>;
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
  recurringItems: RecurringForMatch[],
  categories: CategoryMeta[],
): Promise<MonthActuals> {
  const rangeEnd = minDate(window.end, throughDate);
  const [transactions, goalContributions] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "EXPENSE", date: { gte: window.start, lte: rangeEnd } },
      select: { id: true, amount: true, currency: true, categoryId: true, note: true },
    }),
    // Auto-posted contributions (recurringItemId set) are already represented
    // by their EXPENSE Transaction via the recurring-item term; only manually
    // logged rows are summed here. See the module doc comment.
    prisma.goalContribution.findMany({
      where: { date: { gte: window.start, lte: rangeEnd }, recurringItemId: null },
      select: { amount: true, currency: true },
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

  const subscriptionItems = recurringItems.filter((item) => item.kind === "SUBSCRIPTION");
  const contributionItems = recurringItems.filter((item) => item.kind === "CONTRIBUTION");

  const subscriptionMatch = matchRecurringToTransactions(subscriptionItems, matchable);
  const remaining = matchable.filter((tx) => !subscriptionMatch.matchedTransactionIds.has(tx.id));
  const contributionMatch = matchRecurringToTransactions(contributionItems, remaining);

  let committedActual = 0;
  for (const item of subscriptionItems) {
    const native = subscriptionMatch.actualNativeByItemId.get(item.id);
    if (native !== undefined) committedActual += toDisplay(native, item.currency);
  }

  let contributionActual = 0;
  for (const item of contributionItems) {
    const native = contributionMatch.actualNativeByItemId.get(item.id);
    if (native !== undefined) contributionActual += toDisplay(native, item.currency);
  }

  const matchedTransactionIds = new Set([
    ...subscriptionMatch.matchedTransactionIds,
    ...contributionMatch.matchedTransactionIds,
  ]);
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  let lifestyle = 0;
  let savingsFromCategory = 0;
  const lifestyleByCategoryMap = new Map<string | null, { name: string; color: string; total: number }>();

  for (const tx of matchable) {
    if (matchedTransactionIds.has(tx.id)) continue;
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

  const goalContributionTotal = sum(
    goalContributions.map((contribution) => toDisplay(num(contribution.amount), contribution.currency)),
  );

  return {
    lifestyle,
    lifestyleByCategory,
    committedActual,
    contributionActual,
    savingsFromCategory,
    goalContributionTotal,
    matchedSubscriptionItemIds: new Set(subscriptionMatch.actualNativeByItemId.keys()),
    matchedContributionItemIds: new Set(contributionMatch.actualNativeByItemId.keys()),
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
  recurringItems: RecurringForMatch[],
  categories: CategoryMeta[],
): Promise<MonthlyBreakdown> {
  const actuals = await computeMonthActuals(window, window.end, context, recurringItems, categories);
  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);

  let committed = actuals.committedActual;
  for (const item of recurringItems) {
    if (item.kind !== "SUBSCRIPTION") continue;
    if (actuals.matchedSubscriptionItemIds.has(item.id)) continue;
    committed += toDisplay(monthlyEquivalent(item.amount, item.frequency), item.currency);
  }

  let savingsInvesting = actuals.contributionActual + actuals.savingsFromCategory + actuals.goalContributionTotal;
  for (const item of recurringItems) {
    if (item.kind !== "CONTRIBUTION") continue;
    if (actuals.matchedContributionItemIds.has(item.id)) continue;
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

  let committedStillDueThisMonth = 0;
  for (const item of recurringItems) {
    if (item.kind !== "SUBSCRIPTION") continue;
    if (actuals.matchedSubscriptionItemIds.has(item.id)) continue;
    if (item.nextDate.getTime() > context.today.getTime() && item.nextDate.getTime() <= window.end.getTime()) {
      committedStillDueThisMonth += toDisplay(item.amount, item.currency);
    }
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
