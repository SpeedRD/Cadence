/**
 * Assembles everything the payday check-in wizard needs to show for the
 * "current plan period" - the period a check-in opened right now would plan
 * for. See planPeriodRef() for why that isn't always context.currentPeriod.
 *
 * Every "recommended"/"suggested" figure here is always computed fresh from
 * live data. When a CONFIRMED check-in already exists for the plan period,
 * this overlays the user's previously *chosen* values (reported balances,
 * income, planned amounts) on top, so re-opening the wizard shows what was
 * actually confirmed rather than re-suggesting from scratch - but it never
 * trusts old data for the recommendations themselves. Task 7's server action
 * repeats this same recomputation before persisting, so nothing the client
 * sends is trusted as a "recommended" figure.
 */
import { getSettings } from "@/lib/auth";
import { convert, isSameMoney } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import {
  availableForFlexibleCategories,
  planAccountBuffers,
  planGoalFunding,
  scaleFlexibleSuggestions,
  type AccountBufferAccount,
  type AccountBufferSubscription,
  type GoalFundingPlan,
} from "@/lib/payday";
import {
  daysRemainingInPeriod,
  isAfterPaydayInPeriod,
  nextPeriod,
  paydayDateFor,
  periodInfo,
  periodKey,
  periodsRemaining,
  previousComparablePeriod,
  previousPeriod,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";
import type { paydayConfirmSchema } from "@/lib/validation";
import type { z } from "zod";

import { getAccountBalances } from "@/lib/data/accounts";
import { getPeriodSummary, type CommittedItem } from "@/lib/data/period-summary";
import { listGoals } from "@/lib/data/goals";
import { matchRecurringToTransactions } from "@/lib/data/monthly";

import type { AppContext } from "@/lib/data/context";

export interface PaydayAccountDraft {
  accountId: string;
  name: string;
  currency: string;
  type: string;
  expectedLedgerBalance: number;
  reportedBalance: number;
  incomeEntered: number;
  incomeNote: string;
  /** The configured buffer floor converted to this account's own currency, so the step can recompute its buffer as income is edited. */
  bufferFloor: number;
  /**
   * The account has been archived since this check-in recorded income for it.
   * Its figures still count - the money was received - but there is nothing
   * left to edit, so the wizard shows them without letting them be changed.
   */
  readOnly: boolean;
}

export interface PaydayCommittedDraft {
  recurringItemId: string;
  name: string;
  /** Everything this item owes in the plan period, in the display currency. */
  amount: number;
  /** The same total in the item's own currency - what its account has to cover. */
  nativeAmount: number;
  /** One charge in the item's own currency, for a row that owes several. */
  perOccurrenceAmount: number;
  /** How many charges the plan period owes. */
  occurrenceCount: number;
  currency: string;
  nextDate: Date;
  /** Its due date has passed and automatic posting has not cleared it. */
  overdue: boolean;
  /**
   * How many of those charges are already in the ledger from another route
   * (an approved receipt, a CSV row, a manual entry) - one charge per
   * occurrence, never more than occurrenceCount. See loggedOccurrencesByItem.
   */
  loggedOccurrences: number;
  /** What the plan still has to set aside for this item: its unlogged occurrences, in the display currency. */
  outstandingAmount: number;
  /** The same in the item's own currency - what its account still has to cover. */
  outstandingNativeAmount: number;
  /** Every owed occurrence is already logged, so the plan reserves nothing for this item. */
  alreadyLogged: boolean;
  /** The account funding this item - reassignable from Step 3, which writes RecurringItem.accountId. */
  accountId: string | null;
}

/**
 * One account a goal draws on this period, in that account's own currency.
 * A `held` row is the user's own figure - edited in Step 3, or carried over
 * from the confirmed check-in being re-opened - and stays put while the wizard
 * recomputes; an unheld row is the assembly-time recommendation, which the
 * wizard replaces with the live one as income and subscriptions change.
 */
export interface PaydayGoalFundingDraft {
  accountId: string;
  plannedAmount: number;
  held: boolean;
}

/**
 * `recommendedAmount` and `plannedAmount` are in the draft's `displayCurrency`
 * like every other row in the draft - a goal roadmap figure is a planning
 * value, not a native one, and it is summed straight into the plan totals.
 * The goal's own stored currency and amounts are untouched; only the
 * presentation is converted.
 */
export interface PaydayGoalDraft {
  goalId: string;
  name: string;
  /** The roadmap pace: what reaching the target on time asks for this period. */
  recommendedAmount: number;
  /**
   * The goal's total this period: `funding` summed into the display currency.
   * Assembled here for summarizePaydayDraft's readers (the dashboard summary
   * line, the period hero); the wizard derives it live from `funding` instead.
   */
  plannedAmount: number;
  /**
   * Where the total comes from: one row per account with room to spare after
   * its subscriptions and buffer (see planGoalFunding), each in that account's
   * own currency. Empty when no account has any room this period.
   */
  funding: PaydayGoalFundingDraft[];
  targetDate: Date;
  periodsLeft: number;
}

export type SuggestionBasis = "last_budget" | "average" | "none";

export interface PaydayCategoryDraft {
  categoryId: string;
  name: string;
  color: string;
  suggestedAmount: number;
  plannedAmount: number;
  basis: SuggestionBasis;
}

export type CarryoverBasis = "prior_period_budget" | "no_prior_budget";

export interface PaydayCheckinDraft {
  periodRef: PeriodRef;
  periodLabel: string;
  isEditingConfirmed: boolean;
  checkinId: string | null;
  displayCurrency: string;
  accounts: PaydayAccountDraft[];
  subscriptions: PaydayCommittedDraft[];
  contributions: PaydayCommittedDraft[];
  subscriptionsTotal: number;
  contributionsTotal: number;
  goals: PaydayGoalDraft[];
  essentialCategories: PaydayCategoryDraft[];
  flexibleCategories: PaydayCategoryDraft[];
  /** Settings.bufferPercent, so Step 3 recomputes each account's buffer live as income is edited. */
  bufferPercent: number;
  /**
   * Every income account's own suggested buffer summed into displayCurrency.
   * Computed, never chosen: Step 3 shows one recommendation per account and
   * confirming writes one BUFFER allocation per account, with this sum landing
   * in PaydayCheckin.protectedBuffer for everything that reads a single figure.
   */
  plannedBuffer: number;
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  /** Days left in the plan period counting today, for the safe-to-spend-per-day estimate in Step 4 - the full period length when opened exactly on a payday (the period hasn't started yet), fewer when opened partway through an already-current period. */
  daysRemainingInPlanPeriod: number;
}

/**
 * The period a check-in opened right now plans for: the *next* period once the
 * current period's pay has landed, otherwise the period containing today
 * (covers opening the wizard a few days into an already-current period).
 *
 * "Once the pay has landed" is a stretch of days, not a single date. A boundary
 * falling on a weekend is paid on the preceding Friday, so on the Saturday and
 * Sunday after it the money is already in hand while the ending period still
 * contains today. Testing for the payday alone sent those days back to planning
 * the period that was ending - and confirming there rewrites the paycheck that
 * period's check-in had already recorded.
 */
export function planPeriodRef(context: AppContext): PeriodRef {
  return isAfterPaydayInPeriod(context.today)
    ? nextPeriod(context.currentPeriod)
    : context.currentPeriod;
}

/**
 * How many comparable (same-half) periods the planner averages over. Shared
 * with the Afford calculator (src/lib/data/afford.ts), which projects a
 * future period's income and commitments with this same walk.
 */
export const HISTORY_PERIODS = 6;

/** Exported so Task 7's server action can recompute the exact same suggestions before persisting - never trusting a client-sent "recommended" figure. */
export async function getCategorySuggestions(
  planRef: PeriodRef,
  categories: { id: string }[],
  context: AppContext,
): Promise<Map<string, { amount: number; basis: SuggestionBasis }>> {
  const result = new Map<string, { amount: number; basis: SuggestionBasis }>();
  if (categories.length === 0) return result;
  const categoryIds = categories.map((c) => c.id);

  // Comparable, not merely prior: last month's same half (1st-15th vs.
  // 16th-end), never the opposite half of the month that a single
  // previousPeriod() step would land on.
  const comparableRef = previousComparablePeriod(planRef);
  const lastBudgets = await prisma.budget.findMany({
    where: {
      year: comparableRef.year,
      month: comparableRef.month,
      period: comparableRef.period,
      categoryId: { in: categoryIds },
    },
  });
  const lastBudgetByCategory = new Map(
    lastBudgets
      .filter((budget) => budget.categoryId && num(budget.amount) > 0)
      .map((budget) => [
        budget.categoryId as string,
        round2(
          convert(num(budget.amount), budget.currency, context.displayCurrency, context.rates),
        ),
      ]),
  );

  const remaining = categoryIds.filter((id) => !lastBudgetByCategory.has(id));
  const historicalTotals = new Map<string, number>();
  // How many of the comparable periods to average over: the ones from a
  // category's oldest recorded spending forward. Dividing by the full lookback
  // treated every period before the category existed as a zero-spend month and
  // pulled the suggestion down towards nothing.
  const historicalPeriodCount = new Map<string, number>();
  if (remaining.length > 0) {
    // HISTORY_PERIODS comparable (same-half) periods, starting at
    // comparableRef and stepping one full cycle back each time, fetched in
    // parallel instead of sequentially - each getPeriodSummary() call is an
    // independent DB round-trip, and the dashboard calls this unconditionally
    // on every load.
    const cursors: PeriodRef[] = [];
    let cursor = comparableRef;
    for (let i = 0; i < HISTORY_PERIODS; i += 1) {
      cursors.push(cursor);
      cursor = previousComparablePeriod(cursor);
    }
    const summaries = await Promise.all(
      cursors.map((ref) => getPeriodSummary(periodInfo(ref), context)),
    );
    // `summaries` runs newest first, so the oldest period with any spending is
    // the furthest index the average should reach back to.
    summaries.forEach((summary, index) => {
      for (const line of summary.categories) {
        if (!line.categoryId || !remaining.includes(line.categoryId)) continue;
        historicalTotals.set(line.categoryId, (historicalTotals.get(line.categoryId) ?? 0) + line.spent);
        if (line.spent > 0) {
          historicalPeriodCount.set(line.categoryId, index + 1);
        }
      }
    });
  }

  for (const id of categoryIds) {
    const fromBudget = lastBudgetByCategory.get(id);
    if (fromBudget !== undefined) {
      result.set(id, { amount: fromBudget, basis: "last_budget" });
    } else if (historicalPeriodCount.has(id)) {
      const periods = historicalPeriodCount.get(id) ?? HISTORY_PERIODS;
      result.set(id, { amount: round2((historicalTotals.get(id) ?? 0) / periods), basis: "average" });
    } else {
      result.set(id, { amount: 0, basis: "none" });
    }
  }
  return result;
}

/**
 * The immediately preceding pay period's own unspent budget - never all
 * account balances, and never fabricated when that period had no budget to
 * measure against. Clamped at 0: an overspent prior period carries nothing
 * forward rather than compounding a deficit into the new plan.
 */
/**
 * A goal's roadmap pace for the plan period, in the display currency: what
 * reaching the target by its date asks for, spread over the pay periods left
 * counted from the plan period's start, net of the recurring contributions
 * already due to it this period. Independent of any account's room - it is
 * the bar a goal is "on track" or "behind" against, never lowered by what the
 * accounts can currently fund.
 */
export function goalRoadmapAmount(
  goal: { displayRemaining: number; targetDate: Date },
  planStart: Date,
  dueContribution: number,
): number {
  const periodsLeft = Math.max(1, periodsRemaining(planStart, goal.targetDate));
  return round2(Math.max(0, goal.displayRemaining / periodsLeft - dueContribution));
}

/** The recurring contributions due to each goal in the period, in the display currency. */
function dueContributionsByGoal(committedItems: CommittedItem[]): Map<string, number> {
  const byGoal = new Map<string, number>();
  for (const item of committedItems) {
    if (item.kind !== "CONTRIBUTION" || !item.goalId) continue;
    byGoal.set(item.goalId, (byGoal.get(item.goalId) ?? 0) + item.amount);
  }
  return byGoal;
}

/**
 * goalRoadmapAmount() for one goal from live data - the same figure the
 * check-in draft and confirm compute for it - so the goal page measures a
 * confirmed plan against the real pace rather than against whatever the
 * accounts' room let the plan schedule. Null for a goal with no target date
 * or none left to save.
 */
export async function getGoalRoadmapAmount(
  goalId: string,
  planRef: PeriodRef,
  context: AppContext,
): Promise<number | null> {
  const plan = periodInfo(planRef);
  const [goals, planSummary] = await Promise.all([listGoals(context), getPeriodSummary(plan, context)]);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal || !goal.targetDate || goal.achievedAt || goal.remaining <= 0) return null;
  return goalRoadmapAmount(
    { displayRemaining: goal.displayRemaining, targetDate: goal.targetDate },
    plan.start,
    dueContributionsByGoal(planSummary.committedItems).get(goal.id) ?? 0,
  );
}

