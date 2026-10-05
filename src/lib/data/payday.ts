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
import { comparableHistory, HISTORY_PERIODS } from "@/lib/history-window";
import { addDays } from "@/lib/date";
import { convert, isSameMoney, type RateTable } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import {
  availableForFlexibleCategories,
  commitmentPortions,
  draftAccountBuffers,
  planAccountBuffers,
  planGoalFunding,
  reachedGoalFunding,
  reconciliation,
  scaleFlexibleSuggestions,
  type GoalFundingPlan,
} from "@/lib/payday";
import {
  byItem,
  outstandingAmount,
  sumOccurrences,
  whole,
  wholeAmount,
  wontPost,
  type CommitmentOccurrence,
} from "@/lib/period-commitments";
import {
  followThroughDue,
  followThroughShortfall,
  planningShortfall,
  roomShortfall,
} from "@/lib/goal-plan";
import {
  fundingWindow,
  paydayDateFor,
  periodClock,
  periodInfo,
  periodKey,
  previousComparablePeriod,
  previousPeriod,
  type PeriodInfo,
  type PeriodRef,
} from "@/lib/period";
import {
  carryoverIncluded as carryoverRowIncluded,
  carryoverIsProvisional,
  INCLUDED_AT_ZERO_CARRYOVER_BASIS,
  PROVISIONAL_CARRYOVER_BASIS,
} from "@/lib/flexible-room";
import { ledgerDepositsIssue, paycheckNow } from "@/lib/period-income";
import { prisma } from "@/lib/prisma";
import type { OccurrenceEarmark } from "@/lib/earmarks";
import type { RecurringSkipReason } from "@/lib/recurring";
import type { paydayConfirmSchema } from "@/lib/validation";
import type { z } from "zod";

import { getAccountBalances, ledgerAt } from "@/lib/data/accounts";
import { loadPayLanded } from "@/lib/data/pay-landed";
import { ledgerDepositsTotal, ledgerDepositsVersion, loadLedgerDeposits, type LedgerDeposit } from "@/lib/data/period-income";
import { goalPeriodPlans, loadGoalPeriodPlans, type GoalPeriodPlan } from "@/lib/data/goal-plan";
import { loadBudgetSpent } from "@/lib/data/budget-spending";
import { loadHistoryBounds } from "@/lib/data/history-window";
import {
  carryoverAdjustmentFor,
  periodLeftover,
  settleCarryovers,
  type CarryoverAdjustment,
  type IncomeAdjustment,
} from "@/lib/data/flexible-room";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { listGoals } from "@/lib/data/goals";

import type { AppContext } from "@/lib/data/context";
import type { Prisma } from "@/generated/prisma/client";

export interface PaydayAccountDraft {
  accountId: string;
  name: string;
  currency: string;
  type: string;
  expectedLedgerBalance: number;
  reportedBalance: number;
  incomeEntered: number;
  /**
   * The part of incomeEntered the user says is one-off (a bonus), 0 up to
   * incomeEntered: the period's income all the same, left out of the income
   * estimate later periods are projected from (src/lib/period-income.ts).
   */
  oneOffIncome: number;
  incomeNote: string;
  /**
   * A confirmed check-in already recorded this account's paycheck as a
   * transaction: confirming again updates that row (or removes it, at 0)
   * rather than creating one - what Step 5 says it will do.
   */
  hasIncomeTransaction: boolean;
  /**
   * Deposits the ledger already holds on this account in the plan period's
   * income window (loadLedgerDeposits), oldest first, in the account's
   * currency. Step 2 lists them and prefills incomeEntered with their sum;
   * confirming adopts them as they are, records only what incomeEntered
   * holds beyond them as the check-in's own row, and refuses less than they
   * hold (R1). Empty for an archived account, which is not edited.
   */
  ledgerDeposits: LedgerDeposit[];
  /** ledgerDeposits summed: the least incomeEntered can be. */
  ledgerDepositsTotal: number;
  /**
   * Deposits in the same window that are, in whole or in part, not pay -
   * marked one-off, or partly set aside for a recurring payment - and so not
   * counted (or not wholly) in ledgerDeposits. Step 2 says how many.
   */
  ledgerDepositsSetAside: number;
  /** The configured buffer floor converted to this account's own currency, so the step can recompute its buffer as income is edited. */
  bufferFloor: number;
  /**
   * The account has been archived since this check-in recorded income for it.
   * Its figures still count - the money was received - but there is nothing
   * left to edit, so the wizard shows them without letting them be changed.
   */
  readOnly: boolean;
}

/**
 * One item's occurrences in the plan period (src/lib/period-commitments.ts),
 * wont_post ones aside. The plan counts all of them - `amount` - whether
 * still to come or already posted or paid, because the income it is set
 * against is the whole period's paycheck.
 */
export interface PaydayCommittedDraft {
  recurringItemId: string;
  name: string;
  /** Everything this item costs the plan period, posted and paid occurrences included, in the display currency. */
  amount: number;
  /** The same total in the item's own currency. */
  nativeAmount: number;
  /** One charge in the item's own currency, for a row that owes several. */
  perOccurrenceAmount: number;
  /** How many charges the item's schedule still holds in the plan period (the ones posting has not moved past). */
  occurrenceCount: number;
  currency: string;
  /** The first due date in the plan period. */
  nextDate: Date;
  /** One of its dates is before today and automatic posting has not cleared it. */
  overdue: boolean;
  /**
   * How many of those scheduled charges are already in the ledger from
   * another route (an approved receipt, a CSV row, a manual entry) or already
   * posted - one charge per occurrence, never more than occurrenceCount:
   * posting's own settlement plan decides it.
   */
  loggedOccurrences: number;
  /** Occurrences in the plan period posting has already moved past: posted, or paid by a charge it paired with them. */
  ledgerOccurrences: number;
  /** What is still to leave for this item: its outstanding occurrences, in the display currency. */
  outstandingAmount: number;
  /** The same in the item's own currency - what its account still has to cover. */
  outstandingNativeAmount: number;
  /** Every occurrence in the plan period is already posted or paid. */
  alreadyLogged: boolean;
  /** What already left for this item, per account it left from, in that account's currency. */
  paidPortions: { accountId: string | null; amount: number; currency: string }[];
  /** The account funding this item - reassignable from Step 3, which writes RecurringItem.accountId. */
  accountId: string | null;
  /**
   * Deposits the user earmarked for its occurrences in the plan period
   * (src/lib/earmarks.ts), one entry per deposit, each in the currency of the
   * account it covers: already taken off `amount`, `outstandingAmount` and
   * `paidPortions`, and named on the row ("X covered by ...").
   */
  covered: OccurrenceEarmark[];
  /**
   * Set when `covered` is: what is still to leave in the currency of the
   * account it leaves from, where the earmark was set aside. The item's own
   * currency rounds a partly covered charge to its cents, which the
   * account's room would then read a few cents off; this is the exact
   * figure (commitmentPortions prefers it).
   */
  outstandingInAccount?: { amount: number; currency: string };
}

/** An item with occurrences in the plan period that posting will skip: listed with its reason, counted nowhere. */
export interface PaydayWontPostDraft {
  recurringItemId: string;
  name: string;
  kind: "SUBSCRIPTION" | "CONTRIBUTION";
  reason: RecurringSkipReason;
  nextDate: Date;
  occurrenceCount: number;
  /** What its occurrences would cost, in the display currency - left out of every total. */
  amount: number;
  nativeAmount: number;
  currency: string;
}

/**
 * A goal reached since the plan period's check-in was confirmed: its
 * confirmed draws stay in the plan (the money was committed, and most likely
 * moved, this period), read-only.
 */
