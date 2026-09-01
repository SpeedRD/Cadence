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
import { convert } from "@/lib/currency";
import { maxDate } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "@/lib/payday";
import {
  daysRemainingInPeriod,
  isPaydayDate,
  nextPeriod,
  periodInfo,
  previousPeriod,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";

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
}

export interface PaydayCommittedDraft {
  recurringItemId: string;
  name: string;
  amount: number;
  nativeAmount: number;
  currency: string;
  nextDate: Date;
  alreadyLogged: boolean;
}

export interface PaydayGoalDraft {
  goalId: string;
  name: string;
  currency: string;
  recommendedAmount: number;
  plannedAmount: number;
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
  suggestedBuffer: number;
  plannedBuffer: number;
  bufferFloor: number;
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  /** Days left in the plan period counting today, for the safe-to-spend-per-day estimate in Step 4 - the full period length when opened exactly on a payday (the period hasn't started yet), fewer when opened partway through an already-current period. */
  daysRemainingInPlanPeriod: number;
}

/**
 * The period a check-in opened right now plans for: the *next* period when
 * today is exactly a payday date (the 15th/last day, i.e. the last day of the
 * period that's ending), otherwise the period containing today (covers
 * opening the wizard a few days into an already-current period).
 */
export function planPeriodRef(context: AppContext): PeriodRef {
  return isPaydayDate(context.today)
    ? nextPeriod(context.currentPeriod)
    : context.currentPeriod;
}

const HISTORY_PERIODS = 6;