export async function getAvailableCarryover(
  planRef: PeriodRef,
  context: AppContext,
): Promise<{ amount: number; basis: CarryoverBasis }> {
  const prevSummary = await getPeriodSummary(periodInfo(previousPeriod(planRef)), context);
  if (!prevSummary.hasBudget) return { amount: 0, basis: "no_prior_budget" };
  return { amount: round2(Math.max(0, prevSummary.safeToSpend)), basis: "prior_period_budget" };
}

/**
 * An account's ledger balance with this check-in's own income taken back out,
 * so "expected" means the same thing on a first confirm and on a re-confirm.
 * Only a snapshot that actually created an income Transaction has anything to
 * subtract.
 */
function ledgerBefore(
  balance: number,
  snapshot:
    | { incomeEntered: { toString(): string } | number; incomeTransactionId: string | null }
    | undefined
    | null,
): number {
  if (!snapshot?.incomeTransactionId) return round2(balance);
  return round2(balance - num(snapshot.incomeEntered));
}

/**
 * How many of each committed item's owed occurrences in the plan period are
 * already in the ledger from another route, so the plan does not reserve money
 * for a charge that has already gone out.
 *
 * The rule is the posting job's (the `consumed` set in
 * src/lib/recurring-posting.ts): one logged charge answers for exactly one
 * occurrence, never for a whole item. A weekly item with two charges still
 * ahead and one payment in the ledger has one occurrence covered and one still
 * owed. Every candidate here lies inside the one plan period - the same window
 * that job judges each occurrence over - so consuming reduces to a count: the
 * item's matched charges, capped at the occurrences it still owes. The owed
 * count is getPeriodSummary's, from the same owedOccurrences() walk the
 * committed figure and the Afford calculator use; nothing is re-enumerated.
 *
 * `matchedCountByItemId` must come from candidates that exclude RECURRING
 * rows: those are the posting job's own output for occurrences it has already
 * rolled past, not payments of the ones still ahead, and counting one would
 * cancel a charge that is genuinely still due.
 */
