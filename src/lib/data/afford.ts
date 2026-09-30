/**
 * Projections and the confirm write for the Afford calculator.
 *
 * An installment lands in a pay period that has not happened yet, so there is
 * no confirmed payday check-in to read its income or buffer from. Each
 * affected period is projected instead:
 *
 *   income      history can only estimate this, so it uses the one averaging
 *               walk the app already has - getCategorySuggestions() in
 *               src/lib/data/payday.ts steps back through HISTORY_PERIODS
 *               comparable (same-half: A vs. B) periods - over what each
 *               account received (the same attribution getPeriodSummary uses:
 *               ordinary INCOME rows by date, plus the confirmed check-in's
 *               per-account income for the period rather than the check-in
 *               day's transaction - minus deposits that pay back a shared
 *               expense, which are not earnings, and income the user marked
 *               as one-off, which is not expected again; see loadPeriodIncome).
 *               Every account divides by the same count: the comparable
 *               periods since the oldest one with income in any account
 *               (incomeHistoryDepth), so pay that moved from one account to
 *               another is a real zero in the old one, not a gap to skip.
 *   committed   known exactly, not estimated: the period's commitments
 *               (src/lib/period-commitments.ts), whole - what already posted
 *               or was paid in it, at the ledger's amount, and every
 *               occurrence still ahead - the one definition the check-in,
 *               the period summary and every other reader of a period's
 *               recurring items share. A finite item stops at its
 *               countdown, and an item posting will skip is left out, as it
 *               will never charge anything. This is what lets a purchase
 *               recorded here a minute ago count against the next one
 *               before a single installment of it has posted. A period that
 *               already has a confirmed check-in adds the goal funding that
 *               check-in planned: money the user has committed to move
 *               toward a goal but may not have logged yet.
 *   goals       a period with no confirmed check-in has no such plan, but
 *               the user will most likely keep funding each dated goal: its
 *               period plan's by-hand figure (src/lib/goal-plan.ts - the
 *               pace fixed at the plan period's start, less that period's
 *               own recurring contributions, which are already among its
 *               commitments; the figure the Goals page shows and the
 *               check-in recommends) is assumed for it, spread over the
 *               accounts by projected headroom exactly as the check-in
 *               spreads it (planGoalFunding), and counted among the
 *               commitments - but carried separately as an estimate, and
 *               named on the results page as one. Unlike income (averaged
 *               from periods that happened) or a schedule (a fixed event),
 *               this is discretionary: the user adjusts it check-in to
 *               check-in, so it is never presented as confirmed. The pace is
 *               the plan period's, applied to every such period alike -
 *               walking the remaining balance down through periods that have
 *               not happened would stack guesses on guesses. An undated goal
 *               has no pace, only a whole balance, so it is estimated
 *               nothing (see projectPeriods).
 *   buffer      defaultProtectedBuffer() over the projected income, per
 *               account, as the check-in's per-account buffer card does
 *   essential   the essential fixed categories, filled the way the check-in
 *               fills them for the period: its saved budget, else a confirmed
 *               check-in's allocation, else getCategorySuggestions() (see
 *               loadEssentialFixed). The check-in keeps them period-wide; each
 *               account carries the share its projected income is of the
 *               period's.
 *
 * Installments dated before today are already paid: they are set aside before
 * anything is checked (evaluateAffordRequest) and never recorded.
 *
 * Nothing here reads a check-in for the periods being evaluated, and nothing
 * here writes until confirmAffordPurchase() - the calculator is a pure read
 * until "I bought this".
 */
import { cache } from "react";

