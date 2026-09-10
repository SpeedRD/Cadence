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
 *               day's transaction)
 *   committed   known exactly, not estimated: every active RecurringItem has a
 *               schedule, so its occurrences in the period are enumerated with
 *               owedOccurrences() - the walk getPeriodSummary's committed
 *               figure uses, over the same set of items (every active one,
 *               either kind) - and summed. A finite item stops at its
 *               countdown, and a contribution to a goal that has already
 *               reached its target is left out, exactly as posting skips it.
 *               This is what lets a purchase recorded here a minute ago count
 *               against the next one before a single installment of it has
 *               posted. A period that already has a confirmed check-in adds
 *               the goal funding that check-in planned: money the user has
 *               committed to move toward a goal but may not have logged yet.
 *   buffer      defaultProtectedBuffer() over the projected income, per
 *               account, as the check-in's per-account buffer card does
 *
 * Nothing here reads a check-in for the periods being evaluated, and nothing
 * here writes until confirmAffordPurchase() - the calculator is a pure read
 * until "I bought this".
 */
import {
  buildInstallments,
  equalInstallmentAmount,
  evaluateAffordability,
  installmentDates,
  type AffordVerdict,
  type PeriodProjection,
} from "@/lib/afford";
import { convert } from "@/lib/currency";
import { maxDate } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { defaultProtectedBuffer } from "@/lib/payday";
import {
  parsePeriodKey,
  periodForDate,
  periodInfo,
  periodRange,
  previousComparablePeriod,
  type PeriodInfo,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { owedOccurrences } from "@/lib/recurring";
import type { affordInputSchema } from "@/lib/validation";
import type { z } from "zod";

import { HISTORY_PERIODS, type ConfirmPaydayCheckinContext } from "@/lib/data/payday";

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
 */
export function comparableHistory(
  ref: PeriodRef,
  today: Date,
  confirmed: ReadonlySet<string> = new Set(),
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
  return periods;
}

/**
 * The same denominator rule as getCategorySuggestions: average from the oldest
 * comparable period with any activity forward, so periods before an account
 * (or a subscription) existed do not drag the figure toward zero. `values`
 * runs newest first. Returns 0 over 0 periods when nothing was ever recorded.
 */
export function averageSinceFirstActivity(values: number[]): { amount: number; periods: number } {
  let oldest = -1;
  values.forEach((value, index) => {
    if (value > 0) oldest = index;
  });
  if (oldest === -1) return { amount: 0, periods: 0 };
  const periods = oldest + 1;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { amount: round2(total / periods), periods };
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
      },
      select: { accountId: true, amount: true, currency: true },
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
}

/**
 * The exact commitments of every evaluated period, from the schedules
 * themselves. Same item set as getPeriodSummary's committed figure - every
 * active item, subscription or contribution, whether or not it has a funding
 * account - and the same walk, owedOccurrences(), which also stops a finite
 * item at its countdown. One walk per item from today to the furthest period,
 * with each due date filed under the period it lands in; an overdue date is
 * owed now, so it lands in the current period, exactly as getPeriodSummary
 * treats it. A contribution whose goal has been achieved is left out
 * entirely: postDueRecurringItems skips it (skipReasonFor's "goal_achieved"
 * in src/lib/recurring-posting.ts, the same condition as here), so it never
 * posts and never advances until the goal's target is raised again.
 *
 * A period that already has a CONFIRMED check-in also owes the goal funding
 * that check-in planned - its GOAL allocation rows, one per goal and account
 * in that account's currency. Confirming commits the money; logging the
 * contribution comes later, and Afford does not read the ledger to see
 * whether it has, so a planned draw counts either way. A period with no
 * confirmed check-in has nothing of the kind to add.
 *
 * An item or GOAL row with no account (or one on an archived account) counts
 * period-wide but against no account's buffer.
 */