export function loggedOccurrencesByItem(
  items: readonly Pick<CommittedItem, "id" | "occurrenceCount">[],
  matchedCountByItemId: ReadonlyMap<string, number>,
): Map<string, number> {
  const logged = new Map<string, number>();
  for (const item of items) {
    const matched = matchedCountByItemId.get(item.id) ?? 0;
    logged.set(item.id, Math.max(0, Math.min(matched, item.occurrenceCount)));
  }
  return logged;
}

function toCommittedDraft(item: CommittedItem, loggedByItem: ReadonlyMap<string, number>): PaydayCommittedDraft {
  const loggedOccurrences = loggedByItem.get(item.id) ?? 0;
  const outstanding = Math.max(0, item.occurrenceCount - loggedOccurrences);
  return {
    recurringItemId: item.id,
    name: item.name,
    amount: item.amount,
    nativeAmount: item.nativeAmount,
    perOccurrenceAmount: item.perOccurrenceAmount,
    occurrenceCount: item.occurrenceCount,
    currency: item.currency,
    nextDate: item.nextDate,
    overdue: item.overdue,
    loggedOccurrences,
    // item.amount is the display total for every owed occurrence; scale it
    // rather than re-converting so a fully outstanding item keeps the exact
    // figure the committed list shows.
    outstandingAmount:
      item.occurrenceCount > 0 ? round2((item.amount * outstanding) / item.occurrenceCount) : 0,
    outstandingNativeAmount: round2(item.perOccurrenceAmount * outstanding),
    alreadyLogged: outstanding === 0,
    accountId: item.accountId,
  };
}

/** The draft rows Step 3's per-account buffer view is computed from, in the shape planAccountBuffers() takes. */
function bufferInputs(
  accounts: PaydayAccountDraft[],
  subscriptions: PaydayCommittedDraft[],
): { accounts: AccountBufferAccount[]; subscriptions: AccountBufferSubscription[] } {
  return {
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      name: account.name,
      currency: account.currency,
      income: account.incomeEntered,
      bufferFloor: account.bufferFloor,
    })),
    subscriptions: subscriptions.map((item) => ({
      recurringItemId: item.recurringItemId,
      accountId: item.accountId,
      // Only the occurrences not yet in the ledger count against the account.
      nativeAmount: item.outstandingNativeAmount,
      currency: item.currency,
      alreadyLogged: item.alreadyLogged,
    })),
  };
}

/** A confirmed check-in's GOAL allocation, as getPaydayCheckinDraft reads it back. */
interface ConfirmedGoalAllocation {
  accountId: string | null;
  plannedAmount: unknown;
  currency: string;
}

/**
 * The funding rows a goal opens with. A fresh check-in follows the
 * recommendation. Re-opening a confirmed one carries what was confirmed: each
 * account's own row, converted into the account's currency in case it was
 * written in another, and 0 for an account with room now that had no row then
 * - so the total the user sees is the total they confirmed, all of it held.
 * A check-in confirmed before goal funding was per-account has a single
 * accountless row in the display currency of its day; its total is spread over
 * today's rows in proportion to their room, uncapped so the total survives the
 * upgrade, and held for the same reason.
 *
 * Only accounts with room now get a row (plan.draws) - an account the confirmed
 * check-in drew on that has none today is not offered, exactly as it would not
 * be on a fresh check-in.
 */
function seedGoalFunding(
  plan: GoalFundingPlan,
  confirmed: ConfirmedGoalAllocation[],
  displayCurrency: string,
  rates: AppContext["rates"],
): PaydayGoalFundingDraft[] {
  if (confirmed.length === 0) {
    return plan.draws.map((draw) => ({
      accountId: draw.accountId,
      plannedAmount: draw.recommendedAmount,
      held: false,
    }));
  }
  const perAccount = confirmed.filter((row) => row.accountId !== null);
  if (perAccount.length > 0) {
    const confirmedByAccount = new Map(perAccount.map((row) => [row.accountId as string, row]));
    return plan.draws.map((draw) => {
      const row = confirmedByAccount.get(draw.accountId);
      return {
        accountId: draw.accountId,
        plannedAmount: row ? round2(convert(num(row.plannedAmount as never), row.currency, draw.currency, rates)) : 0,
        held: true,
      };
    });
  }
  if (plan.draws.length === 0) return [];
  const total = round2(
    confirmed.reduce(
      (sum, row) => sum + convert(num(row.plannedAmount as never), row.currency, displayCurrency, rates),
      0,
    ),
  );
  // Shares are 0 for every row only when earlier goals used up all the room;
  // then the legacy total is spread evenly rather than dropped.
  const shareTotal = plan.draws.reduce((sum, draw) => sum + draw.share, 0);
  const shares = plan.draws.map((draw) => (shareTotal > 0 ? draw.share / shareTotal : 1 / plan.draws.length));
  const largest = shares.reduce((best, share, index) => (share > shares[best] ? index : best), 0);
  const displayAmounts = shares.map((share) => round2(total * share));
  const others = displayAmounts.reduce((sum, value, index) => (index === largest ? sum : sum + value), 0);
  displayAmounts[largest] = round2(total - others);
  return plan.draws.map((draw, index) => ({
    accountId: draw.accountId,
    plannedAmount: round2(convert(displayAmounts[index], displayCurrency, draw.currency, rates)),
    held: true,
  }));
}