import {
  buildInstallments,
  equalInstallmentAmount,
  evaluateAffordability,
  installmentDates,
  splitPaidInstallments,
  type AffordVerdict,
  type EssentialFixedBasis,
  type EstimatedGoalFunding,
  type PeriodProjection,
  type ProjectedGoalPlan,
} from "@/lib/afford";
import { remainingInstallments, type AffordTrackedItem } from "@/lib/afford-tracking";
import { getSettings } from "@/lib/auth";
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { countsInIncomeHistory, defaultProtectedBuffer, planGoalFunding } from "@/lib/payday";
import {
  goalWindow,
  nextPeriod,
  parsePeriodKey,
  periodClock,
  periodInfo,
  periodRange,
  previousComparablePeriod,
  type PeriodInfo,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { whole, type CommitmentOccurrence } from "@/lib/period-commitments";
import { reimbursedExpenseIdFromTransaction } from "@/lib/transactions";
import type { affordInputSchema } from "@/lib/validation";
import type { z } from "zod";

import { getAppContext } from "@/lib/data/context";
import { loadGoalPeriodPlans } from "@/lib/data/goal-plan";
import { loadCommitments } from "@/lib/data/period-commitments";
import {
  getCategorySuggestions,
  HISTORY_PERIODS,
  type ConfirmPaydayCheckinContext,
} from "@/lib/data/payday";

import type { Prisma } from "@/generated/prisma/client";

/** AppContext plus the buffer settings, the same shape confirmPaydayCheckin takes. */
export type AffordContext = ConfirmPaydayCheckinContext;

export type AffordInput = z.infer<typeof affordInputSchema>;

interface ActiveAccount {
  id: string;
  name: string;
  currency: string;
}

/**
 * The comparable periods a projection for `ref` averages over: HISTORY_PERIODS
 * same-half periods, newest first, stepping one full cycle back each time the
 * way getCategorySuggestions does. The walk starts from the most recent
 * comparable period that is complete: one whose dates have all passed, or one
 * whose check-in is already confirmed (`confirmed` holds those periods' keys)
 * - its income is then known in full, even on the payday it was entered. An
 * installment can land a year out, and the same-half periods between now and
 * then that are neither over nor confirmed have no history to give and would
 * only dilute the average with zeros, so they are walked past.
 *
 * `incomeHistoryStartDate` (Settings, "count income history from") is a
 * second lower bound of the same kind as the first activity: a period that
 * ended before it is dropped from the walk rather than counted as zero, so
 * incomeHistoryDepth counts over whatever periods remain exactly as it does
 * before the oldest income ever recorded. Null or absent leaves the walk
 * untouched.
 */
export function comparableHistory(
  ref: PeriodRef,
  today: Date,
  confirmed: ReadonlySet<string> = new Set(),
  incomeHistoryStartDate: Date | null = null,
): PeriodInfo[] {
  let cursor = periodInfo(previousComparablePeriod(ref));
  // Bounded for an absurdly distant first payment (~40 years).
  for (
    let i = 0;
    i < 1000 && cursor.end.getTime() >= today.getTime() && !confirmed.has(cursor.key);
    i += 1
  ) {
    cursor = periodInfo(previousComparablePeriod(cursor));
  }
  const periods: PeriodInfo[] = [];
  for (let i = 0; i < HISTORY_PERIODS; i += 1) {
    periods.push(cursor);
    cursor = periodInfo(previousComparablePeriod(cursor));
  }
  return periods.filter((period) => countsInIncomeHistory(period, incomeHistoryStartDate));
}

/**
 * How many of the walked comparable periods an income average divides by:
 * from the oldest one with income in *any* account forward - the same "since
 * first activity" rule as getCategorySuggestions, taken once for the whole
 * walk rather than per account. Periods before the user had any income at all
 * (a new user, or a boundary set in "count income history from") do not drag
 * the figure toward zero. Periods after it do, in every account: when pay
 * moves from one account to another, the old account's empty periods since
 * are real zeros, not gaps, so its old pay fades out as the new account's
 * fades in and the period-wide total stays what the user is actually paid.
 * `incomes` runs newest first. 0 when no account received anything.
 */
export function incomeHistoryDepth(incomes: ReadonlyMap<string, number>[]): number {
  let oldest = -1;
  incomes.forEach((byAccount, index) => {
    if ([...byAccount.values()].some((value) => value > 0)) oldest = index;
  });
  return oldest + 1;
}

/** `values` (newest first) averaged over the newest `depth` of them; 0 over 0 periods. */
export function averageOverHistory(values: number[], depth: number): { amount: number; periods: number } {
  if (depth <= 0) return { amount: 0, periods: 0 };
  const total = values.slice(0, depth).reduce((sum, value) => sum + value, 0);
  return { amount: round2(total / depth), periods: depth };
}

/**
 * The keys of the confirmed check-ins whose periods have not ended yet - the
 * only ones comparableHistory's has-ended rule would otherwise skip. Every
 * period still running or ahead lies in today's month or later, so that is
 * all the query reads; a confirmed period already behind us passes the date
 * rule on its own.
 */
async function loadConfirmedOpenPeriodKeys(today: Date): Promise<Set<string>> {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const checkins = await prisma.paydayCheckin.findMany({
    where: {
      status: "CONFIRMED",
      OR: [{ year: { gt: year } }, { year, month: { gte: month } }],
    },
    select: { year: true, month: true, period: true },
  });
  return new Set(checkins.map((checkin) => periodInfo(checkin).key));
}

/** One historical period's income per account, in the account's own currency. */
type PeriodIncome = Map<string, number>;

/**
 * The income this walk averages over. A deposit that pays back a shared
 * expense (Transaction.reimbursesTransactionId, see src/lib/shared-expense.ts)
 * is left out here by its own identity - the same device
 * manualContributionIdFromTransaction gives getPeriodSummary for a
 * contribution's expense - never by category or note: it raised the account's
 * balance like any income, but it is the user's own money coming back, and
 * averaging it in would project earnings that were never earned. Income the
 * user marked as a one-off (Transaction.isOneOffIncome - a gift, a sale, a
 * refund) is left out by its flag: it was earned and counts wherever income
 * is a fact, but this walk estimates what the next periods will bring, and
 * a one-time receipt is not that.
 */
async function loadPeriodIncome(
  period: PeriodInfo,
  accounts: ActiveAccount[],
  context: AffordContext,
): Promise<PeriodIncome> {
  const accountIds = accounts.map((account) => account.id);
  const currencyByAccount = new Map(accounts.map((account) => [account.id, account.currency]));
  const [transactions, checkin] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        accountId: { in: accountIds },
        date: periodRange(period),
        type: "INCOME",
        // A paycheck belongs to the period its check-in planned, which is
        // added from the snapshots below; its transaction sits on the
        // check-in day.
        source: { not: "PAYDAY_CHECKIN" },
        isOneOffIncome: false,
      },
      select: { accountId: true, amount: true, currency: true, type: true, reimbursesTransactionId: true },
    }),
    prisma.paydayCheckin.findFirst({
      where: { year: period.year, month: period.month, period: period.period, status: "CONFIRMED" },
      select: { snapshots: { select: { accountId: true, incomeEntered: true, currency: true } } },
    }),
  ]);

  const income: PeriodIncome = new Map();
  const add = (accountId: string, amount: number, currency: string) => {
    const accountCurrency = currencyByAccount.get(accountId);
    if (!accountCurrency) return;
    income.set(accountId, (income.get(accountId) ?? 0) + convert(amount, currency, accountCurrency, context.rates));
  };
  for (const transaction of transactions) {
    if (reimbursedExpenseIdFromTransaction(transaction) !== null) continue;
    add(transaction.accountId, num(transaction.amount), transaction.currency);
  }
  for (const snapshot of checkin?.snapshots ?? []) {
    add(snapshot.accountId, num(snapshot.incomeEntered), snapshot.currency);
  }
  return income;
}

