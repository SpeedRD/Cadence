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
  periodsRemaining,
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
    // Same HISTORY_PERIODS periods as before (prevRef, then two periods back
    // each time), just fetched in parallel instead of sequentially - each
    // getPeriodSummary() call is an independent DB round-trip, and the
    // dashboard calls this unconditionally on every load.
    const cursors: PeriodRef[] = [];
    let cursor = prevRef;
    for (let i = 0; i < HISTORY_PERIODS; i += 1) {
      cursors.push(cursor);
      cursor = previousPeriod(previousPeriod(cursor));
    }
    const summaries = await Promise.all(
      cursors.map((ref) => getPeriodSummary(periodInfo(ref), context)),
    );
    for (const summary of summaries) {
      for (const line of summary.categories) {
        if (!line.categoryId || !remaining.includes(line.categoryId)) continue;
        historicalTotals.set(line.categoryId, (historicalTotals.get(line.categoryId) ?? 0) + line.spent);
        if (line.spent > 0) historicalNonZero.add(line.categoryId);
      }
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
    existingBudgetRows,
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
  const { actualNativeByItemId } = matchRecurringToTransactions(forMatch, matchableExpenses);
  const alreadyLoggedIds = new Set(actualNativeByItemId.keys());

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
    .filter((g) => g.targetDate && !g.achievedAt && g.remaining > 0)
    .map((g) => {
      const existingAlloc = existingAllocationByKey.get(`GOAL:${g.id}`);
      // listGoals()'s perPeriod/periodsLeft are anchored to context.today (right
      // for the goals page's "time until target" display), but the payday
      // planner reserves money for the PLAN period, which can be tomorrow's
      // period rather than today's (see planPeriodRef()) - so recompute here
      // anchored to plan.start instead of trusting the pre-computed fields.
      const periodsLeft = Math.max(1, periodsRemaining(plan.start, g.targetDate as Date));
      const recommendedAmount = round2(g.remaining / periodsLeft);
      return {
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        recommendedAmount,
        plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : recommendedAmount,
        targetDate: g.targetDate as Date,
        periodsLeft,
      };
    });
  const goalPlanTotal = round2(
    goals.reduce((sum, g) => sum + convert(g.plannedAmount, g.currency, context.displayCurrency, context.rates), 0),
  );

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

  const bufferFloor = round2(
    convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, context.displayCurrency, context.rates),
  );
  const suggestedBuffer = defaultProtectedBuffer(totalIncome, settings.bufferPercent, bufferFloor);
  const existingBufferAlloc = existingAllocationByKey.get("BUFFER:");
  const plannedBuffer = existingBufferAlloc
    ? round2(convert(num(existingBufferAlloc.plannedAmount), existingBufferAlloc.currency, context.displayCurrency, context.rates))
    : suggestedBuffer;

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
    suggestedBuffer,
    plannedBuffer,
    bufferFloor,
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