/**
 * The wizard's data for one pay period. Without a target this is the period
 * a check-in opened right now plans for (planPeriodRef) - the dashboard's
 * payday prompt. With one, any period: the Budgets page opens the same wizard
 * for whichever period is being viewed, so a period that was never checked in
 * can be done late and a past one can be revisited.
 */
export async function getPaydayCheckinDraft(
  context: AppContext,
  target?: PeriodRef,
): Promise<PaydayCheckinDraft> {
  const planRef = target ?? planPeriodRef(context);
  const plan = periodInfo(planRef);

  const [
    accounts,
    planSummary,
    allGoals,
    essentialCategoryRows,
    flexibleCategoryRows,
    carryover,
    settings,
    existing,
    recurringForMatchRows,
    plannedPeriodExpenses,
    existingBudgetRows,
  ] = await Promise.all([
    // Every account, not only the active ones: a check-in that recorded income
    // for an account archived since must keep showing it, or that income
    // silently vanishes from the plan's totals.
    getAccountBalances(context, { status: "ALL" }),
    getPeriodSummary(plan, context),
    listGoals(context),
    prisma.category.findMany({
      where: { kind: "EXPENSE", isEssentialFixed: true, isSubscriptionDefault: false, isSavingsDefault: false },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({
      where: { kind: "EXPENSE", isEssentialFixed: false, isSubscriptionDefault: false, isSavingsDefault: false },
      orderBy: { name: "asc" },
    }),
    getAvailableCarryover(planRef, context),
    getSettings(),
    prisma.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
      include: { snapshots: true, allocations: true },
    }),
    prisma.recurringItem.findMany({
      where: {
        active: true,
        kind: { in: ["SUBSCRIPTION", "CONTRIBUTION"] },
        // No lower bound: an overdue item is still owed and still appears in
        // the plan's committed list, so it needs an already-paid verdict too.
        nextDate: { lte: plan.end },
      },
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
    }),
    // Charges that could be an owed occurrence already paid through another
    // route. RECURRING rows are excluded: they are posting's own output for
    // occurrences already rolled past - see loggedOccurrencesByItem.
    prisma.transaction.findMany({
      where: { type: "EXPENSE", source: { not: "RECURRING" }, date: { gte: plan.start, lte: plan.end } },
      select: { id: true, amount: true, currency: true, categoryId: true, note: true },
    }),
    prisma.budget.findMany({
      where: { year: planRef.year, month: planRef.month, period: planRef.period, categoryId: { not: null } },
    }),
  ]);

  const forMatch = recurringForMatchRows.map((item) => ({ ...item, amount: num(item.amount) }));
  const matchableExpenses = plannedPeriodExpenses.map((tx) => ({
    id: tx.id,
    amount: num(tx.amount),
    currency: tx.currency,
    categoryId: tx.categoryId,
    note: tx.note,
  }));
  const { matchedCountByItemId } = matchRecurringToTransactions(forMatch, matchableExpenses);
  const loggedByItem = loggedOccurrencesByItem(planSummary.committedItems, matchedCountByItemId);

  // Category budgets already saved for the plan period - set by hand on the
  // Budgets page, copied forward, or written by an earlier confirmation and
  // edited since - seed the planned amounts, so confirming never silently
  // overwrites a budget the user can already see. The confirmed check-in's
  // allocation is the fallback, then the fresh suggestion; the suggestion
  // itself is always recomputed and shown separately.
  const existingBudgetByCategory = new Map(
    existingBudgetRows
      .filter((budget) => budget.categoryId)
      .map((budget) => [
        budget.categoryId as string,
        round2(convert(num(budget.amount), budget.currency, context.displayCurrency, context.rates)),
      ]),
  );

  const existingSnapshotByAccount = new Map((existing?.snapshots ?? []).map((s) => [s.accountId, s]));
  const existingAllocationByKey = new Map(
    (existing?.allocations ?? []).map((a) => [
      `${a.type}:${a.categoryId ?? a.goalId ?? a.recurringItemId ?? ""}`,
      a,
    ]),
  );
  // A goal's GOAL rows, all of them: one per account it drew on, or the single
  // accountless row of a check-in confirmed before funding was per-account.
  const existingGoalAllocations = new Map<string, ConfirmedGoalAllocation[]>();
  for (const allocation of existing?.allocations ?? []) {
    if (allocation.type !== "GOAL" || !allocation.goalId) continue;
    existingGoalAllocations.set(allocation.goalId, [
      ...(existingGoalAllocations.get(allocation.goalId) ?? []),
      allocation,
    ]);
  }

  // Active accounts are always offered; an archived one appears only when this
  // check-in already recorded something for it, and then read-only.
  const draftableAccounts = accounts.filter(
    (account) => account.status === "ACTIVE" || existingSnapshotByAccount.has(account.id),
  );
  const accountDrafts: PaydayAccountDraft[] = draftableAccounts.map((account) => {
    const snapshot = existingSnapshotByAccount.get(account.id);
    return {
      readOnly: account.status !== "ACTIVE",
      accountId: account.id,
      name: account.name,
      currency: account.currency,
      type: account.type,
      // The ledger balance to reconcile against is the one *before* this
      // check-in's own income landed. Re-opening a confirmed check-in would
      // otherwise compare the reported balance against a ledger that already
      // contains the paycheck this very screen is recording, so the same
      // reported figure read as a match on the first pass and as a shortfall
      // on the second.
      expectedLedgerBalance: ledgerBefore(account.balance, snapshot),
      reportedBalance: snapshot ? num(snapshot.reportedBalance) : ledgerBefore(account.balance, snapshot),
      incomeEntered: snapshot ? num(snapshot.incomeEntered) : 0,
      incomeNote: snapshot?.incomeNote ?? "",
      // Each account's buffer is computed in its own currency, so the floor
      // has to be converted once per account rather than to the display
      // currency and then compared across currencies.
      bufferFloor: round2(
        convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, account.currency, context.rates),
      ),
    };
  });
  const totalIncome = round2(
    accountDrafts.reduce(
      (sum, a) => sum + convert(a.incomeEntered, a.currency, context.displayCurrency, context.rates),
      0,
    ),
  );

  const subscriptions = planSummary.committedItems
    .filter((i) => i.kind === "SUBSCRIPTION")
    .map((item) => toCommittedDraft(item, loggedByItem));
  const contributions = planSummary.committedItems
    .filter((i) => i.kind === "CONTRIBUTION")
    .map((item) => toCommittedDraft(item, loggedByItem));
  // Per occurrence, not per item: an item with one charge already logged and
  // another still ahead reserves the one still ahead.
  const subscriptionsTotal = round2(subscriptions.reduce((sum, i) => sum + i.outstandingAmount, 0));
  const contributionsTotal = round2(contributions.reduce((sum, i) => sum + i.outstandingAmount, 0));

  // A goal already fed by a recurring contribution this period does not also
  // need its full roadmap amount set aside: reserving both put the same goal in
  // the plan twice and shrank what was left for the flexible categories.
  const dueContributionByGoal = dueContributionsByGoal(planSummary.committedItems);

  // The buffer is a recommendation per income account, not a stored choice, so
  // it is always recomputed from the income in this draft - never read back
  // from the confirmed check-in's BUFFER allocations. Goal funding below draws
  // on the headroom this leaves each account.
  const bufferInput = bufferInputs(accountDrafts, subscriptions);
  const bufferPlan = planAccountBuffers(bufferInput.accounts, bufferInput.subscriptions, {
    bufferPercent: settings.bufferPercent,
    displayCurrency: context.displayCurrency,
    rates: context.rates,
  });
  const plannedBuffer = bufferPlan.total;

  const roadmapGoals = allGoals
    .filter((g) => g.targetDate && !g.achievedAt && g.remaining > 0)
    .map((g) => {
      // listGoals()'s perPeriod/periodsLeft are anchored to context.today (right
      // for the goals page's "time until target" display), but the payday
      // planner reserves money for the PLAN period, which can be tomorrow's
      // period rather than today's (see planPeriodRef()) - so recompute here
      // anchored to plan.start instead of trusting the pre-computed fields.
      const periodsLeft = Math.max(1, periodsRemaining(plan.start, g.targetDate as Date));
      const recommendedAmount = goalRoadmapAmount(
        { displayRemaining: g.displayRemaining, targetDate: g.targetDate as Date },
        plan.start,
        dueContributionByGoal.get(g.id) ?? 0,
      );
      return { goal: g, periodsLeft, recommendedAmount };
    });
  // Which accounts each goal's roadmap amount is recommended to come from,
  // goals in this order sharing one pool of headroom (see planGoalFunding).
  const fundingPlanByGoal = new Map(
    planGoalFunding(
      roadmapGoals.map((entry) => ({ goalId: entry.goal.id, amount: entry.recommendedAmount })),
      bufferPlan.accounts,
      { displayCurrency: context.displayCurrency, rates: context.rates },
    ).map((fundingPlan) => [fundingPlan.goalId, fundingPlan]),
  );
  const accountCurrencyById = new Map(accountDrafts.map((account) => [account.accountId, account.currency]));
  const goals: PaydayGoalDraft[] = roadmapGoals.map(({ goal: g, periodsLeft, recommendedAmount }) => {
    const funding = seedGoalFunding(
      fundingPlanByGoal.get(g.id)!,
      existingGoalAllocations.get(g.id) ?? [],
      context.displayCurrency,
      context.rates,
    );
    return {
      goalId: g.id,
      name: g.name,
      recommendedAmount,
      plannedAmount: round2(
        funding.reduce(
          (sum, row) =>
            sum + convert(row.plannedAmount, accountCurrencyById.get(row.accountId)!, context.displayCurrency, context.rates),
          0,
        ),
      ),
      funding,
      targetDate: g.targetDate as Date,
      periodsLeft,
    };
  });
  const goalPlanTotal = round2(goals.reduce((sum, g) => sum + g.plannedAmount, 0));

  const suggestionsByCategory = await getCategorySuggestions(
    planRef,
    [...essentialCategoryRows, ...flexibleCategoryRows],
    context,
  );
  const essentialCategories: PaydayCategoryDraft[] = essentialCategoryRows.map((category) => {
    const suggestion = suggestionsByCategory.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`ESSENTIAL_CATEGORY:${category.id}`);
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: suggestion.amount,
      plannedAmount:
        existingBudgetByCategory.get(category.id) ??
        (existingAlloc
          ? round2(convert(num(existingAlloc.plannedAmount), existingAlloc.currency, context.displayCurrency, context.rates))
          : suggestion.amount),
      basis: suggestion.basis,
    };
  });
  const essentialFixedTotal = round2(essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0));

  const includedCarryover = existing
    ? round2(convert(num(existing.includedCarryover), existing.currency, context.displayCurrency, context.rates))
    : settings.carryoverIncludedByDefault
      ? carryover.amount
      : 0;

  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: plannedBuffer,
  });
  const scaled = scaleFlexibleSuggestions(
    flexibleCategoryRows.map((c) => ({ id: c.id, suggested: suggestionsByCategory.get(c.id)?.amount ?? 0 })),
    available,
  );
  const scaledById = new Map(scaled.map((s) => [s.id, s.scaled]));
  const flexibleCategories: PaydayCategoryDraft[] = flexibleCategoryRows.map((category) => {
    const suggestion = suggestionsByCategory.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`FLEXIBLE_CATEGORY:${category.id}`);
    const scaledAmount = scaledById.get(category.id) ?? 0;
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: scaledAmount,
      plannedAmount:
        existingBudgetByCategory.get(category.id) ??
        (existingAlloc
          ? round2(convert(num(existingAlloc.plannedAmount), existingAlloc.currency, context.displayCurrency, context.rates))
          : scaledAmount),
      basis: suggestion.basis,
    };
  });

  return {
    periodRef: planRef,
    periodLabel: plan.longLabel,
    isEditingConfirmed: Boolean(existing),
    checkinId: existing?.id ?? null,
    displayCurrency: context.displayCurrency,
    accounts: accountDrafts,
    subscriptions,
    contributions,
    subscriptionsTotal,
    contributionsTotal,
    goals,
    essentialCategories,
    flexibleCategories,
    bufferPercent: settings.bufferPercent,
    plannedBuffer,
    availableCarryover: carryover.amount,
    carryoverBasis: carryover.basis,
    includedCarryover,
    daysRemainingInPlanPeriod: daysRemainingInPeriod(context.today, plan),
  };
}