/** What one evaluated period already owes: per funding account in that account's currency, and in total in the display currency. */
interface ScheduledCommitments {
  byAccount: Map<string, number>;
  total: number;
  /** A CONFIRMED check-in exists for the period, so its goal funding (GOAL rows, or none) is in the figures above and is the real thing - nothing is to be estimated for it. */
  confirmed: boolean;
}

/**
 * The exact commitments of every evaluated period: whole() of the period's
 * commitments (src/lib/period-commitments.ts) - every occurrence posting will
 * charge or already has, subscription or contribution, each filed in the
 * period its due date falls in (a backlog in the current period, every
 * occurrence of it up to the countdown), at the ledger's amount once posting
 * has written or settled it, on the account the money left. The period
 * containing today is therefore counted in full, not from today: its income
 * is a whole-period average, so its commitments must be too, or rent posted
 * on the 16th would vanish from a purchase judged on the 28th. An item
 * posting will skip (no account, an archived account, a goal already
 * reached) is left out entirely - it will never charge anything.
 *
 * A period that already has a CONFIRMED check-in also owes the goal funding
 * that check-in planned - its GOAL allocation rows, one per goal and account
 * in that account's currency. Confirming commits the money; logging the
 * contribution comes later, and Afford does not read the ledger to see
 * whether it has, so a planned draw counts either way. A period with no
 * confirmed check-in has nothing of the kind to add here; projectPeriods
 * estimates its goal funding instead, and `confirmed` tells it which is which.
 *
 * A GOAL row with no account (or a ledger row on an account archived since)
 * counts period-wide but against no active account's buffer.
 *
 * `commitmentsByPeriod` is loadCommitments() over the periods, with
 * projectPeriods' `excludeItemId` leaving one item's schedule out: the tracker's re-check of
 * a recorded plan judges that plan's own installments, which are by then
 * among the active items and would otherwise be counted as a commitment and
 * subtracted again on top. Only the schedule: an installment of it already
 * posted in the current period is not among the ones re-judged (those start
 * at its nextDate), so it stays counted here, as the posted charge it is -
 * which keeps the re-check's period total what the confirmed verdict judged.
 * Absent for an ordinary evaluation.
 */
async function loadScheduledCommitments(
  periods: PeriodInfo[],
  accounts: ActiveAccount[],
  context: AffordContext,
  commitmentsByPeriod: Map<string, CommitmentOccurrence[]>,
): Promise<Map<string, ScheduledCommitments>> {
  const result = new Map<string, ScheduledCommitments>(
    periods.map((period) => [period.key, { byAccount: new Map<string, number>(), total: 0, confirmed: false }]),
  );
  if (periods.length === 0) return result;
  const currencyByAccount = new Map(accounts.map((account) => [account.id, account.currency]));

  const add = (bucket: ScheduledCommitments, amount: number, currency: string, accountId: string | null) => {
    bucket.total += convert(amount, currency, context.displayCurrency, context.rates);
    const accountCurrency = accountId ? currencyByAccount.get(accountId) : undefined;
    if (accountId && accountCurrency) {
      bucket.byAccount.set(
        accountId,
        (bucket.byAccount.get(accountId) ?? 0) + convert(amount, currency, accountCurrency, context.rates),
      );
    }
  };

  const [commitments, checkins] = await Promise.all([
    commitmentsByPeriod,
    prisma.paydayCheckin.findMany({
      where: {
        status: "CONFIRMED",
        OR: periods.map((period) => ({ year: period.year, month: period.month, period: period.period })),
      },
      select: {
        year: true,
        month: true,
        period: true,
        allocations: {
          where: { type: "GOAL" },
          select: { plannedAmount: true, currency: true, accountId: true },
        },
      },
    }),
  ]);
  for (const [key, occurrences] of commitments) {
    const bucket = result.get(key);
    if (!bucket) continue;
    for (const occurrence of whole(occurrences)) add(bucket, occurrence.amount, occurrence.currency, occurrence.accountId);
  }
  for (const checkin of checkins) {
    const bucket = result.get(periodInfo(checkin).key);
    if (!bucket) continue;
    bucket.confirmed = true;
    for (const allocation of checkin.allocations) {
      add(bucket, num(allocation.plannedAmount), allocation.currency, allocation.accountId);
    }
  }
  return result;
}

/** One evaluated period's essential fixed figure, in the display currency, and where it came from. */
interface EssentialFixed {
  amount: number;
  basis: EssentialFixedBasis;
}

