/**
 * Loads period income (QUANTITIES_MAP.md K5) on one attribution - the rules
 * are in src/lib/period-income.ts. `fact` is what the hero, Reports and the
 * check-in read; `estimate` is what Afford's history walk averages (and so the
 * subscription-room check, the From Afford tracker and the goal forecast).
 */
import { convert } from "@/lib/currency";
import { num } from "@/lib/money";
import {
  fundedPeriodFor,
  incomeWindow,
  nextPeriod as nextPeriodRef,
  paydayDateFor,
  periodInfo,
  periodKey,
  type PayLanded,
  type PeriodRef,
} from "@/lib/period";
import {
  incomePeriodFor,
  rowCountsAsIncome,
  rowIncome,
  snapshotIncome,
  type IncomeBasis,
} from "@/lib/period-income";
import { prisma } from "@/lib/prisma";
import { reimbursedExpenseIdFromTransaction } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";

/** One period's income: per account in that account's own currency, and in total in the display currency. */
export interface PeriodIncomeFigures {
  byAccount: Map<string, number>;
  total: number;
}

/**
 * The income of each of `periods` on `basis`, keyed by period key. One read of
 * the rows (from the first period's income window to the last period's end)
 * and one of their confirmed check-ins.
 * Every account is included, archived ones too; a caller that projects
 * (Afford) keeps the accounts it projects.
 */
export async function loadPeriodIncome(
  periods: readonly PeriodRef[],
  basis: IncomeBasis,
  context: Pick<AppContext, "displayCurrency" | "rates">,
): Promise<Map<string, PeriodIncomeFigures>> {
  const infos = periods.map(periodInfo);
  const result = new Map<string, PeriodIncomeFigures>(
    infos.map((period) => [period.key, { byAccount: new Map<string, number>(), total: 0 }]),
  );
  if (infos.length === 0) return result;

  // Every day a row counting in one of the periods can carry: its income
  // window, which opens before its first day, and its own days, which one-off
  // income and paybacks count by.
  const from = new Date(Math.min(...infos.map((period) => incomeWindow(period).from.getTime())));
  const through = new Date(Math.max(...infos.map((period) => period.end.getTime())));
  const [rows, checkins, accounts] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "INCOME", date: { gte: from, lte: through } },
      select: {
        accountId: true,
        date: true,
        amount: true,
        currency: true,
        source: true,
        type: true,
        isOneOffIncome: true,
        reimbursesTransactionId: true,
        earmarks: { select: { amount: true, currency: true } },
      },
    }),
    prisma.paydayCheckin.findMany({
      where: {
        status: "CONFIRMED",
        OR: infos.map((period) => ({ year: period.year, month: period.month, period: period.period })),
      },
      select: {
        year: true,
        month: true,
        period: true,
        snapshots: { select: { accountId: true, incomeEntered: true, oneOffIncome: true, currency: true } },
      },
    }),
    prisma.account.findMany({ select: { id: true, currency: true } }),
  ]);
  const currencyByAccount = new Map(accounts.map((account) => [account.id, account.currency]));

  const add = (periodKey: string, accountId: string, amount: number, currency: string) => {
    const figures = result.get(periodKey);
    const accountCurrency = currencyByAccount.get(accountId);
    if (!figures || !accountCurrency) return;
    figures.byAccount.set(
      accountId,
      (figures.byAccount.get(accountId) ?? 0) + convert(amount, currency, accountCurrency, context.rates),
    );
    figures.total += convert(amount, currency, context.displayCurrency, context.rates);
  };

  for (const row of rows) {
    const income = {
      ...row,
      amount: num(row.amount),
      earmarked: row.earmarks.reduce(
        (sum, earmark) => sum + convert(num(earmark.amount), earmark.currency, row.currency, context.rates),
        0,
      ),
    };
    if (!rowCountsAsIncome(income, basis)) continue;
    add(incomePeriodFor(row).key, row.accountId, rowIncome(income, basis), row.currency);
  }
  for (const checkin of checkins) {
    const key = periodInfo(checkin).key;
    for (const snapshot of checkin.snapshots) {
      const amount = snapshotIncome(
        {
          accountId: snapshot.accountId,
          incomeEntered: num(snapshot.incomeEntered),
          oneOffIncome: snapshot.oneOffIncome === null ? null : num(snapshot.oneOffIncome),
          currency: snapshot.currency,
        },
        basis,
      );
      add(key, snapshot.accountId, amount, snapshot.currency);
    }
  }
  return result;
}