/**
 * AppContext plus the buffer-planning settings confirmPaydayCheckin needs
 * (bufferPercent/bufferFloorAmount/bufferFloorCurrency). AppContext itself
 * intentionally omits these - they're not needed by most pages. Kept as
 * explicit inputs (rather than confirmPaydayCheckin calling getSettings()
 * itself) so the function's only dependencies are its two parameters, both
 * directly constructible by a caller with no request scope (e.g. Task 14's
 * scripts/verify-domain.ts). The server action wrapper builds this by
 * spreading the AppContext it already has with fields off the same
 * `settings` row it fetches for locale/dictionary purposes.
 */
export interface ConfirmPaydayCheckinContext extends AppContext {
  bufferPercent: number;
  bufferFloorAmount: number;
  bufferFloorCurrency: string;
}

/**
 * What the server measured when it refused to confirm, so the wizard can put
 * the right acknowledgement in front of the user instead of asking for a
 * reload. The client works from the rates it rendered with; a refresh between
 * render and submit can move `available` across zero, and the checkbox the
 * server is waiting for is then one the client never drew.
 */
export interface PaydayAcknowledgementState {
  available: number;
  needsDeficitAck: boolean;
  needsZeroBufferAck: boolean;
}

export type ConfirmPaydayCheckinResult =
  | { ok: true }
  | { ok: false; reason: "no_active_accounts" }
  | {
      ok: false;
      reason: "deficit_not_acknowledged" | "zero_buffer_not_acknowledged";
      acknowledgements: PaydayAcknowledgementState;
    };