/**
 * What each evaluated period's essential fixed categories come to - the
 * check-in's essentialFixed, filled the way getPaydayCheckinDraft fills its
 * essential rows for a period (same categories, same precedence), read here
 * rather than re-derived:
 *   1. the budget already saved for the period (the Budgets page, a copy
 *      forward, or a confirmed check-in's own write);
 *   2. else the confirmed check-in's ESSENTIAL_CATEGORY allocation;
 *   3. else getCategorySuggestions() - the last comparable budget, or the
 *      average spending since the category's first activity.
 * The suggestion is asked for `suggestionRefFor`'s period, not always for the
 * evaluated one: for a period a year out, the comparable periods the
 * suggestion would read have not happened, and averaging them in as zeros
 * would suggest nothing. The period whose own history is complete - the one
 * right after the newest complete comparable period, the same line
 * comparableHistory draws for income - stands in, exactly as income is
 * carried forward from it. For the plan period and the one after, that is
 * the evaluated period itself, so the figure is what the check-in would show.
 *
 * With no essential categories at all, every period is "unset" at 0 and the
 * checks are what they were without this.
 */
async function loadEssentialFixed(
  periods: PeriodInfo[],
  suggestionRefFor: Map<string, PeriodRef>,
  context: AffordContext,
): Promise<Map<string, EssentialFixed>> {
  const result = new Map<string, EssentialFixed>(
    periods.map((period) => [period.key, { amount: 0, basis: "unset" as const }]),
  );
  if (periods.length === 0) return result;
  const categories = await prisma.category.findMany({
    where: { kind: "EXPENSE", isEssentialFixed: true, isSubscriptionDefault: false, isSavingsDefault: false },
    select: { id: true },
  });
  if (categories.length === 0) return result;
  const categoryIds = categories.map((category) => category.id);
  const periodFilter = periods.map((period) => ({ year: period.year, month: period.month, period: period.period }));
  const [budgets, checkins] = await Promise.all([
    prisma.budget.findMany({
      where: { OR: periodFilter, categoryId: { in: categoryIds } },
      select: { year: true, month: true, period: true, categoryId: true, amount: true, currency: true },
    }),
    prisma.paydayCheckin.findMany({
      where: { status: "CONFIRMED", OR: periodFilter },
      select: {
        year: true,
        month: true,
        period: true,
        allocations: {
          where: { type: "ESSENTIAL_CATEGORY", categoryId: { in: categoryIds } },
          select: { categoryId: true, plannedAmount: true, currency: true },
        },
      },
    }),
  ]);
  const toDisplay = (amount: number, currency: string) =>
    round2(convert(amount, currency, context.displayCurrency, context.rates));
  // "<period key>:<category id>" -> the period's own figure for the category.
  const own = new Map<string, number>();
  for (const checkin of checkins) {
    const key = periodInfo(checkin).key;
    for (const allocation of checkin.allocations) {
      own.set(`${key}:${allocation.categoryId}`, toDisplay(num(allocation.plannedAmount), allocation.currency));
    }
  }
  // A budget wins over the allocation, as it does in the draft.
  for (const budget of budgets) {
    own.set(`${periodInfo(budget).key}:${budget.categoryId}`, toDisplay(num(budget.amount), budget.currency));
  }

  // Only the periods that still miss a category need a suggestion, and
  // periods sharing a stand-in share one call.
  const refsNeeded = new Map<string, PeriodRef>();
  for (const period of periods) {
    if (categoryIds.some((id) => !own.has(`${period.key}:${id}`))) {
      const ref = suggestionRefFor.get(period.key) ?? period;
      refsNeeded.set(periodInfo(ref).key, ref);
    }
  }
  const suggestions = new Map(
    await Promise.all(
      [...refsNeeded.entries()].map(
        async ([key, ref]) => [key, await getCategorySuggestions(ref, categories, context)] as const,
      ),
    ),
  );

  for (const period of periods) {
    const ref = suggestionRefFor.get(period.key) ?? period;
    const suggested = suggestions.get(periodInfo(ref).key);
    let amount = 0;
    let fromSuggestion = false;
    let anyKnown = false;
    for (const id of categoryIds) {
      const figure = own.get(`${period.key}:${id}`);
      if (figure !== undefined) {
        amount += figure;
        anyKnown = true;
        continue;
      }
      const suggestion = suggested?.get(id);
      if (suggestion && suggestion.basis !== "none") {
        amount += suggestion.amount;
        fromSuggestion = true;
        anyKnown = true;
      }
    }
    result.set(period.key, {
      amount: round2(amount),
      basis: fromSuggestion ? "suggestion" : anyKnown ? "budget" : "none",
    });
  }
  return result;
}