export type ConfirmPaydayCheckinResult =
  | { ok: true }
  | { ok: false; reason: "no_active_accounts" }
  | { ok: false; reason: "deficit_not_acknowledged" }
  | { ok: false; reason: "zero_buffer_not_acknowledged" };

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
  ] = await Promise.all([
    getAccountBalances(context, { status: "ACTIVE" }),
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
  const liveAccountById = new Map(liveAccounts.map((a) => [a.id, a]));
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

  const totalIncome = round2(
    accountInputs.reduce((sum, a) => {
      const account = liveAccountById.get(a.accountId)!;
      return sum + convert(a.incomeEntered, account.currency, context.displayCurrency, context.rates);
    }, 0),
  );

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

  const subscriptionItems = planSummary.committedItems.filter((i) => i.kind === "SUBSCRIPTION");
  const contributionItems = planSummary.committedItems.filter((i) => i.kind === "CONTRIBUTION");
  const subscriptionsTotal = round2(
    subscriptionItems.filter((i) => !alreadyLoggedIds.has(i.id)).reduce((sum, i) => sum + i.amount, 0),
  );
  const contributionsTotal = round2(
    contributionItems.filter((i) => !alreadyLoggedIds.has(i.id)).reduce((sum, i) => sum + i.amount, 0),
  );

  const goalById = new Map(allGoals.map((g) => [g.id, g]));
  const goalInputs = input.goals.filter((g) => {
    const goal = goalById.get(g.goalId);
    return Boolean(goal && goal.targetDate && !goal.achievedAt);
  });
  const goalPlanTotal = round2(
    goalInputs.reduce((sum, g) => {
      const goal = goalById.get(g.goalId)!;
      return sum + convert(g.plannedAmount, goal.currency, context.displayCurrency, context.rates);
    }, 0),
  );

  const essentialInputs = input.essentialCategories.filter((c) => essentialById.has(c.categoryId));
  const essentialFixedTotal = round2(essentialInputs.reduce((sum, c) => sum + c.plannedAmount, 0));
  const flexibleInputs = input.flexibleCategories.filter((c) => flexibleById.has(c.categoryId));
  const flexibleTotal = round2(flexibleInputs.reduce((sum, c) => sum + c.plannedAmount, 0));

  const bufferFloor = round2(
    convert(context.bufferFloorAmount, context.bufferFloorCurrency, context.displayCurrency, context.rates),
  );
  const recommendedBuffer = defaultProtectedBuffer(totalIncome, context.bufferPercent, bufferFloor);

  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover: input.includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: input.buffer,
  });

  const needsDeficitAck = available < 0 || flexibleTotal > Math.max(0, available);
  if (needsDeficitAck && !input.acknowledgedDeficit) {
    return { ok: false, reason: "deficit_not_acknowledged" };
  }
  if (input.buffer <= 0 && !input.acknowledgedZeroBuffer) {
    return { ok: false, reason: "zero_buffer_not_acknowledged" };
  }

  const checkinDate = context.today;

  await prisma.$transaction(async (tx) => {
    const existingCheckin = await tx.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
    });
    const checkin = existingCheckin
      ? await tx.paydayCheckin.update({
          where: { id: existingCheckin.id },
          data: {
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover: input.includedCarryover,
            protectedBuffer: input.buffer,
            status: "CONFIRMED",
          },
        })
      : await tx.paydayCheckin.create({
          data: {
            year: planRef.year,
            month: planRef.month,
            period: planRef.period,
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover: input.includedCarryover,
            protectedBuffer: input.buffer,
            status: "CONFIRMED",
          },
        });

    for (const accountInput of accountInputs) {
      const account = liveAccountById.get(accountInput.accountId)!;
      const difference = round2(accountInput.reportedBalance - account.balance);
      const existingSnapshot = await tx.paydayAccountSnapshot.findFirst({
        where: { paydayCheckinId: checkin.id, accountId: account.id },
      });

      let incomeTransactionId = existingSnapshot?.incomeTransactionId ?? null;
      if (accountInput.incomeEntered > 0) {
        let updated = { count: 0 };
        if (incomeTransactionId) {
          updated = await tx.transaction.updateMany({
            where: { id: incomeTransactionId },
            data: { date: checkinDate, amount: accountInput.incomeEntered, note: accountInput.incomeNote },
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
        expectedLedgerBalance: account.balance,
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
      ...goalInputs.map((g) => {
        const goal = goalById.get(g.goalId)!;
        // Same plan-anchored recompute as getPaydayCheckinDraft above - never
        // trust listGoals()'s today-anchored perPeriod for the audit-trail
        // recommendedAmount here.
        const periodsLeft = Math.max(1, periodsRemaining(plan.start, goal.targetDate as Date));
        const recommendedAmount = round2(goal.remaining / periodsLeft);
        return {
          paydayCheckinId: checkin.id,
          type: "GOAL" as const,
          goalId: goal.id,
          recommendedAmount,
          plannedAmount: g.plannedAmount,
          currency: goal.currency,
          basis: "roadmap",
        };
      }),
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
      {
        paydayCheckinId: checkin.id,
        type: "BUFFER" as const,
        recommendedAmount: recommendedBuffer,
        plannedAmount: input.buffer,
        currency: context.displayCurrency,
        basis: "buffer_formula",
      },
      {
        paydayCheckinId: checkin.id,
        type: "CARRYOVER" as const,
        recommendedAmount: carryover.amount,
        plannedAmount: input.includedCarryover,
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