export type ConfirmPaydayCheckinInput = z.infer<typeof paydayConfirmSchema>;

/**
 * Confirms one pay period's payday check-in atomically: reconciled income
 * transactions, balance snapshots, the check-in row itself, plan-allocation
 * audit rows, and the essential/flexible category Budget rows. Never creates
 * actual expense transactions or GoalContribution rows - see the financial
 * integrity rules in this plan's Global Constraints. Every "recommended"
 * figure is recomputed here from live data; only the user's edited "planned"
 * values are trusted from the client payload.
 *
 * Plain function (no "use server", no requireAuth()/cookies()) so it's
 * directly callable from a bare Node/tsx script as well as from the
 * "use server" action wrapper in src/server/actions/payday.ts - see that
 * file for the auth/form-parsing/localized-message layer around this.
 */
/**
 * The date a check-in created now is stamped with. The period the dashboard
 * prompt plans for gets today, the day the user is actually checking in. Any
 * other period reached through the Budgets page is a late check-in: its
 * paycheck should sit in the ledger on the day that pay landed, not on the
 * day the user got round to it, so it gets the period's own payday when that
 * is already past (a period checked in ahead of its payday still gets today).
 */
export function checkinDateForNewCheckin(planRef: PeriodRef, context: AppContext): Date {
  if (periodKey(planRef) === periodKey(planPeriodRef(context))) return context.today;
  const payday = paydayDateFor(planRef);
  return payday.getTime() < context.today.getTime() ? payday : context.today;
}