/**
 * Projects every period in `refs` for a purchase charged to `chosen`.
 *
 * Income is averaged from history; periods that resolve to the same history
 * window (every future A period does, as does every future B period) share
 * one set of queries, and every account's average divides by the same count
 * of periods, from the oldest with income in any account (incomeHistoryDepth).
 * A period confirmed today counts as history from this moment (see
 * comparableHistory), so a purchase evaluated right after a check-in reads
 * the income that check-in just recorded. Commitments are enumerated from the recurring items' schedules in
 * one pass over the whole horizon, leaving out `options.excludeItemId` if
 * given (see loadScheduledCommitments).
 *
 * A period with no confirmed check-in also carries an estimate of its goal
 * funding: every dated goal's period plan (loadGoalPeriodPlans - the plan
 * period's pace less the period's own recurring contributions to the goal),
 * in each period inside that goal's roadmap window only (goalWindow),
 * spread over the accounts by planGoalFunding against the headroom
 * each has left in that period once its income, scheduled commitments and
 * buffer are projected - the same split, over the same kind of room, that
 * Step 3 of the check-in recommends. Each account's share joins its
 * commitments and the total joins the period's, both also reported apart as
 * `estimatedGoalFunding`, with the goals named in `estimatedGoals`. A period
 * whose check-in is confirmed already counts the funding it planned and gets
 * no estimate on top. From payday to the end of its period, today's period
 * comes before the plan period and is outside every goal's window, as it is
 * outside the roadmap's.
 *
 * The essential fixed categories (loadEssentialFixed) are subtracted in both
 * checks, as the check-in's Step 4 subtracts them - but not from the room the
 * goal estimate is spread over, which is Step 3's room (income, scheduled
 * commitments, buffer) and never counted them.
 */