async function loadScheduledCommitments(
  periods: PeriodInfo[],
  accounts: ActiveAccount[],
  context: AffordContext,
): Promise<Map<string, ScheduledCommitments>> {
  const result = new Map<string, ScheduledCommitments>(
    periods.map((period) => [period.key, { byAccount: new Map<string, number>(), total: 0 }]),
  );
  if (periods.length === 0) return result;
  const horizonEnd = periods.reduce((latest, period) => maxDate(latest, period.end), periods[0].end);
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

  const [items, checkins] = await Promise.all([
    prisma.recurringItem.findMany({
      where: { active: true, nextDate: { lte: horizonEnd } },
      select: {
        amount: true,
        currency: true,
        frequency: true,
        nextDate: true,
        anchorDay: true,
        remainingOccurrences: true,
        accountId: true,
        kind: true,
        goal: { select: { achievedAt: true } },
      },
    }),
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
  for (const item of items) {
    if (item.kind === "CONTRIBUTION" && item.goal?.achievedAt) continue;
    const amount = num(item.amount);
    for (const due of owedOccurrences(item, context.today, horizonEnd)) {
      const key =
        due.getTime() < context.today.getTime() ? context.currentPeriod.key : periodForDate(due).key;
      const bucket = result.get(key);
      if (!bucket) continue;
      add(bucket, amount, item.currency, item.accountId);
    }
  }
  for (const checkin of checkins) {
    const bucket = result.get(periodInfo(checkin).key);
    if (!bucket) continue;
    for (const allocation of checkin.allocations) {
      add(bucket, num(allocation.plannedAmount), allocation.currency, allocation.accountId);
    }
  }
  return result;
}

/**
 * Projects every period in `refs` for a purchase charged to `chosen`.
 *
 * Income is averaged from history; periods that resolve to the same history
 * window (every future A period does, as does every future B period) share
 * one set of queries, and each account's average runs from its own first
 * activity. A period confirmed today counts as history from this moment (see
 * comparableHistory), so a purchase evaluated right after a check-in reads
 * the income that check-in just recorded. Commitments are enumerated from the recurring items' schedules in
 * one pass over the whole horizon.
 */
export async function projectPeriods(
  refs: PeriodRef[],
  chosen: ActiveAccount,
  accounts: ActiveAccount[],
  context: AffordContext,
): Promise<Map<string, PeriodProjection>> {
  const confirmedOpen = await loadConfirmedOpenPeriodKeys(context.today);
  const histories = new Map<string, PeriodInfo[]>();
  const historyKeyFor = new Map<string, string>();
  for (const ref of refs) {
    const history = comparableHistory(ref, context.today, confirmedOpen);
    const key = history[0].key;
    historyKeyFor.set(periodInfo(ref).key, key);
    if (!histories.has(key)) histories.set(key, history);
  }

  const incomeByHistory = new Map<string, PeriodIncome[]>();
  const [scheduled] = await Promise.all([
    loadScheduledCommitments(refs.map(periodInfo), accounts, context),
    ...[...histories.entries()].map(async ([key, history]) => {
      const incomes = await Promise.all(
        history.map((period) => loadPeriodIncome(period, accounts, context)),
      );
      incomeByHistory.set(key, incomes);
    }),
  ]);

  const floorFor = (account: ActiveAccount) =>
    round2(convert(context.bufferFloorAmount, context.bufferFloorCurrency, account.currency, context.rates));

  const projections = new Map<string, PeriodProjection>();
  for (const ref of refs) {
    const period = periodInfo(ref);
    const historyKey = historyKeyFor.get(period.key) as string;
    const incomes = incomeByHistory.get(historyKey) ?? [];
    const commitments = scheduled.get(period.key);

    let periodIncome = 0;
    let periodBuffer = 0;
    let own: PeriodProjection["account"] | null = null;
    for (const account of accounts) {
      const income = averageSinceFirstActivity(incomes.map((byAccount) => byAccount.get(account.id) ?? 0));
      const committed = round2(commitments?.byAccount.get(account.id) ?? 0);
      const buffer = defaultProtectedBuffer(income.amount, context.bufferPercent, floorFor(account));
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
          committed,
          buffer,
          basis: income.periods > 0 ? "average" : "none",
        };
      }
    }
    if (!own) throw new Error(`Account ${chosen.id} is not among the active accounts`);

    projections.set(period.key, {
      period,
      account: own,
      flexible: {
        currency: context.displayCurrency,
        income: round2(periodIncome),
        committed: round2(commitments?.total ?? 0),
        buffer: round2(periodBuffer),
      },
      historyPeriods: HISTORY_PERIODS,
    });
  }
  return projections;
}

/**
 * What "I bought this" will write, shown to the user before they press it.
 * `amount` is the equal installment every schedule row shows and every check
 * subtracted - the same equalInstallmentAmount() the evaluation ran on.
 */
export interface AffordRecordedPlan {
  amount: number;
  currency: string;
  count: number;
  frequency: AffordInput["frequency"];
  firstDate: Date;
  accountId: string;
  accountName: string;
}

export type AffordEvaluation =
  | { ok: true; verdict: AffordVerdict; recorded: AffordRecordedPlan }
  | { ok: false; reason: "account_not_active" };

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
  const installments = buildInstallments(dates, amount);
  const refs = [...new Set(installments.map((installment) => installment.periodKey))]
    .map((key) => parsePeriodKey(key))
    .filter((ref): ref is PeriodRef => ref !== null);
  const projections = await projectPeriods(refs, chosen, accounts, context);
  const verdict = evaluateAffordability({
    installments,
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
      count: input.installments,
      frequency: input.frequency,
      firstDate: input.firstDate,
      accountId: chosen.id,
      accountName: chosen.name,
    },
  };
}

export type AffordConfirmation =
  | { ok: true; recurringItemId: string; verdict: AffordVerdict }
  | { ok: false; reason: "account_not_active" }
  | { ok: false; reason: "not_acknowledged"; verdict: AffordVerdict };

/**
 * The one write in this feature. Re-runs the evaluation first so the
 * acknowledgement gate is the server's verdict, not the client's, then creates
 * a single SUBSCRIPTION RecurringItem that counts itself down: from here on
 * the plan is an ordinary recurring item to every other part of the app.
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
      nextDate: input.firstDate,
      // The first payment's day anchors every later one, as the recurring
      // form's schema does for a hand-entered item - see RecurringItem.anchorDay.
      anchorDay: input.firstDate.getUTCDate(),
      accountId: evaluation.recorded.accountId,
      remainingOccurrences: evaluation.recorded.count,
    },
    select: { id: true },
  });
  return { ok: true, recurringItemId: item.id, verdict: evaluation.verdict };
}