/** periodIncome(period, basis): one period's income per account, each in the account's own currency. */
export async function periodIncome(
  period: PeriodRef,
  basis: IncomeBasis,
  context: Pick<AppContext, "displayCurrency" | "rates">,
): Promise<Map<string, number>> {
  const figures = await loadPeriodIncome([period], basis, context);
  return figures.get(periodInfo(period).key)?.byAccount ?? new Map();
}

/**
 * The day each period's pay was recorded as landing, for fundingWindow (src/lib/period.ts):
 * the earliest of its confirmed check-in's paycheck transaction and the
 * ordinary deposits its income window attributes to it (one-off income and
 * paybacks are not pay), counting only one dated from PAYCHECK_LEAD_DAYS
 * before its first day through its payday. A period with none has no entry
 * and its window opens on its payday. Returned as the PayLanded lookup
 * fundingWindow takes, covering `periods` and the period after each.
 */
export async function loadPayLanded(periods: readonly PeriodRef[]): Promise<PayLanded> {
  const refs = new Map<string, PeriodRef>();
  for (const period of periods) {
    const info = periodInfo(period);
    refs.set(info.key, info);
    const next = periodInfo(nextPeriodRef(info));
    refs.set(next.key, next);
  }
  const landed = new Map<string, Date>();
  const lookup: PayLanded = (ref) => landed.get(periodKey(ref)) ?? null;
  if (refs.size === 0) return lookup;
  const all = [...refs.values()];
  const from = new Date(Math.min(...all.map((ref) => incomeWindow(ref).from.getTime())));
  const through = new Date(Math.max(...all.map((ref) => paydayDateFor(ref).getTime())));
  const [rows, checkins] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "INCOME", date: { gte: from, lte: through } },
      select: { id: true, date: true, source: true, type: true, isOneOffIncome: true, reimbursesTransactionId: true },
    }),
    prisma.paydayCheckin.findMany({
      where: { status: "CONFIRMED", OR: all.map((ref) => ({ year: ref.year, month: ref.month, period: ref.period })) },
      select: { year: true, month: true, period: true, snapshots: { select: { incomeTransactionId: true } } },
    }),
  ]);
  // A check-in's paycheck row belongs to the period its check-in planned.
  const paycheckPeriod = new Map<string, string>();
  for (const checkin of checkins) {
    for (const snapshot of checkin.snapshots) {
      if (snapshot.incomeTransactionId) paycheckPeriod.set(snapshot.incomeTransactionId, periodInfo(checkin).key);
    }
  }
  for (const row of rows) {
    let key: string | undefined;
    if (row.source === "PAYDAY_CHECKIN") key = paycheckPeriod.get(row.id);
    else if (!row.isOneOffIncome && reimbursedExpenseIdFromTransaction(row) === null) key = fundedPeriodFor(row.date).key;
    const ref = key ? refs.get(key) : undefined;
    if (!key || !ref) continue;
    // Only pay landing from the lead through the payday opens the window.
    if (row.date.getTime() < incomeWindow(ref).from.getTime() || row.date.getTime() > paydayDateFor(ref).getTime()) continue;
    const current = landed.get(key);
    if (!current || row.date.getTime() < current.getTime()) landed.set(key, row.date);
  }
  return lookup;
}