export async function projectPeriods(
  refs: PeriodRef[],
  chosen: ActiveAccount,
  accounts: ActiveAccount[],
  context: AffordContext,
  options: { excludeItemId?: string } = {},
): Promise<Map<string, PeriodProjection>> {
  const confirmedOpen = await loadConfirmedOpenPeriodKeys(context.today);
  const histories = new Map<string, PeriodInfo[]>();
  const historyKeyFor = new Map<string, string>();
  // The period whose essential-category suggestion stands in for each
  // evaluated one: the one right after its newest complete comparable period
  // (see loadEssentialFixed). Taken before the "count income history from"
  // boundary, which trims the income walk, not where it starts.
  const suggestionRefFor = new Map<string, PeriodRef>();
  for (const ref of refs) {
    const history = comparableHistory(ref, context.today, confirmedOpen, context.incomeHistoryStartDate);
    // A "count income history from" date past every comparable period leaves
    // an empty walk: nothing to load, and every account then projects zero
    // income over zero periods (basis "none"), as a brand-new account does.
    const key = history[0]?.key ?? "";
    historyKeyFor.set(periodInfo(ref).key, key);
    if (!histories.has(key)) histories.set(key, history);
    const newest = comparableHistory(ref, context.today, confirmedOpen)[0];
    suggestionRefFor.set(periodInfo(ref).key, nextPeriod(nextPeriod(newest)));
  }

  const incomeByHistory = new Map<string, PeriodIncome[]>();
  const periods = refs.map(periodInfo);
  const commitmentsByPeriod = await loadCommitments(periods, context, { excludeItemId: options.excludeItemId });
  const [scheduled, essentials, goalPlans] = await Promise.all([
    loadScheduledCommitments(periods, accounts, context, commitmentsByPeriod),
    loadEssentialFixed(periods, suggestionRefFor, context),
    loadGoalPeriodPlans(periods, context, { commitments: commitmentsByPeriod }),
    ...[...histories.entries()].map(async ([key, history]) => {
      const incomes = await Promise.all(
        history.map((period) => loadPeriodIncome(period, accounts, context)),
      );
      incomeByHistory.set(key, incomes);
    }),
  ]);

  // Only a dated goal has a pace to repeat. An undated goal's roadmap figure
  // is its whole remaining balance - what the check-in recommends putting
  // toward it in the one period being planned, to be done with it as fast as
  // the room allows - and repeating that in every period ahead would commit
  // the same money once per period. It is left out of the estimate entirely;
  // a confirmed check-in's real GOAL rows for it still count as they always
  // did, and every other reader of the roadmap figure is untouched.
  //
  // A dated goal's pace is also only meaningful inside its roadmap window:
  // the periods from the plan period up to the last one paid by its target
  // date, counted exactly as the roadmap counts them (goalWindow). A period
  // outside it - past the target, or today's period from payday to its end,
  // which precedes the plan period - is estimated nothing for that goal. In
  // each period of the window the estimate is that period's own by-hand
  // figure: the pace less the goal's recurring contributions due there.
  const plan = periodClock(context.today).plan;
  const goalWindows = new Map<string, Set<string>>();
  for (const goalPlan of [...goalPlans.values()].flat()) {
    if (!goalPlan.open || !goalPlan.targetDate || goalWindows.has(goalPlan.goalId)) continue;
    goalWindows.set(goalPlan.goalId, new Set(goalWindow(plan.start, goalPlan.targetDate).map((period) => period.key)));
  }

  const floorFor = (account: ActiveAccount) =>
    round2(convert(context.bufferFloorAmount, context.bufferFloorCurrency, account.currency, context.rates));

  const projections = new Map<string, PeriodProjection>();
  for (const ref of refs) {
    const period = periodInfo(ref);
    const historyKey = historyKeyFor.get(period.key) as string;
    const incomes = incomeByHistory.get(historyKey) ?? [];
    const commitments = scheduled.get(period.key);
    const essential = essentials.get(period.key) ?? { amount: 0, basis: "unset" as const };
    const depth = incomeHistoryDepth(incomes);

    const figures = accounts.map((account) => {
      const values = incomes.map((byAccount) => byAccount.get(account.id) ?? 0);
      const income = averageOverHistory(values, depth);
      const hasIncome = values.some((value) => value > 0);
      const scheduledCommitted = round2(commitments?.byAccount.get(account.id) ?? 0);
      const buffer = defaultProtectedBuffer(income.amount, context.bufferPercent, floorFor(account));
      return { account, income, hasIncome, scheduledCommitted, buffer };
    });

    // Each account's share of the essential fixed figure: its part of the
    // period's projected income, the money essentials are paid from. With no
    // income projected anywhere there is nothing to share by, and the chosen
    // account - the one being judged - carries all of it.
    const incomeInDisplay = figures.map(({ account, income }) =>
      convert(income.amount, account.currency, context.displayCurrency, context.rates),
    );
    const totalIncomeInDisplay = incomeInDisplay.reduce((sum, value) => sum + value, 0);
    const essentialShareFor = (index: number, account: ActiveAccount) => {
      const share =
        totalIncomeInDisplay > 0 ? incomeInDisplay[index] / totalIncomeInDisplay : account.id === chosen.id ? 1 : 0;
      return round2(convert(essential.amount * share, context.displayCurrency, account.currency, context.rates));
    };

    // The goal estimate, for a period with no confirmed check-in: each dated
    // goal's pace, drawn from the accounts by their projected headroom - what
    // each has left above its buffer once its scheduled commitments are met
    // - through the check-in's own split. An account with no room gives
    // nothing, and a goal the room cannot cover is estimated at what the
    // room can give, exactly as Step 3 would recommend it. A confirmed
    // check-in's period keeps its real GOAL rows (already in `commitments`)
    // and no estimate.
    const estimatedByAccount = new Map<string, number>();
    const estimatedGoals: EstimatedGoalFunding[] = [];
    const projectedGoalPlans: ProjectedGoalPlan[] = [];
    const periodPaces = (goalPlans.get(period.key) ?? []).filter(
      (goalPlan) => goalPlan.open && goalWindows.get(goalPlan.goalId)?.has(period.key),
    );
    if (!commitments?.confirmed && periodPaces.length > 0) {
      const plans = planGoalFunding(
        periodPaces.map((goalPlan) => ({ goalId: goalPlan.goalId, amount: goalPlan.byHand })),
        figures.map(({ account, income, scheduledCommitted, buffer }) => ({
          accountId: account.id,
          name: account.name,
          currency: account.currency,
          headroom: round2(income.amount - scheduledCommitted - buffer),
        })),
        { displayCurrency: context.displayCurrency, rates: context.rates },
      );
      // One plan per pace, in the same order (planGoalFunding maps its goals).
      plans.forEach((plan, index) => {
        for (const draw of plan.draws) {
          estimatedByAccount.set(
            draw.accountId,
            round2((estimatedByAccount.get(draw.accountId) ?? 0) + draw.recommendedAmount),
          );
        }
        if (plan.recommendedTotal > 0) {
          estimatedGoals.push({ goalId: plan.goalId, name: periodPaces[index].name, amount: plan.recommendedTotal });
        }
        // The whole plan, kept for the goal-forecast detector: the same
        // figures the estimate above was reduced from, whether or not the
        // room gave the goal anything.
        projectedGoalPlans.push({
          goalId: plan.goalId,
          name: periodPaces[index].name,
          pace: periodPaces[index].pace,
          scheduled: periodPaces[index].scheduled,
          byHand: plan.amount,
          recommended: plan.recommendedTotal,
          shortfall: plan.shortfall,
          draws: plan.draws,
        });
      });
    }
    const periodEstimated = round2(estimatedGoals.reduce((sum, goal) => sum + goal.amount, 0));

    let periodIncome = 0;
    let periodBuffer = 0;
    let own: PeriodProjection["account"] | null = null;
    for (const [index, { account, income, hasIncome, scheduledCommitted, buffer }] of figures.entries()) {
      const estimatedGoalFunding = estimatedByAccount.get(account.id) ?? 0;
      periodIncome += convert(income.amount, account.currency, context.displayCurrency, context.rates);
      // Only an account that receives income keeps a buffer out of it - the
      // check-in's planAccountBuffers rule for the period-wide total.
      if (income.amount > 0) {
        periodBuffer += convert(buffer, account.currency, context.displayCurrency, context.rates);
      }
      if (account.id === chosen.id) {
        // The chosen account's own check always applies its buffer, even with
        // no income history: the floor is then the whole of it, and the
        // verdict says so rather than quietly waving the purchase through.
        own = {
          accountId: account.id,
          name: account.name,
          currency: account.currency,
          income: income.amount,
          committed: round2(scheduledCommitted + estimatedGoalFunding),
          buffer,
          essentialFixed: essentialShareFor(index, account),
          basis: hasIncome ? "average" : "none",
          incomePeriods: income.periods,
          estimatedGoalFunding,
        };
      }
    }
    if (!own) throw new Error(`Account ${chosen.id} is not among the active accounts`);

    projections.set(period.key, {
      period,
      confirmed: commitments?.confirmed ?? false,
      account: own,
      flexible: {
        currency: context.displayCurrency,
        income: round2(periodIncome),
        committed: round2((commitments?.total ?? 0) + periodEstimated),
        buffer: round2(periodBuffer),
        estimatedGoalFunding: periodEstimated,
        essentialFixed: essential.amount,
        incomePeriods: depth,
      },
      essentialFixedBasis: essential.basis,
      estimatedGoals,
      goalPlans: projectedGoalPlans,
      // The comparable periods actually walked for this projection - `incomes`
      // is built by mapping over the (possibly boundary-filtered) `history`
      // array above, so this is HISTORY_PERIODS unless "count income history
      // from" trimmed it. Not the divisor (that is `depth`): the results page
      // reads it only for how far back an account with no income was checked.
      historyPeriods: incomes.length,
    });
  }
  return projections;
}