export interface PaydayReachedGoalDraft {
  goalId: string;
  name: string;
  /** Its confirmed GOAL rows summed into the display currency. */
  plannedAmount: number;
  /** The rows themselves, in each account's currency - confirming again writes them back unchanged. */
  rows: { accountId: string | null; plannedAmount: number; recommendedAmount: number; currency: string }[];
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
  /**
   * What the check-in should fund by hand this period: the goal's pace less
   * the recurring contributions scheduled in the period (the plan's `byHand`,
   * src/lib/goal-plan.ts). For a goal with no target date, its whole remaining
   * balance less the same.
   */
  recommendedAmount: number;
  /** The gross pace, recurring contributions included (the plan's `pace`). */
  pace: number;
  /** The goal's recurring contributions in the period. */
  scheduled: number;
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
  /** Null for a goal with no target date: it is funded as fast as room allows rather than paced. */
  targetDate: Date | null;
  /** Pay periods from the plan period to the target date; null when there is no date to count to. */
  periodsLeft: number | null;
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

/**
 * A flexible category as the draft carries it: suggestedAmount is the RAW
 * getCategorySuggestions() figure, not yet scaled to what the plan has
 * available - that depends on the income Step 2 records, which is unknown
 * when the draft is built. The wizard scales it live with
 * resolveFlexibleCategories(); confirmPaydayCheckin() stores this raw figure
 * as the allocation's recommendedAmount.
 */
export interface PaydayFlexibleCategoryDraft extends PaydayCategoryDraft {
  /**
   * plannedAmount is a figure of the user's own - a budget already saved for
   * the period or a confirmed allocation - and stays put. Otherwise it follows
   * the live scaled suggestion, exactly like an unedited goal funding row
   * (PaydayGoalFundingDraft.held).
   */
  held: boolean;
}

export type CarryoverBasis = "prior_period_budget" | "no_prior_budget";

export interface PaydayCheckinDraft {
  periodRef: PeriodRef;
  /** The plan period; its text label is formatPeriodLong (src/lib/date-format.ts), in the app's language. */
  period: PeriodInfo;
  /**
   * The day Step 1's ledger balances are as of: the day before this period's
   * pay landed (K8). The balances leave out the deposits Step 2 lists (S6),
   * so they hold none of the period's income.
   */
  ledgerDate: Date;
  isEditingConfirmed: boolean;
  checkinId: string | null;
  displayCurrency: string;
  accounts: PaydayAccountDraft[];
  subscriptions: PaydayCommittedDraft[];
  contributions: PaydayCommittedDraft[];
  /** Everything the period's subscriptions cost it (their `amount`s), in the display currency. */
  subscriptionsTotal: number;
  contributionsTotal: number;
  /** Items posting will skip this period, listed apart and counted in no total. */
  wontPost: PaydayWontPostDraft[];
  goals: PaydayGoalDraft[];
  reachedGoals: PaydayReachedGoalDraft[];
  essentialCategories: PaydayCategoryDraft[];
  flexibleCategories: PaydayFlexibleCategoryDraft[];
  /** Settings.bufferPercent, so Step 3 recomputes each account's buffer live as income is edited. */
  bufferPercent: number;
  /**
   * Every income account's own suggested buffer summed into displayCurrency.
   * Computed, never chosen: Step 3 shows one recommendation per account and
   * confirming writes one BUFFER allocation per account, with this sum landing
   * in PaydayCheckin.protectedBuffer for everything that reads a single figure.
   */
  plannedBuffer: number;
  /**
   * What the period before the plan period leaves it (periodLeftover in
   * src/lib/data/flexible-room.ts): its plan's room (its budget, when it had
   * no confirmed plan), less its budget spending - so far, while it is still
   * running.
   */
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  /**
   * The carryover is taken into the plan, whatever it stands at: on a
   * confirmed check-in, its CARRYOVER row is one the user included
   * (carryoverIncluded in src/lib/flexible-room.ts) - a carryover that
   * settled at 0 is still included, and keeps following the period it comes
   * from (S5); on a fresh one, Settings' default. Step 3's switch shows it
   * and confirming sends it.
   */
  carryoverIncluded: boolean;
  /**
   * The period the carryover comes from has not ended (decision 3): the
   * amount can still shrink, so the plan shows it as provisional and counts
   * none of it until that period's last day is over, when it settles.
   */
  carryoverProvisional: boolean;
  /** That period's last day - the carryover settles once it has passed. */
  carryoverSettlesAfter: Date;
  /**
   * The confirmed check-in's carryover moved after it settled, because rows
   * dated in the period it comes from arrived later (R8): Step 3 says so
   * beside it. Null when it never moved, and on a fresh check-in.
   */
  carryoverAdjustment: CarryoverAdjustment | null;
  /**
   * The confirmed plan's income moved since it was confirmed, because a
   * deposit a paycheck adopted is no longer the same pay (S7) - what the
   * confirmed card shows beside the income. Null when it did not, and on a
   * fresh check-in.
   */
  incomeAdjustment: IncomeAdjustment | null;
  /**
   * The deposits Step 2 lists, as a version (ledgerDepositsVersion):
   * confirming sends it back and is refused when they changed since - one
   * earmarked, edited, deleted, marked one-off or added in another tab
   * (S2) - rather than recording the difference as a paycheck row.
   */
  depositsVersion: string;
  /**
   * The confirmed check-in this draft was built from, as a version: its
   * updatedAt as an ISO string, null when there was none. Confirming sends it
   * back and is refused when the stored check-in changed since (another tab
   * or window confirmed meanwhile), rather than overwriting that plan.
   */
  checkinVersion: string | null;
  /** The server's today (the request's civil day in APP_TIMEZONE), for the dates the wizard pre-fills. */
  today: Date;
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
  return periodClock(context.today).plan;
}

/**
 * How many comparable (same-half) periods the planner averages over - one
 * history window for every average (K9, src/lib/history-window.ts).
 */
export { HISTORY_PERIODS };

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
    // The one history window for spending (K9, src/lib/history-window.ts):
    // up to HISTORY_PERIODS comparable (same-half) periods from the newest
    // one that has ended - a period still running has only some of its
    // spending, whether or not its plan is confirmed - leaving out a partial
    // first period of activity and every period that starts before
    // Settings' "count history from" date. Read in one query - the dashboard
    // calls this unconditionally on every load. The per-category count below
    // runs over the periods that remain, as it runs from a category's oldest
    // spending forward.
    const cursors = comparableHistory(planRef, context.today, "spending", { bounds: await loadHistoryBounds(context) });
    const spentByPeriod = await loadBudgetSpent(cursors, context);
    // Newest first, so the oldest period with budget spending in a category
    // is the furthest index the average reaches back to.
    cursors.forEach((period, index) => {
      const spent = spentByPeriod.get(period.key);
      for (const [categoryId, line] of spent?.byCategory ?? []) {
        if (!categoryId || !remaining.includes(categoryId)) continue;
        // Budget spending (K6, src/lib/budget-spending.ts) is what the
        // budget will be measured against, so it is what the suggestion
        // averages: nothing the plan already reserves (a row that stands for
        // a recurring occurrence, whatever category it is filed under), a
        // shared expense at the user's share, and a confirmed one-off
        // (Transaction.isExtraordinary, see src/lib/extraordinary.ts) taken
        // off once, as part of that same population - a charge outside it is
        // never subtracted. A period counts toward the divisor when the
        // category had budget spending in it, the same population as the
        // numerator, so periods whose only charge was a reserved one do not
        // dilute the average.
        historicalTotals.set(categoryId, (historicalTotals.get(categoryId) ?? 0) + line.spent - line.oneOff);
        if (line.spent > 0) historicalPeriodCount.set(categoryId, index + 1);
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
/** One goal still being saved for and its roadmap for a plan period, in the display currency. */
export interface GoalRoadmapPace {
  goalId: string;
  name: string;
  /** What the check-in funds by hand: the plan's `byHand` (src/lib/goal-plan.ts). */
  amount: number;
  /** The gross pace, recurring contributions included. */
  pace: number;
  /** The goal's recurring contributions in the period. */
  scheduled: number;
  /** Null for a goal with no target date - `amount` is then its whole remaining balance, a figure for the one period being planned rather than a per-period pace. */
  targetDate: Date | null;
}

/**
 * Every goal still being saved for, with its plan for `planRef` (see
 * loadGoalPeriodPlans): the figure the check-in draft and confirm recommend,
 * in the order the check-in funds them (oldest goal first). A goal that is
 * achieved or has none left to save is left out; a goal with no target date
 * asks its whole remaining balance.
 */
export async function getGoalRoadmapAmounts(
  planRef: PeriodRef,
  context: AppContext,
): Promise<GoalRoadmapPace[]> {
  const plans = await goalPeriodPlans(periodInfo(planRef), context);
  return plans
    .filter((plan) => plan.open)
    .map((plan) => ({
      goalId: plan.goalId,
      name: plan.name,
      amount: plan.byHand,
      pace: plan.pace,
      scheduled: plan.scheduled,
      targetDate: plan.targetDate,
    }));
}

/**
 * getGoalRoadmapAmounts() for one goal: what the check-in funds by hand for
 * it in `planRef`. Null for a goal that is achieved or has none left to save
 * (or does not exist).
 */
export async function getGoalRoadmapAmount(
  goalId: string,
  planRef: PeriodRef,
  context: AppContext,
): Promise<number | null> {
  const paces = await getGoalRoadmapAmounts(planRef, context);
  return paces.find((pace) => pace.goalId === goalId)?.amount ?? null;
}

/**
 * One goal's standing in one period: its plan (pace, scheduled, by hand,
 * planned, contributed) with the two statements read off it (decision 5.3,
 * option C). What the goal page's notes read, and what the Inbox's goal
 * detector (src/lib/insights.ts) reads to say the same thing - one
 * computation, two surfaces.
 *
 *   "plan"     the plan period (periodClock's `plan`): its planning
 *              statement, and its follow-through once its last days come
 *   "earlier"  the current period while it precedes the plan period (from
 *              payday to its end) and the period before it, once ended:
 *              their follow-through statement only
 */
export interface GoalRoadmapStatus extends GoalPeriodPlan {
  role: "plan" | "earlier";
  /** byHand - planned, for a dated goal with a confirmed plan in the plan period; 0 otherwise. */
  planningShortfall: number;
  /** byHand - what the room let the plan recommend at confirm, for the same goals; 0 otherwise. */
  roomShortfall: number;
  /** Planned (by hand and scheduled) but neither contributed nor still to post; 0 unless the period is in its last days or over (followThroughDue). */
  followThroughShortfall: number;
}

/**
 * Every goal's status in the periods the goal notes speak about: the plan
 * period for each goal still being saved for or with a confirmed plan there,
 * and each earlier period (see GoalRoadmapStatus) where a confirmed plan's
 * follow-through is due and short. Plan-period statuses first, in the
 * check-in's funding order.
 */
export async function getGoalRoadmapStatuses(context: AppContext): Promise<GoalRoadmapStatus[]> {
  const clock = periodClock(context.today);
  const earlier = [
    ...(clock.current.key !== clock.plan.key ? [clock.current] : []),
    periodInfo(previousPeriod(clock.current)),
  ];
  const plans = await loadGoalPeriodPlans([clock.plan, ...earlier], context);

  const statuses: GoalRoadmapStatus[] = [];
  const statusOf = (plan: GoalPeriodPlan, role: GoalRoadmapStatus["role"]): GoalRoadmapStatus => {
    const judged = role === "plan" && plan.open && plan.targetDate !== null;
    return {
      ...plan,
      role,
      planningShortfall: judged ? planningShortfall(plan) : 0,
      roomShortfall: judged ? roomShortfall(plan) : 0,
      followThroughShortfall:
        !plan.achievedAt && followThroughDue(plan.period, clock.today) ? followThroughShortfall(plan) : 0,
    };
  };
  for (const plan of plans.get(clock.plan.key) ?? []) {
    if (plan.open || plan.planned !== null && plan.planned > 0) statuses.push(statusOf(plan, "plan"));
  }
  for (const period of earlier) {
    for (const plan of plans.get(period.key) ?? []) {
      const status = statusOf(plan, "earlier");
      if (status.followThroughShortfall > 0) statuses.push(status);
    }
  }
  return statuses;
}

/** The plan-period status of one goal; null when it has neither a pace nor a confirmed plan this period (or does not exist). */
export async function getGoalRoadmapStatus(
  goalId: string,
  context: AppContext,
): Promise<GoalRoadmapStatus | null> {
  const statuses = await getGoalRoadmapStatuses(context);
  return statuses.find((status) => status.goalId === goalId && status.role === "plan") ?? null;
}

/**
 * The carryover a check-in for `planRef` is offered: what the period before
 * it leaves (periodLeftover - its plan's room, or its budget when it had no
 * confirmed plan, less its budget spending, never below 0; nothing when it
 * had neither), and whether that is still provisional because the period
 * has not ended.
 */
export async function getAvailableCarryover(
  planRef: PeriodRef,
  context: AppContext,
): Promise<{ amount: number; basis: CarryoverBasis; provisional: boolean; settlesAfter: Date }> {
  const previous = periodInfo(previousPeriod(planRef));
  const leftover = await periodLeftover(previous, context);
  return {
    ...leftover,
    provisional: carryoverIsProvisional(previous.end, context.today),
    settlesAfter: previous.end,
  };
}

/**
 * K8: what Step 1 reconciles each account against for the check-in of
 * `planRef` - the ledger as of the day before that period's pay landed (its
 * funding window's start, src/lib/period.ts), without this check-in's own
 * paycheck rows (`paycheckIds`). Spending after the pay, and rows dated
 * later, are not in it: the reported balance is what the account held
 * before this period's income, and a check-in opened days after payday is
 * measured against that same day. The same figure on a first confirm and a
 * re-confirm, which only adds rows after it.
 *
 * Nor is any of the period's income (S6): the deposits Step 2 lists - the
 * ones the check-in adopts on active accounts, `deposits` (loaded when
 * absent) - are left out of it like the check-in's own paycheck, whatever
 * day they landed. A small transfer landing in the lead days, before the
 * pay opens the funding window, is this period's income; inside the
 * balance it would also fill a hole the reconciliation cap measures, and
 * the plan would count it twice. Everything else up to that day stays in,
 * the lead days' spending included, on every account.
 */
export async function reconciliationLedger(
  planRef: PeriodRef,
  context: Pick<AppContext, "rates" | "today">,
  options: {
    paycheckIds?: readonly string[];
    client?: Prisma.TransactionClient;
    deposits?: ReadonlyMap<string, readonly LedgerDeposit[]>;
  } = {},
): Promise<{ date: Date; byAccount: Map<string, number> }> {
  const client = options.client ?? prisma;
  const [payLanded, deposits] = await Promise.all([
    loadPayLanded([planRef], context),
    options.deposits ??
      (async () => {
        const [listed, active] = await Promise.all([
          loadLedgerDeposits(planRef, context, { client }),
          client.account.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
        ]);
        return new Map(active.map((account) => [account.id, listed.byAccount.get(account.id) ?? []]));
      })(),
  ]);
  const date = addDays(fundingWindow(planRef, payLanded).from, -1);
  const adoptedIds = [...deposits.values()].flat().map((deposit) => deposit.transactionId);
  const byAccount = await ledgerAt(date, context, {
    excludeIds: [...(options.paycheckIds ?? []), ...adoptedIds],
    client: options.client,
  });
  return { date, byAccount };
}

/** A partly covered item's outstanding occurrences in their account's currency (see PaydayCommittedDraft.outstandingInAccount); nothing for one nothing covers. */
function outstandingInAccountOf(
  group: readonly CommitmentOccurrence[],
  rates: RateTable,
): Pick<PaydayCommittedDraft, "outstandingInAccount"> {
  const owed = group.filter((occurrence) => occurrence.status === "outstanding");
  if (owed.length === 0 || !group.some((occurrence) => occurrence.earmarks.length > 0)) return {};
  const currency = owed[0].currency;
  return { outstandingInAccount: { amount: round2(sumOccurrences(owed, currency, rates, outstandingAmount)), currency } };
}

/** An item's earmarks over its occurrences, one entry per deposit and currency, in the order the deposits arrived. */
function coveredBy(group: readonly CommitmentOccurrence[]): OccurrenceEarmark[] {
  const byDeposit = new Map<string, OccurrenceEarmark>();
  for (const earmark of group.flatMap((occurrence) => occurrence.earmarks)) {
    const key = `${earmark.transactionId}|${earmark.currency}`;
    const entry = byDeposit.get(key);
    if (entry) entry.amount = round2(entry.amount + earmark.amount);
    else byDeposit.set(key, { ...earmark });
  }
  return [...byDeposit.values()].sort(
    (a, b) => a.depositDate.getTime() - b.depositDate.getTime() || a.transactionId.localeCompare(b.transactionId),
  );
}

/**
 * The plan period's occurrences as the wizard lists them: one row per item,
 * subscriptions and contributions apart, plus the items posting will skip.
 * Every figure is the period's commitments (src/lib/period-commitments.ts):
 * an occurrence counts once, at the ledger's amount when posting has already
 * written or settled it, and whether a charge the user entered paid it is
 * posting's own settlement plan's verdict, never decided here.
 */
export function committedDrafts(
  commitments: readonly CommitmentOccurrence[],
  context: Pick<AppContext, "displayCurrency" | "rates">,
): { subscriptions: PaydayCommittedDraft[]; contributions: PaydayCommittedDraft[]; wontPost: PaydayWontPostDraft[] } {
  const rows = byItem(whole(commitments)).map((group): { kind: string; row: PaydayCommittedDraft } => {
    const first = group[0];
    const scheduled = group.filter((occurrence) => occurrence.source === "schedule");
    const paid = group.filter((occurrence) => occurrence.status !== "outstanding");
    const paidByAccount = new Map<string, { accountId: string | null; amount: number; currency: string }>();
    for (const occurrence of paid) {
      const key = `${occurrence.accountId ?? ""}|${occurrence.currency}`;
      const portion = paidByAccount.get(key) ?? { accountId: occurrence.accountId, amount: 0, currency: occurrence.currency };
      portion.amount += wholeAmount(occurrence);
      paidByAccount.set(key, portion);
    }
    const inDisplay = (amountOf: (occurrence: CommitmentOccurrence) => number) =>
      round2(sumOccurrences(group, context.displayCurrency, context.rates, amountOf));
    const inItemCurrency = (amountOf: (occurrence: CommitmentOccurrence) => number) =>
      round2(sumOccurrences(group, first.itemCurrency, context.rates, amountOf));
    return {
      kind: first.kind,
      row: {
        recurringItemId: first.itemId,
        name: first.name,
        amount: inDisplay(wholeAmount),
        nativeAmount: inItemCurrency(wholeAmount),
        perOccurrenceAmount: first.itemAmount,
        occurrenceCount: scheduled.length,
        currency: first.itemCurrency,
        nextDate: first.dueDate,
        overdue: group.some((occurrence) => occurrence.backlog),
        loggedOccurrences: scheduled.filter((occurrence) => occurrence.status !== "outstanding").length,
        ledgerOccurrences: group.length - scheduled.length,
        outstandingAmount: inDisplay(outstandingAmount),
        outstandingNativeAmount: inItemCurrency(outstandingAmount),
        alreadyLogged: paid.length === group.length,
        paidPortions: [...paidByAccount.values()].map((portion) => ({ ...portion, amount: round2(portion.amount) })),
        accountId: scheduled.find((occurrence) => occurrence.status === "outstanding")?.accountId ?? first.accountId,
        covered: coveredBy(group),
        ...outstandingInAccountOf(group, context.rates),
      },
    };
  });
  return {
    subscriptions: rows.filter((entry) => entry.kind === "SUBSCRIPTION").map((entry) => entry.row),
    contributions: rows.filter((entry) => entry.kind === "CONTRIBUTION").map((entry) => entry.row),
    wontPost: byItem(wontPost(commitments)).map((group) => {
      const first = group[0];
      const amountOf = (occurrence: CommitmentOccurrence) => occurrence.amount;
      return {
        recurringItemId: first.itemId,
        name: first.name,
        kind: first.kind,
        reason: first.wontPostReason as RecurringSkipReason,
        nextDate: first.dueDate,
        occurrenceCount: group.length,
        amount: round2(sumOccurrences(group, context.displayCurrency, context.rates, amountOf)),
        nativeAmount: round2(sumOccurrences(group, first.itemCurrency, context.rates, amountOf)),
        currency: first.itemCurrency,
      };
    }),
  };
}

/** A confirmed check-in's GOAL allocation, as getPaydayCheckinDraft reads it back. */
interface ConfirmedGoalAllocation {
  accountId: string | null;
  plannedAmount: unknown;
  recommendedAmount: unknown;
  currency: string;
}

/**
 * The confirmed GOAL rows of goals that are no longer being saved for
 * (reached, or with nothing left) but still exist - the plan confirmed their
 * draws for this period, and those stay counted. `open` holds the goals the
 * draft still funds.
 */
function reachedGoalDrafts(
  confirmed: ReadonlyMap<string, ConfirmedGoalAllocation[]>,
  goals: readonly { id: string; name: string }[],
  open: ReadonlySet<string>,
  context: Pick<AppContext, "displayCurrency" | "rates">,
): PaydayReachedGoalDraft[] {
  const nameById = new Map(goals.map((goal) => [goal.id, goal.name]));
  return [...confirmed.entries()]
    .filter(([goalId]) => nameById.has(goalId) && !open.has(goalId))
    .map(([goalId, rows]) => ({
      goalId,
      name: nameById.get(goalId)!,
      plannedAmount: round2(
        rows.reduce(
          (sum, row) => sum + convert(num(row.plannedAmount as never), row.currency, context.displayCurrency, context.rates),
          0,
        ),
      ),
      rows: rows.map((row) => ({
        accountId: row.accountId,
        plannedAmount: num(row.plannedAmount as never),
        recommendedAmount: num(row.recommendedAmount as never),
        currency: row.currency,
      })),
    }));
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
  // The confirmed check-in's carryover as the confirmed card shows it: settled
  // once its period ended, and kept in step with it since (R8).
  await settleCarryovers([planRef], context);

  const [
    accounts,
    planSummary,
    allGoals,
    essentialCategoryRows,
    flexibleCategoryRows,
    carryover,
    settings,
    existing,
    existingBudgetRows,
    goalPlans,
    ledgerDeposits,
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
    prisma.budget.findMany({
      where: { year: planRef.year, month: planRef.month, period: planRef.period, categoryId: { not: null } },
    }),
    goalPeriodPlans(plan, context),
    loadLedgerDeposits(planRef, context),
  ]);

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
  // The deposits Step 2 lists: those on active accounts (an archived one is
  // not edited).
  const activeAccountIds = accounts.filter((account) => account.status === "ACTIVE").map((account) => account.id);
  const listedDeposits = new Map(activeAccountIds.map((id) => [id, ledgerDeposits.byAccount.get(id) ?? []]));
  // Step 1's ledger (K8): each account as of the day before this period's pay
  // landed, without this check-in's own paychecks or the deposits Step 2
  // lists (S6).
  const ledger = await reconciliationLedger(planRef, context, {
    paycheckIds: (existing?.snapshots ?? []).flatMap((s) => (s.incomeTransactionId ? [s.incomeTransactionId] : [])),
    deposits: listedDeposits,
  });
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

  // The paychecks a confirmed check-in recorded that still exist: confirming
  // again updates those rows, and creates one only where there is none.
  const recordedIncomeIds = new Set(
    (
      await prisma.transaction.findMany({
        where: { id: { in: (existing?.snapshots ?? []).flatMap((s) => (s.incomeTransactionId ? [s.incomeTransactionId] : [])) } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  // Active accounts are always offered; an archived one appears only when this
  // check-in already recorded something for it, and then read-only.
  const draftableAccounts = accounts.filter(
    (account) => account.status === "ACTIVE" || existingSnapshotByAccount.has(account.id),
  );
  const accountDrafts: PaydayAccountDraft[] = draftableAccounts.map((account) => {
    const snapshot = existingSnapshotByAccount.get(account.id);
    const readOnly = account.status !== "ACTIVE";
    const deposits = readOnly ? [] : (ledgerDeposits.byAccount.get(account.id) ?? []);
    const inLedger = ledgerDepositsTotal(deposits);
    // The paycheck as the period now counts it: the deposits the ledger holds
    // for it, plus what a confirmed check-in recorded beyond the ones it
    // adopted - so reopening shows the same figure, and confirming it again
    // writes nothing new.
    const incomeEntered = !snapshot
      ? inLedger
      : readOnly
        ? num(snapshot.incomeEntered)
        : round2(num(snapshot.incomeEntered) - num(snapshot.adoptedIncome ?? 0) + inLedger);
    return {
      readOnly,
      accountId: account.id,
      name: account.name,
      currency: account.currency,
      type: account.type,
      // The ledger balance to reconcile against is the one *before* this
      // period's pay landed (reconciliationLedger): not today's, which would
      // hold the paycheck this very screen is recording and whatever was
      // spent since, so a late first check-in would pre-fill the period's own
      // spending as a shortfall (D41).
      expectedLedgerBalance: ledger.byAccount.get(account.id) ?? 0,
      reportedBalance: snapshot ? num(snapshot.reportedBalance) : (ledger.byAccount.get(account.id) ?? 0),
      incomeEntered,
      oneOffIncome: snapshot?.oneOffIncome ? Math.min(num(snapshot.oneOffIncome), incomeEntered) : 0,
      incomeNote: snapshot?.incomeNote ?? "",
      hasIncomeTransaction: Boolean(snapshot?.incomeTransactionId && recordedIncomeIds.has(snapshot.incomeTransactionId)),
      ledgerDeposits: deposits,
      ledgerDepositsTotal: inLedger,
      ledgerDepositsSetAside: readOnly ? 0 : (ledgerDeposits.setAside.get(account.id) ?? 0),
      // Each account's buffer is computed in its own currency, so the floor
      // has to be converted once per account rather than to the display
      // currency and then compared across currencies.
      bufferFloor: round2(
        convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, account.currency, context.rates),
      ),
    };
  });

  // The period's whole commitments, posted and paid occurrences included:
  // the income they are set against is the whole period's paycheck, so a
  // check-in opened after rent posted still takes the rent out of it.
  const { subscriptions, contributions, wontPost } = committedDrafts(planSummary.commitments, context);
  const subscriptionsTotal = round2(subscriptions.reduce((sum, i) => sum + i.amount, 0));
  const contributionsTotal = round2(contributions.reduce((sum, i) => sum + i.amount, 0));

  // The buffer is a recommendation per income account, not a stored choice, so
  // it is always recomputed from the income in this draft - never read back
  // from the confirmed check-in's BUFFER allocations. Goal funding below draws
  // on the headroom this leaves each account.
  const bufferPlan = draftAccountBuffers(
    {
      accounts: accountDrafts,
      subscriptions,
      contributions,
      bufferPercent: settings.bufferPercent,
      displayCurrency: context.displayCurrency,
    },
    context.rates,
  );
  const plannedBuffer = bufferPlan.total;

  // Every goal still being saved for, dated or not: an undated goal has no
  // pace, so its recommendation is the whole remaining balance and the
  // funding split below caps it by whatever room the goals before it leave.
  // Each goal's plan for the period being planned (K3): what it asks by hand,
  // net of the recurring contributions already scheduled in it - a goal fed
  // automatically does not also need that much set aside, or the plan would
  // hold the same money twice.
  const planByGoal = new Map(goalPlans.map((goalPlan) => [goalPlan.goalId, goalPlan]));
  const roadmapGoals = allGoals
    .filter((g) => !g.achievedAt && g.remaining > 0 && planByGoal.has(g.id))
    .map((g) => {
      const goalPlan = planByGoal.get(g.id)!;
      const periodsLeft = goalPlan.periodsLeft === null ? null : Math.max(1, goalPlan.periodsLeft);
      return { goal: g, periodsLeft, recommendedAmount: goalPlan.byHand, pace: goalPlan.pace, scheduled: goalPlan.scheduled };
    });
  const reachedGoals = reachedGoalDrafts(
    existingGoalAllocations,
    allGoals,
    new Set(roadmapGoals.map((entry) => entry.goal.id)),
    context,
  );
  // Which accounts each goal's roadmap amount is recommended to come from,
  // goals in this order sharing one pool of headroom (see planGoalFunding),
  // after the draws a goal reached since confirming already took from it.
  const fundingPlanByGoal = new Map(
    planGoalFunding(
      [
        ...reachedGoalFunding(reachedGoals),
        ...roadmapGoals.map((entry) => ({ goalId: entry.goal.id, amount: entry.recommendedAmount })),
      ],
      bufferPlan.accounts,
      { displayCurrency: context.displayCurrency, rates: context.rates },
    ).map((fundingPlan) => [fundingPlan.goalId, fundingPlan]),
  );
  const accountCurrencyById = new Map(accountDrafts.map((account) => [account.accountId, account.currency]));
  const goals: PaydayGoalDraft[] = roadmapGoals.map(({ goal: g, periodsLeft, recommendedAmount, pace, scheduled }) => {
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
      targetDate: g.targetDate,
      periodsLeft,
      pace,
      scheduled,
    };
  });

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

  const includedCarryover = existing
    ? round2(convert(num(existing.includedCarryover), existing.currency, context.displayCurrency, context.rates))
    : settings.carryoverIncludedByDefault
      ? carryover.amount
      : 0;
  const carryoverRow = existing?.allocations.find((allocation) => allocation.type === "CARRYOVER");
  const carryoverIncluded = existing
    ? carryoverRow
      ? carryoverRowIncluded({ basis: carryoverRow.basis, plannedAmount: num(carryoverRow.plannedAmount) })
      : includedCarryover > 0
    : settings.carryoverIncludedByDefault && carryover.basis === "prior_period_budget";
  const carryoverAdjustment = carryoverAdjustmentFor(carryoverRow, planRef, context);

  // The confirmed plan's income as it stands (S7): each paycheck moved by
  // what the deposits it adopted are as pay now - the figure the confirmed
  // card shows, with this line beside it when it moved.
  const incomeMoved = round2(
    (existing?.snapshots ?? []).reduce((sum, snapshot) => {
      const now = paycheckNow(
        { incomeEntered: num(snapshot.incomeEntered), adoptedIncome: num(snapshot.adoptedIncome ?? 0), adoptedTransactionIds: snapshot.adoptedTransactionIds },
        (id) => ledgerDeposits.byAccount.get(snapshot.accountId)?.find((deposit) => deposit.transactionId === id)?.amount ?? 0,
      );
      return sum + convert(now - num(snapshot.incomeEntered), snapshot.currency, context.displayCurrency, context.rates);
    }, 0),
  );
  const confirmedIncome = existing ? round2(convert(num(existing.totalIncome), existing.currency, context.displayCurrency, context.rates)) : 0;
  const incomeAdjustment: IncomeAdjustment | null =
    existing && Math.abs(incomeMoved) >= 0.005
      ? { confirmed: confirmedIncome, current: round2(confirmedIncome + incomeMoved), by: incomeMoved }
      : null;

  // Raw suggestions, deliberately not scaled to what the plan has available:
  // on a fresh check-in no income has been entered yet, so that figure is at
  // best the carryover and scaling against it zeroed every suggestion. The
  // wizard resolves these rows live against the income it records
  // (resolveFlexibleCategories), the same way it resolves goal funding.
  const flexibleCategories: PaydayFlexibleCategoryDraft[] = flexibleCategoryRows.map((category) => {
    const suggestion = suggestionsByCategory.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`FLEXIBLE_CATEGORY:${category.id}`);
    const existingPlanned =
      existingBudgetByCategory.get(category.id) ??
      (existingAlloc
        ? round2(convert(num(existingAlloc.plannedAmount), existingAlloc.currency, context.displayCurrency, context.rates))
        : undefined);
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: suggestion.amount,
      plannedAmount: existingPlanned ?? suggestion.amount,
      basis: suggestion.basis,
      held: existingPlanned !== undefined,
    };
  });

  return {
    periodRef: planRef,
    period: plan,
    ledgerDate: ledger.date,
    isEditingConfirmed: Boolean(existing),
    checkinId: existing?.id ?? null,
    displayCurrency: context.displayCurrency,
    accounts: accountDrafts,
    subscriptions,
    contributions,
    subscriptionsTotal,
    contributionsTotal,
    wontPost,
    goals,
    reachedGoals,
    essentialCategories,
    flexibleCategories,
    bufferPercent: settings.bufferPercent,
    plannedBuffer,
    availableCarryover: carryover.amount,
    carryoverBasis: carryover.basis,
    includedCarryover,
    carryoverIncluded,
    carryoverProvisional: carryover.provisional,
    carryoverSettlesAfter: carryover.settlesAfter,
    carryoverAdjustment,
    incomeAdjustment,
    depositsVersion: ledgerDepositsVersion(ledgerDeposits.byAccount, activeAccountIds),
    checkinVersion: existing ? existing.updatedAt.toISOString() : null,
    today: context.today,
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

/**
 * What confirm did to the flexible budgets when a reconciliation gap capped
 * the plan below what was submitted: they were scaled down proportionally
 * from `from` to `to` (both in `currency`, the check-in's display currency)
 * before being written. The action turns this into the success message, so
 * the adjustment is never silent.
 */
export interface FlexibleScaling {
  from: number;
  to: number;
  currency: string;
}

/** An account whose paycheck was typed below the deposits the ledger already holds for the period (R1), in its own currency. */
export interface BelowLedgerAccount {
  accountId: string;
  name: string;
  currency: string;
  incomeEntered: number;
  inLedger: number;
}

export type ConfirmPaydayCheckinResult =
  | { ok: true; flexibleScaled: FlexibleScaling | null }
  | { ok: false; reason: "no_active_accounts" }
  /** Another confirmation of the same period landed while this one was being measured (B37): nothing was written. */
  | { ok: false; reason: "confirmed_meanwhile" }
  /**
   * The stored check-in is not the one the wizard was opened on
   * (input.checkinVersion): another tab or window confirmed it since.
   * Nothing was written; the user reloads to see that plan.
   */
  | { ok: false; reason: "changed_since_loaded" }
  /**
   * The deposits Step 2 listed are not the ones the ledger holds now
   * (input.depositsVersion, S2): one was earmarked, edited, deleted, marked
   * one-off or added since the wizard was opened. Nothing was written; the
   * user reloads to see them.
   */
  | { ok: false; reason: "deposits_changed" }
  /**
   * A paycheck was typed below what the ledger already holds for the period
   * on that account (R1): the check-in adopts those deposits and never edits
   * or deletes them, so it cannot record less. Nothing was written.
   */
  | { ok: false; reason: "below_ledger_deposits"; accounts: BelowLedgerAccount[] }
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
    existingCheckin,
    goalPlans,
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
    // Read before the write so income already recorded for an account archived
    // since can be carried into the totals rather than dropped, and so the
    // draws of a goal reached since confirming stay in the plan.
    prisma.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        snapshots: {
          select: { accountId: true, incomeEntered: true, reportedBalance: true, currency: true, adoptedIncome: true, adoptedTransactionIds: true },
        },
        allocations: {
          where: { OR: [{ type: "GOAL", goalId: { not: null } }, { type: "BUFFER" }] },
          select: { type: true, goalId: true, accountId: true, plannedAmount: true, recommendedAmount: true, currency: true },
        },
      },
    }),
    goalPeriodPlans(plan, context),
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

  // R1: a paycheck is never less than the deposits the ledger already holds
  // for it - the check-in adopts those as they are. Checked again under the
  // lock below, against the deposits read there.
  const belowLedger = (deposits: ReadonlyMap<string, LedgerDeposit[]>): BelowLedgerAccount[] =>
    accountInputs.flatMap((a) => {
      const inLedger = ledgerDepositsTotal(deposits.get(a.accountId));
      if (ledgerDepositsIssue(a.incomeEntered, inLedger) === null) return [];
      const account = liveAccountById.get(a.accountId)!;
      return [{ accountId: account.id, name: account.name, currency: account.currency, incomeEntered: a.incomeEntered, inLedger }];
    });
  // S2: the deposits are the ones Step 2 listed, or nothing is written -
  // checked here and again under the lock below.
  const depositsChanged = (deposits: ReadonlyMap<string, LedgerDeposit[]>) =>
    input.depositsVersion !== undefined && input.depositsVersion !== ledgerDepositsVersion(deposits, liveAccountById.keys());
  const depositsBefore = (await loadLedgerDeposits(planRef, context)).byAccount;
  if (depositsChanged(depositsBefore)) return { ok: false, reason: "deposits_changed" };
  const refusedForLedger = belowLedger(depositsBefore);
  if (refusedForLedger.length > 0) return { ok: false, reason: "below_ledger_deposits", accounts: refusedForLedger };

  // Income recorded against an account that has since been archived. Its
  // snapshot is left untouched below, so the figure it holds has to keep
  // counting here too or re-confirming would quietly write it out of the plan.
  const archivedIncome = (existingCheckin?.snapshots ?? [])
    .filter((snapshot) => !liveAccountById.has(snapshot.accountId))
    .reduce(
      (sum, snapshot) =>
        sum + convert(num(snapshot.incomeEntered), snapshot.currency, context.displayCurrency, context.rates),
      0,
    );
  // What such a paycheck moved since, by the deposits it adopted (S7): the
  // confirmed room counts it, so the deficit check below does too. The
  // stored totalIncome keeps the paychecks as entered, which is what the
  // room moves from.
  const archivedIncomeMoved = (existingCheckin?.snapshots ?? [])
    .filter((snapshot) => !liveAccountById.has(snapshot.accountId))
    .reduce((sum, snapshot) => {
      const now = paycheckNow(
        { incomeEntered: num(snapshot.incomeEntered), adoptedIncome: num(snapshot.adoptedIncome ?? 0), adoptedTransactionIds: snapshot.adoptedTransactionIds },
        (id) => depositsBefore.get(snapshot.accountId)?.find((deposit) => deposit.transactionId === id)?.amount ?? 0,
      );
      return sum + convert(now - num(snapshot.incomeEntered), snapshot.currency, context.displayCurrency, context.rates);
    }, 0);
  const totalIncome = round2(
    accountInputs.reduce((sum, a) => {
      const account = liveAccountById.get(a.accountId)!;
      return sum + convert(a.incomeEntered, account.currency, context.displayCurrency, context.rates);
    }, archivedIncome),
  );
  // R22: an account archived since it received income keeps the buffer the
  // check-in stored on it and its reconciliation gap (what it was below zero
  // before the pay), exactly as the confirmed room reads them - written back
  // unchanged, and both in the deficit check, as before it was archived.
  const archivedWithIncome = new Set(
    (existingCheckin?.snapshots ?? [])
      .filter((snapshot) => !liveAccountById.has(snapshot.accountId) && num(snapshot.incomeEntered) > 0)
      .map((snapshot) => snapshot.accountId),
  );
  const archivedBufferRows = (existingCheckin?.allocations ?? []).filter(
    (allocation) => allocation.type === "BUFFER" && allocation.accountId !== null && archivedWithIncome.has(allocation.accountId),
  );
  const archivedBuffer = round2(
    archivedBufferRows.reduce(
      (sum, row) => sum + convert(num(row.plannedAmount), row.currency, context.displayCurrency, context.rates),
      0,
    ),
  );
  const archivedGap = round2(
    (existingCheckin?.snapshots ?? [])
      .filter((snapshot) => archivedWithIncome.has(snapshot.accountId))
      .reduce(
        (sum, snapshot) =>
          sum + convert(Math.max(0, -num(snapshot.reportedBalance)), snapshot.currency, context.displayCurrency, context.rates),
        0,
      ),
  );

  // The same period commitments the draft showed, recomputed here from live
  // data rather than trusted from the client.
  const { subscriptions: subscriptionDrafts, contributions: contributionDrafts } = committedDrafts(
    planSummary.commitments,
    context,
  );
  const subscriptionsTotal = round2(subscriptionDrafts.reduce((sum, i) => sum + i.amount, 0));
  const contributionsTotal = round2(contributionDrafts.reduce((sum, i) => sum + i.amount, 0));

  const goalById = new Map(allGoals.map((g) => [g.id, g]));
  // Dated or not, as the draft lists them; an achieved goal's funding is
  // dropped, as is funding for a goal that no longer exists.
  const goalInputs = input.goals.filter((g) => {
    const goal = goalById.get(g.goalId);
    return Boolean(goal && !goal.achievedAt);
  });

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
        // Step 1's figure, so the same reconciliation gap Step 3 showed caps
        // the plan here too - the client's arithmetic is never trusted for it.
        reportedBalance: a.reportedBalance,
      };
    }),
    commitmentPortions([...subscriptionDrafts, ...contributionDrafts]),
    { bufferPercent: context.bufferPercent, displayCurrency: context.displayCurrency, rates: context.rates },
  );
  const protectedBuffer = round2(bufferPlan.total + archivedBuffer);
  const reconciliationGap = round2(bufferPlan.reconciliationGap + archivedGap);

  // Each goal's roadmap amount for the period being confirmed - its plan's
  // byHand, exactly as getPaydayCheckinDraft reads it - and then where that amount
  // is recommended to come from: the same headroom Step 3 showed, shared
  // between the goals in this order (see planGoalFunding). Each goal's
  // submitted rows go in as held, exactly what the wizard fed the live pool:
  // a later goal's recommendation is then the one Step 3 showed after the
  // goals above it were edited, not a context-free figure. An unedited row's
  // submitted amount is that recommendation itself, so passing every row as
  // held draws the same pool the client did.
  const byHandByGoal = new Map(goalPlans.map((goalPlan) => [goalPlan.goalId, goalPlan.byHand]));
  const roadmapByGoal = new Map(goalInputs.map((g) => [g.goalId, byHandByGoal.get(g.goalId) ?? 0]));
  // A goal reached since the check-in was confirmed keeps its confirmed draws,
  // as the draft showed them: written back unchanged below, and taken from
  // the pool before the goals still being funded share what is left.
  const confirmedGoalAllocations = new Map<string, ConfirmedGoalAllocation[]>();
  if (existingCheckin?.status === "CONFIRMED") {
    for (const allocation of existingCheckin.allocations) {
      if (allocation.type !== "GOAL") continue;
      const goalId = allocation.goalId as string;
      confirmedGoalAllocations.set(goalId, [...(confirmedGoalAllocations.get(goalId) ?? []), allocation]);
    }
  }
  const reachedGoals = reachedGoalDrafts(
    confirmedGoalAllocations,
    allGoals,
    new Set(allGoals.filter((goal) => !goal.achievedAt && goal.remaining > 0).map((goal) => goal.id)),
    context,
  );
  const fundingPlanByGoal = new Map(
    planGoalFunding(
      [
        ...reachedGoalFunding(reachedGoals),
        ...goalInputs.map((g) => ({
        goalId: g.goalId,
        amount: roadmapByGoal.get(g.goalId)!,
        funding: g.funding
          .filter((row) => liveAccountById.has(row.accountId))
          .map((row) => ({ accountId: row.accountId, plannedAmount: row.plannedAmount, held: true })),
        })),
      ],
      bufferPlan.accounts,
      { displayCurrency: context.displayCurrency, rates: context.rates },
    ).map((fundingPlan) => [fundingPlan.goalId, fundingPlan]),
  );
  // One row per (goal, account) with either amount above zero, in the
  // account's own currency: the user's figure for that account is trusted like
  // every other planned value, and sits next to what the recommendation said.
  // A row the user zeroed keeps the recommendation on record; a row for an
  // account the recommendation skipped keeps the user's figure.
  const goalRows: { goalId: string; accountId: string | null; currency: string; recommendedAmount: number; plannedAmount: number }[] = goalInputs.flatMap((g) => {
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
  for (const goal of reachedGoals) {
    for (const row of goal.rows) goalRows.push({ goalId: goal.goalId, ...row });
  }
  const goalPlanTotal = round2(
    goalRows.reduce(
      (sum, row) => sum + convert(row.plannedAmount, row.currency, context.displayCurrency, context.rates),
      0,
    ),
  );

  // The wizard only ever offers "all of it" or "none of it", so anything else -
  // most realistically a draft left open while the previous period kept moving -
  // is clamped to what this run actually measured before it is used or stored.
  // Whether it is taken at all is the switch (input.carryoverIncluded); a
  // caller that does not send it takes a carryover above 0.
  const carryoverTaken = input.carryoverIncluded ?? input.includedCarryover > 0;
  const includedCarryover = carryoverTaken
    ? round2(Math.min(Math.max(0, input.includedCarryover), carryover.amount))
    : 0;
  // Taken before the period it comes from has ended, it is provisional
  // (decision 3): stored as chosen, counted as 0 until that period is over
  // and its final leftover settles it (src/lib/data/flexible-room.ts).
  const carryoverProvisional = carryover.provisional && carryoverTaken;
  // Taken at 0 after that period ended, it is still taken (S5): its basis
  // says so, and it follows what that period leaves.
  const carryoverBasis = carryoverProvisional
    ? PROVISIONAL_CARRYOVER_BASIS
    : carryoverTaken && includedCarryover === 0
      ? INCLUDED_AT_ZERO_CARRYOVER_BASIS
      : carryover.basis;

  const available = availableForFlexibleCategories({
    income: round2(totalIncome + archivedIncomeMoved),
    includedCarryover: carryoverProvisional ? 0 : includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: protectedBuffer,
    reconciliationGap,
  });

  // Only a reconciliation gap ever scales what is written: the Dashboard's
  // safe-to-spend reads the Budget rows below, so a plan the accounts cannot
  // really support must not land there as typed. Without a gap an
  // acknowledged over-allocation is written exactly as submitted, as it
  // always was. Same proportional scale and largest-row rounding as Step 4's
  // suggestions, so the written rows sum to exactly the capped figure.
  const flexibleCap = Math.max(0, available);
  const scalingNeeded = reconciliationGap > 0 && flexibleTotal > flexibleCap;
  const scaledFlexibleById = scalingNeeded
    ? new Map(
        scaleFlexibleSuggestions(
          flexibleInputs.map((c) => ({ id: c.categoryId, suggested: c.plannedAmount })),
          flexibleCap,
        ).map((s) => [s.id, s.scaled]),
      )
    : null;
  const flexibleWritten = flexibleInputs.map((c) => ({
    ...c,
    plannedAmount: scaledFlexibleById?.get(c.categoryId) ?? c.plannedAmount,
  }));
  const flexibleScaled: FlexibleScaling | null = scalingNeeded
    ? {
        from: flexibleTotal,
        to: round2(flexibleWritten.reduce((sum, c) => sum + c.plannedAmount, 0)),
        currency: context.displayCurrency,
      }
    : null;

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

  const readBeforeWriting = existingCheckin;
  const written = await prisma.$transaction(async (tx): Promise<true | "changed" | "changed_since_loaded" | "deposits_changed" | BelowLedgerAccount[]> => {
    // One confirmation of a period at a time (B37): a double submit or a
    // second window waits here for the first to commit. It then finds the
    // check-in changed since it read it and writes nothing - it planned
    // against figures the first one has since replaced, and its balances
    // would be read against a paycheck it did not record.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payday-checkin:${plan.key}`}))`;
    // upsert on the (year, month, period) unique key rather than find-then-
    // create: two confirmations of the same period racing each other used to
    // let both find nothing and the loser hit a raw constraint error.
    const existingCheckin = await tx.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
    });
    // The wizard was opened on another version of this check-in: a second
    // tab or window confirmed it since. Its plan is not overwritten.
    if (input.checkinVersion !== undefined) {
      const stored = existingCheckin?.status === "CONFIRMED" ? existingCheckin.updatedAt.toISOString() : null;
      if (stored !== input.checkinVersion) return "changed_since_loaded";
    }
    if ((existingCheckin?.updatedAt.getTime() ?? null) !== (readBeforeWriting?.updatedAt.getTime() ?? null)) {
      return "changed";
    }
    // R1: the deposits each paycheck adopts, read under the lock - the ones
    // Step 2 listed (S2), or nothing is written.
    const deposits = (await loadLedgerDeposits(planRef, context, { client: tx })).byAccount;
    if (depositsChanged(deposits)) return "deposits_changed";
    const refused = belowLedger(deposits);
    if (refused.length > 0) return refused;
    // The balances each snapshot reconciles against (K8), read under the lock
    // so they and the snapshot's own paycheck are one state of the ledger.
    const recorded = existingCheckin
      ? await tx.paydayAccountSnapshot.findMany({
          where: { paydayCheckinId: existingCheckin.id, incomeTransactionId: { not: null } },
          select: { incomeTransactionId: true },
        })
      : [];
    const ledger = await reconciliationLedger(planRef, context, {
      paycheckIds: recorded.map((snapshot) => snapshot.incomeTransactionId as string),
      client: tx,
      deposits: new Map([...liveAccountById.keys()].map((id) => [id, deposits.get(id) ?? []])),
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
      // Measured against the ledger before this period's pay (K8), so a
      // re-confirm reconciles against the same figure the first confirm did.
      const { expected: expectedLedgerBalance, difference } = reconciliation(
        ledger.byAccount.get(account.id) ?? 0,
        accountInput.reportedBalance,
      );

      // The deposits the ledger already holds for this paycheck are adopted
      // as they are (R1): the check-in's own row records only the rest.
      const adoptedIncome = ledgerDepositsTotal(deposits.get(account.id));
      // Which deposits, so the confirmed plan's income follows them as they
      // are from now on (paycheckNow, S7).
      const adoptedTransactionIds = (deposits.get(account.id) ?? []).map((deposit) => deposit.transactionId);
      const ownIncome = round2(accountInput.incomeEntered - adoptedIncome);
      let incomeTransactionId = existingSnapshot?.incomeTransactionId ?? null;
      if (ownIncome > 0) {
        let updated = { count: 0 };
        if (incomeTransactionId) {
          // Amount and note only: the paycheck keeps the date it was first
          // recorded with (see checkinDate above).
          updated = await tx.transaction.updateMany({
            where: { id: incomeTransactionId },
            data: { amount: ownIncome, note: accountInput.incomeNote },
          });
        }
        if (updated.count === 0) {
          const created = await tx.transaction.create({
            data: {
              date: checkinDate,
              amount: ownIncome,
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
        oneOffIncome: Math.min(accountInput.oneOffIncome ?? 0, accountInput.incomeEntered),
        adoptedIncome,
        adoptedTransactionIds,
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
      ...subscriptionDrafts.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "SUBSCRIPTION" as const,
        recurringItemId: item.recurringItemId,
        accountId: item.accountId,
        recommendedAmount: item.nativeAmount,
        plannedAmount: item.nativeAmount,
        currency: item.currency,
        basis: "recurring_item",
      })),
      ...contributionDrafts.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "RECURRING_CONTRIBUTION" as const,
        recurringItemId: item.recurringItemId,
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
      ...flexibleWritten.map((c) => ({
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
      // An archived account's buffer, as it was stored (R22).
      ...archivedBufferRows.map((row) => ({
        paydayCheckinId: checkin.id,
        type: "BUFFER" as const,
        accountId: row.accountId,
        recommendedAmount: num(row.recommendedAmount),
        plannedAmount: num(row.plannedAmount),
        currency: row.currency,
        basis: "buffer_formula",
      })),
      {
        paydayCheckinId: checkin.id,
        type: "CARRYOVER" as const,
        recommendedAmount: carryover.amount,
        plannedAmount: includedCarryover,
        currency: context.displayCurrency,
        basis: carryoverBasis,
      },
    ];
    await tx.paydayPlanAllocation.createMany({ data: allocationRows });

    for (const categoryInput of [...essentialInputs, ...flexibleWritten]) {
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
    return true;
  }, { maxWait: 10_000, timeout: 30_000 });
  if (written === "changed") return { ok: false, reason: "confirmed_meanwhile" };
  if (written === "changed_since_loaded") return { ok: false, reason: "changed_since_loaded" };
  if (written === "deposits_changed") return { ok: false, reason: "deposits_changed" };
  if (Array.isArray(written)) return { ok: false, reason: "below_ledger_deposits", accounts: written };

  return { ok: true, flexibleScaled };
}