export async function confirmPaydayCheckin(
  input: ConfirmPaydayCheckinInput,
  context: ConfirmPaydayCheckinContext,
): Promise<ConfirmPaydayCheckinResult> {
  const planRef: PeriodRef = { year: input.year, month: input.month, period: input.period };
  const plan = periodInfo(planRef);

  const [
    liveAccounts,
    planSummary,
    allGoals,
    essentialCategories,
    flexibleCategories,
    carryover,
    recurringForMatchRows,
    plannedPeriodExpenses,
    existingCheckinSnapshots,
  ] = await Promise.all([
    getAccountBalances(context, { status: "ALL" }),
    getPeriodSummary(plan, context),
    listGoals(context),
    prisma.category.findMany({
      where: { kind: "EXPENSE", isEssentialFixed: true, isSubscriptionDefault: false, isSavingsDefault: false },
    }),
    prisma.category.findMany({
      where: { kind: "EXPENSE", isEssentialFixed: false, isSubscriptionDefault: false, isSavingsDefault: false },
    }),
    getAvailableCarryover(planRef, context),
    prisma.recurringItem.findMany({
      where: {
        active: true,
        kind: { in: ["SUBSCRIPTION", "CONTRIBUTION"] },
        // No lower bound: an overdue item is still owed and still appears in
        // the plan's committed list, so it needs an already-paid verdict too.
        nextDate: { lte: plan.end },
      },
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
    }),
    // Charges that could be an owed occurrence already paid through another
    // route. RECURRING rows are excluded: they are posting's own output for
    // occurrences already rolled past - see loggedOccurrencesByItem.
    prisma.transaction.findMany({
      where: { type: "EXPENSE", source: { not: "RECURRING" }, date: { gte: plan.start, lte: plan.end } },
      select: { id: true, amount: true, currency: true, categoryId: true, note: true },
    }),
    // Read before the write so income already recorded for an account archived
    // since can be carried into the totals rather than dropped.
    prisma.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
      select: { snapshots: { select: { accountId: true, incomeEntered: true, currency: true } } },
    }),
  ]);
  // Only an active account can be edited; the rest are carried as they stand.
  const liveAccountById = new Map(
    liveAccounts.filter((a) => a.status === "ACTIVE").map((a) => [a.id, a]),
  );
  const essentialById = new Map(essentialCategories.map((c) => [c.id, c]));
  const flexibleById = new Map(flexibleCategories.map((c) => [c.id, c]));
  // One combined call over both category lists, same as getPaydayCheckinDraft
  // above - not two separate calls that each redo the shared prior-period
  // budget lookup and history lookback.
  const suggestionsByCategory = await getCategorySuggestions(
    planRef,
    [...essentialCategories, ...flexibleCategories],
    context,
  );

  const accountInputs = input.accounts.filter((a) => liveAccountById.has(a.accountId));
  if (accountInputs.length === 0) return { ok: false, reason: "no_active_accounts" };

  // Income recorded against an account that has since been archived. Its
  // snapshot is left untouched below, so the figure it holds has to keep
  // counting here too or re-confirming would quietly write it out of the plan.
  const archivedIncome = (existingCheckinSnapshots?.snapshots ?? [])
    .filter((snapshot) => !liveAccountById.has(snapshot.accountId))
    .reduce(
      (sum, snapshot) =>
        sum + convert(num(snapshot.incomeEntered), snapshot.currency, context.displayCurrency, context.rates),
      0,
    );
  const totalIncome = round2(
    accountInputs.reduce((sum, a) => {
      const account = liveAccountById.get(a.accountId)!;
      return sum + convert(a.incomeEntered, account.currency, context.displayCurrency, context.rates);
    }, archivedIncome),
  );

  const forMatch = recurringForMatchRows.map((item) => ({ ...item, amount: num(item.amount) }));
  const matchableExpenses = plannedPeriodExpenses.map((tx) => ({
    id: tx.id,
    amount: num(tx.amount),
    currency: tx.currency,
    categoryId: tx.categoryId,
    note: tx.note,
  }));
  const { matchedCountByItemId } = matchRecurringToTransactions(forMatch, matchableExpenses);
  const loggedByItem = loggedOccurrencesByItem(planSummary.committedItems, matchedCountByItemId);

  // The same per-occurrence accounting the draft showed, recomputed here from
  // live data rather than trusted from the client.
  const subscriptionItems = planSummary.committedItems.filter((i) => i.kind === "SUBSCRIPTION");
  const contributionItems = planSummary.committedItems.filter((i) => i.kind === "CONTRIBUTION");
  const subscriptionDrafts = subscriptionItems.map((item) => toCommittedDraft(item, loggedByItem));
  const contributionDrafts = contributionItems.map((item) => toCommittedDraft(item, loggedByItem));
  const subscriptionsTotal = round2(subscriptionDrafts.reduce((sum, i) => sum + i.outstandingAmount, 0));
  const contributionsTotal = round2(contributionDrafts.reduce((sum, i) => sum + i.outstandingAmount, 0));

  const goalById = new Map(allGoals.map((g) => [g.id, g]));
  const goalInputs = input.goals.filter((g) => {
    const goal = goalById.get(g.goalId);
    return Boolean(goal && goal.targetDate && !goal.achievedAt);
  });
  const dueContributionByGoal = dueContributionsByGoal(planSummary.committedItems);

  const essentialInputs = input.essentialCategories.filter((c) => essentialById.has(c.categoryId));
  const essentialFixedTotal = round2(essentialInputs.reduce((sum, c) => sum + c.plannedAmount, 0));
  const flexibleInputs = input.flexibleCategories.filter((c) => flexibleById.has(c.categoryId));
  const flexibleTotal = round2(flexibleInputs.reduce((sum, c) => sum + c.plannedAmount, 0));

  // The protected buffer is never sent by the client: it is one recommendation
  // per income account, recomputed here from the same live data Step 3 shows,
  // and summed into the check-in's currency for PaydayCheckin.protectedBuffer.
  const bufferPlan = planAccountBuffers(
    accountInputs.map((a) => {
      const account = liveAccountById.get(a.accountId)!;
      return {
        accountId: account.id,
        name: account.name,
        currency: account.currency,
        income: a.incomeEntered,
        bufferFloor: round2(
          convert(context.bufferFloorAmount, context.bufferFloorCurrency, account.currency, context.rates),
        ),
      };
    }),
    subscriptionDrafts.map((item) => ({
      recurringItemId: item.recurringItemId,
      accountId: item.accountId,
      nativeAmount: item.outstandingNativeAmount,
      currency: item.currency,
      alreadyLogged: item.alreadyLogged,
    })),
    { bufferPercent: context.bufferPercent, displayCurrency: context.displayCurrency, rates: context.rates },
  );
  const protectedBuffer = bufferPlan.total;

  // Each goal's roadmap amount, plan-anchored and netted against the recurring
  // contributions already aimed at it exactly as getPaydayCheckinDraft does -
  // never listGoals()'s today-anchored perPeriod - and then where that amount
  // is recommended to come from: the same headroom Step 3 showed, shared
  // between the goals in this order (see planGoalFunding). Each goal's
  // submitted rows go in as held, exactly what the wizard fed the live pool:
  // a later goal's recommendation is then the one Step 3 showed after the
  // goals above it were edited, not a context-free figure. An unedited row's
  // submitted amount is that recommendation itself, so passing every row as
  // held draws the same pool the client did.
  const roadmapByGoal = new Map(
    goalInputs.map((g) => {
      const goal = goalById.get(g.goalId)!;
      return [
        g.goalId,
        goalRoadmapAmount(
          { displayRemaining: goal.displayRemaining, targetDate: goal.targetDate as Date },
          plan.start,
          dueContributionByGoal.get(goal.id) ?? 0,
        ),
      ];
    }),
  );
  const fundingPlanByGoal = new Map(
    planGoalFunding(
      goalInputs.map((g) => ({
        goalId: g.goalId,
        amount: roadmapByGoal.get(g.goalId)!,
        funding: g.funding
          .filter((row) => liveAccountById.has(row.accountId))
          .map((row) => ({ accountId: row.accountId, plannedAmount: row.plannedAmount, held: true })),
      })),
      bufferPlan.accounts,
      { displayCurrency: context.displayCurrency, rates: context.rates },
    ).map((fundingPlan) => [fundingPlan.goalId, fundingPlan]),
  );
  // One row per (goal, account) with either amount above zero, in the
  // account's own currency: the user's figure for that account is trusted like
  // every other planned value, and sits next to what the recommendation said.
  // A row the user zeroed keeps the recommendation on record; a row for an
  // account the recommendation skipped keeps the user's figure.
  const goalRows = goalInputs.flatMap((g) => {
    const recommendedByAccount = new Map(
      fundingPlanByGoal.get(g.goalId)!.draws.map((draw) => [draw.accountId, draw.recommendedAmount]),
    );
    const plannedByAccount = new Map(
      g.funding
        .filter((row) => liveAccountById.has(row.accountId))
        .map((row) => [row.accountId, row.plannedAmount]),
    );
    return [...new Set([...recommendedByAccount.keys(), ...plannedByAccount.keys()])]
      .map((accountId) => ({
        goalId: g.goalId,
        accountId,
        currency: liveAccountById.get(accountId)!.currency,
        recommendedAmount: recommendedByAccount.get(accountId) ?? 0,
        plannedAmount: plannedByAccount.get(accountId) ?? 0,
      }))
      .filter((row) => row.recommendedAmount > 0 || row.plannedAmount > 0);
  });
  const goalPlanTotal = round2(
    goalRows.reduce(
      (sum, row) => sum + convert(row.plannedAmount, row.currency, context.displayCurrency, context.rates),
      0,
    ),
  );

  // The wizard only ever offers "all of it" or "none of it", so anything else -
  // most realistically a draft left open while the previous period kept moving -
  // is clamped to what this run actually measured before it is used or stored.
  const includedCarryover = round2(
    Math.min(Math.max(0, input.includedCarryover), carryover.amount),
  );

  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: protectedBuffer,
  });

  const needsDeficitAck = available < 0 || flexibleTotal > Math.max(0, available);
  const needsZeroBufferAck = protectedBuffer <= 0;
  const acknowledgements: PaydayAcknowledgementState = {
    available,
    needsDeficitAck,
    needsZeroBufferAck,
  };
  if (needsDeficitAck && !input.acknowledgedDeficit) {
    return { ok: false, reason: "deficit_not_acknowledged", acknowledgements };
  }
  if (needsZeroBufferAck && !input.acknowledgedZeroBuffer) {
    return { ok: false, reason: "zero_buffer_not_acknowledged", acknowledgements };
  }

  await prisma.$transaction(async (tx) => {
    // upsert on the (year, month, period) unique key rather than find-then-
    // create: two confirmations of the same period racing each other used to
    // let both find nothing and the loser hit a raw constraint error.
    const existingCheckin = await tx.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
    });
    // The check-in's date is set once, when the row is first created, and a
    // re-confirm keeps it: reopening the wizard days later to adjust one
    // category must not re-date the check-in or the paycheck it recorded.
    const checkinDate = existingCheckin?.checkinDate ?? checkinDateForNewCheckin(planRef, context);
    const checkin = existingCheckin
      ? await tx.paydayCheckin.update({
          where: { id: existingCheckin.id },
          data: {
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover,
            protectedBuffer,
            status: "CONFIRMED",
          },
        })
      : await tx.paydayCheckin.upsert({
          where: {
            year_month_period: {
              year: planRef.year,
              month: planRef.month,
              period: planRef.period,
            },
          },
          update: {
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover,
            protectedBuffer,
            status: "CONFIRMED",
          },
          create: {
            year: planRef.year,
            month: planRef.month,
            period: planRef.period,
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover,
            protectedBuffer,
            status: "CONFIRMED",
          },
        });

    for (const accountInput of accountInputs) {
      const account = liveAccountById.get(accountInput.accountId)!;
      const existingSnapshot = await tx.paydayAccountSnapshot.findFirst({
        where: { paydayCheckinId: checkin.id, accountId: account.id },
      });
      // Measured against the ledger without this check-in's own income, so a
      // re-confirm reconciles against the same figure the first confirm did.
      const expectedLedgerBalance = ledgerBefore(account.balance, existingSnapshot);
      const difference = round2(accountInput.reportedBalance - expectedLedgerBalance);

      let incomeTransactionId = existingSnapshot?.incomeTransactionId ?? null;
      if (accountInput.incomeEntered > 0) {
        let updated = { count: 0 };
        if (incomeTransactionId) {
          // Amount and note only: the paycheck keeps the date it was first
          // recorded with (see checkinDate above).
          updated = await tx.transaction.updateMany({
            where: { id: incomeTransactionId },
            data: { amount: accountInput.incomeEntered, note: accountInput.incomeNote },
          });
        }
        if (updated.count === 0) {
          const created = await tx.transaction.create({
            data: {
              date: checkinDate,
              amount: accountInput.incomeEntered,
              currency: account.currency,
              type: "INCOME",
              accountId: account.id,
              note: accountInput.incomeNote,
              source: "PAYDAY_CHECKIN",
            },
          });
          incomeTransactionId = created.id;
        }
      } else if (incomeTransactionId) {
        await tx.transaction.deleteMany({ where: { id: incomeTransactionId } });
        incomeTransactionId = null;
      }

      const snapshotData = {
        expectedLedgerBalance,
        reportedBalance: accountInput.reportedBalance,
        difference,
        incomeEntered: accountInput.incomeEntered,
        incomeNote: accountInput.incomeNote,
        incomeTransactionId,
        currency: account.currency,
      };
      if (existingSnapshot) {
        await tx.paydayAccountSnapshot.update({ where: { id: existingSnapshot.id }, data: snapshotData });
      } else {
        await tx.paydayAccountSnapshot.create({
          data: { paydayCheckinId: checkin.id, accountId: account.id, ...snapshotData },
        });
      }
    }

    await tx.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkin.id } });

    const allocationRows = [
      ...subscriptionItems.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "SUBSCRIPTION" as const,
        recurringItemId: item.id,
        accountId: item.accountId,
        recommendedAmount: item.nativeAmount,
        plannedAmount: item.nativeAmount,
        currency: item.currency,
        basis: "recurring_item",
      })),
      ...contributionItems.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "RECURRING_CONTRIBUTION" as const,
        recurringItemId: item.id,
        recommendedAmount: item.nativeAmount,
        plannedAmount: item.nativeAmount,
        currency: item.currency,
        basis: "recurring_item",
      })),
      // One GOAL row per (goal, account) the goal draws on, in that account's
      // own currency, like the BUFFER rows below. Check-ins confirmed before
      // this carry a single accountless GOAL row per goal in the check-in's
      // currency; readers sum a goal's rows either way.
      ...goalRows.map((row) => ({
        paydayCheckinId: checkin.id,
        type: "GOAL" as const,
        goalId: row.goalId,
        accountId: row.accountId,
        recommendedAmount: row.recommendedAmount,
        plannedAmount: row.plannedAmount,
        currency: row.currency,
        basis: "roadmap_headroom_share",
      })),
      ...essentialInputs.map((c) => ({
        paydayCheckinId: checkin.id,
        type: "ESSENTIAL_CATEGORY" as const,
        categoryId: c.categoryId,
        recommendedAmount: suggestionsByCategory.get(c.categoryId)?.amount ?? 0,
        plannedAmount: c.plannedAmount,
        currency: context.displayCurrency,
        basis: suggestionsByCategory.get(c.categoryId)?.basis ?? "none",
      })),
      ...flexibleInputs.map((c) => ({
        paydayCheckinId: checkin.id,
        type: "FLEXIBLE_CATEGORY" as const,
        categoryId: c.categoryId,
        recommendedAmount: suggestionsByCategory.get(c.categoryId)?.amount ?? 0,
        plannedAmount: c.plannedAmount,
        currency: context.displayCurrency,
        basis: suggestionsByCategory.get(c.categoryId)?.basis ?? "none",
      })),
      // One BUFFER row per account with income, each in that account's own
      // currency. PaydayCheckin.protectedBuffer above is their sum in the
      // check-in's currency, so readers of that single figure are unaffected.
      ...bufferPlan.accounts.map((plan) => ({
        paydayCheckinId: checkin.id,
        type: "BUFFER" as const,
        accountId: plan.accountId,
        recommendedAmount: plan.suggestedBuffer,
        plannedAmount: plan.suggestedBuffer,
        currency: plan.currency,
        basis: "buffer_formula",
      })),
      {
        paydayCheckinId: checkin.id,
        type: "CARRYOVER" as const,
        recommendedAmount: carryover.amount,
        plannedAmount: includedCarryover,
        currency: context.displayCurrency,
        basis: carryover.basis,
      },
    ];
    await tx.paydayPlanAllocation.createMany({ data: allocationRows });

    for (const categoryInput of [...essentialInputs, ...flexibleInputs]) {
      const existingBudget = await tx.budget.findFirst({
        where: {
          year: planRef.year,
          month: planRef.month,
          period: planRef.period,
          categoryId: categoryInput.categoryId,
        },
      });
      // A budget the user never touched arrives back as its own stored amount
      // converted into the display currency (see existingBudgetByCategory in
      // getPaydayCheckinDraft). Writing that back would re-denominate a row
      // nobody edited, at today's rate, on every confirmation. Same guard, and
      // the same reason, as saveBudgetAction in src/server/actions/budgets.ts.
      const untouched =
        existingBudget !== null &&
        existingBudget.currency !== context.displayCurrency &&
        isSameMoney(
          categoryInput.plannedAmount,
          context.displayCurrency,
          num(existingBudget.amount),
          existingBudget.currency,
          context.rates,
        );
      if (untouched) continue;

      if (existingBudget) {
        await tx.budget.update({
          where: { id: existingBudget.id },
          data: { amount: categoryInput.plannedAmount, currency: context.displayCurrency },
        });
      } else {
        await tx.budget.create({
          data: {
            year: planRef.year,
            month: planRef.month,
            period: planRef.period,
            categoryId: categoryInput.categoryId,
            amount: categoryInput.plannedAmount,
            currency: context.displayCurrency,
          },
        });
      }
    }
  });

  return { ok: true };
}