/**
 * What "I bought this" will write, shown to the user before they press it.
 * `amount` is the equal installment every schedule row shows and every check
 * subtracted - the same equalInstallmentAmount() the evaluation ran on.
 * `count` is the payments still ahead, starting on `firstDate`, the first of
 * them; `paidCount` more are dated before today and count as already paid -
 * they are neither checked nor recorded.
 */
export interface AffordRecordedPlan {
  amount: number;
  currency: string;
  count: number;
  paidCount: number;
  frequency: AffordInput["frequency"];
  firstDate: Date;
  accountId: string;
  accountName: string;
}

export type AffordEvaluation =
  | { ok: true; verdict: AffordVerdict; recorded: AffordRecordedPlan }
  | { ok: false; reason: "account_not_active" | "all_installments_paid" };

async function loadActiveAccounts(): Promise<ActiveAccount[]> {
  return prisma.account.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, currency: true },
  });
}

/**
 * Evaluates a purchase without writing anything. Plain function (no
 * requireAuth()/cookies()) so scripts/verify-domain.ts can drive it the same
 * way the server action does.
 */
export async function evaluateAffordRequest(
  input: AffordInput,
  context: AffordContext,
): Promise<AffordEvaluation> {
  const accounts = await loadActiveAccounts();
  const chosen = accounts.find((account) => account.id === input.accountId);
  if (!chosen) return { ok: false, reason: "account_not_active" };

  // One amount for the whole plan, computed here and nowhere else on the
  // server: what the checks subtract below is what confirmAffordPurchase
  // records, so the two cannot drift apart.
  const amount = equalInstallmentAmount(input.totalAmount, input.installments);
  const dates = installmentDates(input.firstDate, input.frequency, input.installments);
  // A payment dated before today was made already: it is not judged in its
  // own (past) period, where nothing is committed and the room would look
  // larger than it was, and it is never recorded - posting would otherwise
  // charge it again on the next request.
  const { paid, upcoming } = splitPaidInstallments(buildInstallments(dates, amount), context.today);
  if (upcoming.length === 0) return { ok: false, reason: "all_installments_paid" };
  const refs = [...new Set(upcoming.map((installment) => installment.periodKey))]
    .map((key) => parsePeriodKey(key))
    .filter((ref): ref is PeriodRef => ref !== null);
  const projections = await projectPeriods(refs, chosen, accounts, context);
  const verdict = evaluateAffordability({
    installments: upcoming,
    paidInstallments: paid,
    currency: input.currency,
    projections,
    rates: context.rates,
  });
  return {
    ok: true,
    verdict,
    recorded: {
      amount,
      currency: input.currency,
      count: upcoming.length,
      paidCount: paid.length,
      frequency: input.frequency,
      firstDate: upcoming[0].date,
      accountId: chosen.id,
      accountName: chosen.name,
    },
  };
}

export type AffordConfirmation =
  | { ok: true; recurringItemId: string; verdict: AffordVerdict }
  | { ok: false; reason: "account_not_active" }
  | { ok: false; reason: "all_installments_paid" }
  | { ok: false; reason: "not_acknowledged"; verdict: AffordVerdict };

/**
 * The one write in this feature. Re-runs the evaluation first so the
 * acknowledgement gate is the server's verdict, not the client's, then creates
 * a single SUBSCRIPTION RecurringItem that counts itself down: from here on
 * the plan is an ordinary recurring item to posting, the period summary and
 * the check-in. Only `fromAfford` tells it apart, for the Recurring page's
 * "From Afford" section and the tracker below.
 *
 * Only the payments still ahead are recorded: the item's countdown is the
 * count of installments dated today or later and its nextDate the first of
 * them, while the anchor stays the plan's own first date, so a month-end plan
 * keeps its 31st. Payments dated before today were paid already and are
 * never posted; a plan with none ahead is refused (see evaluateAffordRequest).
 */
export async function confirmAffordPurchase(
  input: AffordInput,
  context: AffordContext,
): Promise<AffordConfirmation> {
  const evaluation = await evaluateAffordRequest(input, context);
  if (!evaluation.ok) return evaluation;
  if (!evaluation.verdict.viable && !input.acknowledged) {
    return { ok: false, reason: "not_acknowledged", verdict: evaluation.verdict };
  }
  const item = await prisma.recurringItem.create({
    data: {
      name: input.name,
      amount: evaluation.recorded.amount,
      currency: input.currency,
      frequency: input.frequency,
      kind: "SUBSCRIPTION",
      nextDate: evaluation.recorded.firstDate,
      // The first payment's day anchors every later one, as the recurring
      // form's schema does for a hand-entered item - see RecurringItem.anchorDay.
      // It is the plan's own first date, not the first one still ahead, whose
      // day a short month may have clamped.
      anchorDay: input.firstDate.getUTCDate(),
      accountId: evaluation.recorded.accountId,
      remainingOccurrences: evaluation.recorded.count,
      fromAfford: true,
    },
    select: { id: true },
  });
  return { ok: true, recurringItemId: item.id, verdict: evaluation.verdict };
}