/** Exported so Task 7's server action can recompute the exact same suggestions before persisting - never trusting a client-sent "recommended" figure. */
export async function getCategorySuggestions(
  planRef: PeriodRef,
  categories: { id: string }[],
  context: AppContext,
): Promise<Map<string, { amount: number; basis: SuggestionBasis }>> {
  const result = new Map<string, { amount: number; basis: SuggestionBasis }>();
  if (categories.length === 0) return result;
  const categoryIds = categories.map((c) => c.id);

  const prevRef = previousPeriod(planRef);
  const lastBudgets = await prisma.budget.findMany({
    where: {
      year: prevRef.year,
      month: prevRef.month,
      period: prevRef.period,
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
  const historicalNonZero = new Set<string>();
  if (remaining.length > 0) {
    let cursor = prevRef;
    for (let i = 0; i < HISTORY_PERIODS; i += 1) {
      const summary = await getPeriodSummary(periodInfo(cursor), context);
      for (const line of summary.categories) {
        if (!line.categoryId || !remaining.includes(line.categoryId)) continue;
        historicalTotals.set(line.categoryId, (historicalTotals.get(line.categoryId) ?? 0) + line.spent);
        if (line.spent > 0) historicalNonZero.add(line.categoryId);
      }
      cursor = previousPeriod(previousPeriod(cursor));
    }
  }

  for (const id of categoryIds) {
    const fromBudget = lastBudgetByCategory.get(id);
    if (fromBudget !== undefined) {
      result.set(id, { amount: fromBudget, basis: "last_budget" });
    } else if (historicalNonZero.has(id)) {
      result.set(id, { amount: round2((historicalTotals.get(id) ?? 0) / HISTORY_PERIODS), basis: "average" });
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
export async function getAvailableCarryover(
  planRef: PeriodRef,
  context: AppContext,
): Promise<{ amount: number; basis: CarryoverBasis }> {
  const prevSummary = await getPeriodSummary(periodInfo(previousPeriod(planRef)), context);
  if (!prevSummary.hasBudget) return { amount: 0, basis: "no_prior_budget" };
  return { amount: round2(Math.max(0, prevSummary.safeToSpend)), basis: "prior_period_budget" };
}

function toCommittedDraft(item: CommittedItem, alreadyLoggedIds: Set<string>): PaydayCommittedDraft {
  return {
    recurringItemId: item.id,
    name: item.name,
    amount: item.amount,
    nativeAmount: item.nativeAmount,
    currency: item.currency,
    nextDate: item.nextDate,
    alreadyLogged: alreadyLoggedIds.has(item.id),
  };
}

export async function getPaydayCheckinDraft(context: AppContext): Promise<PaydayCheckinDraft> {
  const planRef = planPeriodRef(context);
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
  ] = await Promise.all([
    getAccountBalances(context, { status: "ACTIVE" }),
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
        nextDate: { gte: maxDate(context.today, plan.start), lte: plan.end },
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
    prisma.transaction.findMany({
      where: { type: "EXPENSE", date: { gte: plan.start, lte: plan.end } },
      select: { id: true, amount: true, currency: true, categoryId: true, note: true },
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
  const { actualNativeByItemId } = matchRecurringToTransactions(forMatch, matchableExpenses);
  const alreadyLoggedIds = new Set(actualNativeByItemId.keys());

  const existingSnapshotByAccount = new Map((existing?.snapshots ?? []).map((s) => [s.accountId, s]));
  const existingAllocationByKey = new Map(
    (existing?.allocations ?? []).map((a) => [
      `${a.type}:${a.categoryId ?? a.goalId ?? a.recurringItemId ?? ""}`,
      a,
    ]),
  );

  const accountDrafts: PaydayAccountDraft[] = accounts.map((account) => {
    const snapshot = existingSnapshotByAccount.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      currency: account.currency,
      type: account.type,
      expectedLedgerBalance: account.balance,
      reportedBalance: snapshot ? num(snapshot.reportedBalance) : account.balance,
      incomeEntered: snapshot ? num(snapshot.incomeEntered) : 0,
      incomeNote: snapshot?.incomeNote ?? "",
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
    .map((item) => toCommittedDraft(item, alreadyLoggedIds));
  const contributions = planSummary.committedItems
    .filter((i) => i.kind === "CONTRIBUTION")
    .map((item) => toCommittedDraft(item, alreadyLoggedIds));
  const subscriptionsTotal = round2(
    subscriptions.filter((i) => !i.alreadyLogged).reduce((sum, i) => sum + i.amount, 0),
  );
  const contributionsTotal = round2(
    contributions.filter((i) => !i.alreadyLogged).reduce((sum, i) => sum + i.amount, 0),
  );

  const goals: PaydayGoalDraft[] = allGoals
    .filter((g) => g.targetDate && !g.achievedAt && g.perPeriod !== null)
    .map((g) => {
      const existingAlloc = existingAllocationByKey.get(`GOAL:${g.id}`);
      return {
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        recommendedAmount: g.perPeriod as number,
        plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : (g.perPeriod as number),
        targetDate: g.targetDate as Date,
        periodsLeft: g.periodsLeft as number,
      };
    });
  const goalPlanTotal = round2(
    goals.reduce((sum, g) => sum + convert(g.plannedAmount, g.currency, context.displayCurrency, context.rates), 0),
  );

  const essentialSuggestions = await getCategorySuggestions(planRef, essentialCategoryRows, context);
  const essentialCategories: PaydayCategoryDraft[] = essentialCategoryRows.map((category) => {
    const suggestion = essentialSuggestions.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`ESSENTIAL_CATEGORY:${category.id}`);
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: suggestion.amount,
      plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : suggestion.amount,
      basis: suggestion.basis,
    };
  });
  const essentialFixedTotal = round2(essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0));

  const bufferFloor = round2(
    convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, context.displayCurrency, context.rates),
  );
  const suggestedBuffer = defaultProtectedBuffer(totalIncome, settings.bufferPercent, bufferFloor);
  const existingBufferAlloc = existingAllocationByKey.get("BUFFER:");
  const plannedBuffer = existingBufferAlloc ? num(existingBufferAlloc.plannedAmount) : suggestedBuffer;

  const includedCarryover = existing
    ? num(existing.includedCarryover)
    : settings.carryoverIncludedByDefault
      ? carryover.amount
      : 0;

  const flexibleSuggestions = await getCategorySuggestions(planRef, flexibleCategoryRows, context);
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
    flexibleCategoryRows.map((c) => ({ id: c.id, suggested: flexibleSuggestions.get(c.id)?.amount ?? 0 })),
    available,
  );
  const scaledById = new Map(scaled.map((s) => [s.id, s.scaled]));
  const flexibleCategories: PaydayCategoryDraft[] = flexibleCategoryRows.map((category) => {
    const suggestion = flexibleSuggestions.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`FLEXIBLE_CATEGORY:${category.id}`);
    const scaledAmount = scaledById.get(category.id) ?? 0;
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: scaledAmount,
      plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : scaledAmount,
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
    suggestedBuffer,
    plannedBuffer,
    bufferFloor,
    availableCarryover: carryover.amount,
    carryoverBasis: carryover.basis,
    includedCarryover,
    daysRemainingInPlanPeriod: daysRemainingInPeriod(context.today, plan),
  };
}