/**
 * Still viable? A plan recorded here was judged against projections made on
 * the day it was confirmed. Every commitment recorded since - another plan,
 * a new subscription, a check-in's goal funding - shrinks the room the later
 * periods have, and nothing re-asked the question. The re-check does: the
 * same two checks evaluateAffordRequest runs, over the plan's *actual*
 * remaining schedule (its live nextDate, frequency, anchor and countdown -
 * what posting will charge, not what was typed in), against projections
 * made now. The plan's own occurrences are left out of the commitments it is
 * judged against (see loadScheduledCommitments), so re-checking right after
 * confirming reproduces the confirmed verdict exactly, and the verdict is
 * Afford's own shape. Read-only, like the calculator.
 */
export type AffordRecheck =
  | { ok: true; verdict: AffordVerdict }
  | {
      ok: false;
      reason: "not_found" | "not_from_afford" | "no_remaining_schedule" | "account_not_active";
    };

const TRACKED_ITEM_SELECT = {
  id: true,
  name: true,
  amount: true,
  currency: true,
  frequency: true,
  nextDate: true,
  anchorDay: true,
  // A From Afford item is only ever created by confirmAffordPurchase, whose
  // own frequency picker (AFFORD_FREQUENCIES) excludes SEMI_MONTHLY - so this
  // is always null in practice. Selected anyway so this row is a complete
  // ScheduledItem, matching every other real RecurringItem select.
  secondAnchorDay: true,
  remainingOccurrences: true,
  accountId: true,
  active: true,
  fromAfford: true,
} satisfies Prisma.RecurringItemSelect;

type TrackedItemRow = Prisma.RecurringItemGetPayload<{ select: typeof TRACKED_ITEM_SELECT }>;

/** Runs the two checks for one loaded plan; null when its account is not among the active ones (the per-account check has nothing to run against). */
async function recheckLoadedItem(
  item: TrackedItemRow,
  accounts: ActiveAccount[],
  context: AffordContext,
): Promise<AffordVerdict | null> {
  const chosen = accounts.find((account) => account.id === item.accountId);
  if (!chosen) return null;
  const installments = remainingInstallments(
    item,
    num(item.amount),
    context.today,
    context.currentPeriod.key,
  );
  const refs = [...new Set(installments.map((installment) => installment.periodKey))]
    .map((key) => parsePeriodKey(key))
    .filter((ref): ref is PeriodRef => ref !== null);
  const projections = await projectPeriods(refs, chosen, accounts, context, {
    excludeItemId: item.id,
  });
  return evaluateAffordability({
    installments,
    currency: item.currency,
    projections,
    rates: context.rates,
  });
}

/** Re-checks one plan by id. Plain function so scripts/verify-domain.ts can drive it. */
export async function recheckAffordItem(
  itemId: string,
  context: AffordContext,
): Promise<AffordRecheck> {
  const item = await prisma.recurringItem.findUnique({
    where: { id: itemId },
    select: TRACKED_ITEM_SELECT,
  });
  if (!item) return { ok: false, reason: "not_found" };
  if (!item.fromAfford) return { ok: false, reason: "not_from_afford" };
  if (!item.active || !item.remainingOccurrences || item.remainingOccurrences <= 0) {
    return { ok: false, reason: "no_remaining_schedule" };
  }
  const verdict = await recheckLoadedItem(item, await loadActiveAccounts(), context);
  return verdict ? { ok: true, verdict } : { ok: false, reason: "account_not_active" };
}

/**
 * Every plan the tracker follows - active, from Afford, payments left, on an
 * active account - each re-checked, soonest due first. A plan whose account
 * has gone (unset, or archived since) is left out: there is no account
 * check to run, and the Recurring page already flags it as needing one.
 */
export async function recheckAffordItems(context: AffordContext): Promise<AffordTrackedItem[]> {
  const [items, accounts] = await Promise.all([
    prisma.recurringItem.findMany({
      where: { fromAfford: true, active: true, remainingOccurrences: { gt: 0 } },
      orderBy: [{ nextDate: "asc" }, { name: "asc" }],
      select: TRACKED_ITEM_SELECT,
    }),
    loadActiveAccounts(),
  ]);
  const verdicts = await Promise.all(items.map((item) => recheckLoadedItem(item, accounts, context)));
  return items.flatMap((item, index) => {
    const verdict = verdicts[index];
    return verdict ? [{ itemId: item.id, name: item.name, verdict }] : [];
  });
}

/**
 * The tracker as a page sees it: the request's own context plus the buffer
 * settings, computed once per request however many places read it (the nav
 * badge on every page, the Dashboard alert, the Recurring page's section) and
 * never kept beyond it.
 */
export const getAffordRechecks = cache(async (): Promise<AffordTrackedItem[]> => {
  const [context, settings] = await Promise.all([getAppContext(), getSettings()]);
  return recheckAffordItems({
    ...context,
    bufferPercent: settings.bufferPercent,
    bufferFloorAmount: num(settings.bufferFloorAmount),
    bufferFloorCurrency: settings.bufferFloorCurrency,
  });
});
