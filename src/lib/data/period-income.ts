/**
 * Loads period income (QUANTITIES_MAP.md K5) on one attribution - the rules
 * are in src/lib/period-income.ts. `fact` is what the hero, Reports and the
 * check-in read; `estimate` is what Afford's history walk averages (and so the
 * subscription-room check, the From Afford tracker and the goal forecast).
 */
import { accountAmount, moneyRow } from "@/lib/account-money";
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
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
  type AdoptedWindow,
  type IncomeBasis,
} from "@/lib/period-income";
import { prisma } from "@/lib/prisma";
import { reimbursedExpenseIdFromTransaction } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import type { Prisma } from "@/generated/prisma/client";

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
        snapshots: { select: { accountId: true, incomeEntered: true, oneOffIncome: true, adoptedIncome: true, currency: true } },
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
          adoptedIncome: snapshot.adoptedIncome === null ? null : num(snapshot.adoptedIncome),
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

/** A deposit the ledger holds for a period, as Step 2 of its check-in lists it. */
export interface LedgerDeposit {
  transactionId: string;
  date: Date;
  /**
   * What of it is pay, in the account's own currency: the deposit less the
   * part earmarked for a recurring payment, which already lowers what that
   * payment asks of the plan and so is never the plan's income too.
   */
  amount: number;
  /** The earmarked part left out of `amount`, in the account's currency (0 when none). */
  earmarked: number;
  note: string | null;
}

/** The deposits the ledger holds for a period, per account (loadLedgerDeposits). */
export interface LedgerDeposits {
  /** What Step 2 lists and confirm adopts: each deposit's pay, oldest first. */
  byAccount: Map<string, LedgerDeposit[]>;
  /**
   * How many deposits in the window are, in whole or in part, not pay: marked
   * one-off, or with a part earmarked for a recurring payment. Step 2 says
   * so in one line.
   */
  setAside: Map<string, number>;
}

/**
 * The deposits the ledger already holds on each account for `ref`: ordinary
 * INCOME rows (one-off income and paybacks of a shared expense are not pay,
 * and a check-in's own PAYDAY_CHECKIN rows are what it records itself) dated
 * in the period's income window (src/lib/period.ts) - the rows period income
 * already counts in it. A check-in for `ref` lists them in Step 2 and adopts
 * them on confirm (PaydayAccountSnapshot.adoptedIncome) rather than
 * recording that money a second time - each less its earmarked part, and
 * one earmarked in full is not listed.
 */
export async function loadLedgerDeposits(
  ref: PeriodRef,
  context: Pick<AppContext, "rates">,
  options: { client?: Prisma.TransactionClient } = {},
): Promise<LedgerDeposits> {
  const client = options.client ?? prisma;
  const window = incomeWindow(ref);
  const rows = await client.transaction.findMany({
    where: {
      type: "INCOME",
      source: { not: "PAYDAY_CHECKIN" },
      reimbursesTransactionId: null,
      date: { gte: window.from, lt: window.until },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      date: true,
      note: true,
      accountId: true,
      amount: true,
      currency: true,
      originalAmount: true,
      originalCurrency: true,
      rate: true,
      isOneOffIncome: true,
      account: { select: { currency: true } },
      earmarks: { select: { amount: true, currency: true } },
    },
  });
  const result = new Map<string, LedgerDeposit[]>();
  const setAside = new Map<string, number>();
  for (const row of rows) {
    if (row.isOneOffIncome || row.earmarks.length > 0) setAside.set(row.accountId, (setAside.get(row.accountId) ?? 0) + 1);
    if (row.isOneOffIncome) continue;
    const whole = round2(accountAmount(moneyRow(row), row.account.currency, context.rates));
    const earmarked = Math.min(
      whole,
      round2(row.earmarks.reduce((sum, earmark) => sum + convert(num(earmark.amount), earmark.currency, row.account.currency, context.rates), 0)),
    );
    if (whole - earmarked <= 0) continue;
    const list = result.get(row.accountId) ?? [];
    list.push({ transactionId: row.id, date: row.date, amount: round2(whole - earmarked), earmarked, note: row.note });
    result.set(row.accountId, list);
  }
  return { byAccount: result, setAside };
}

/**
 * Every adoption window of a confirmed check-in (AdoptedWindow): the income
 * window of its period on each account its snapshot adopted deposits for.
 * A deposit in one (isAdoptedDeposit) is that check-in's pay.
 */
export async function loadAdoptedWindows(): Promise<AdoptedWindow[]> {
  const snapshots = await prisma.paydayAccountSnapshot.findMany({
    where: { adoptedIncome: { gt: 0 }, checkin: { status: "CONFIRMED" } },
    select: { accountId: true, checkin: { select: { year: true, month: true, period: true } } },
  });
  return snapshots.map((snapshot) => {
    const window = incomeWindow(snapshot.checkin);
    return { accountId: snapshot.accountId, from: window.from, until: window.until };
  });
}

/** What `deposits` hold together, rounded to the cent. */
export function ledgerDepositsTotal(deposits: readonly LedgerDeposit[] | undefined): number {
  return round2((deposits ?? []).reduce((sum, deposit) => sum + deposit.amount, 0));
}

/**
 * A deposit is pay - it opens its period's goal money (fundingWindow) and
 * Step 1's reconciliation date - only when it is at least this share of the
 * account's most recent confirmed paycheck (R4): a refund, interest or a
 * small transfer landing in the lead days is not.
 */
export const PAY_SHARE_OF_PAYCHECK = 0.5;

/**
 * The day each period's pay was recorded as landing, for fundingWindow (src/lib/period.ts):
 * the earliest of its confirmed check-in's paycheck transaction and the
 * ordinary deposits its income window attributes to it (one-off income and
 * paybacks are not pay) that are at least PAY_SHARE_OF_PAYCHECK of their
 * account's most recent confirmed paycheck - the incomeEntered of the latest
 * confirmed check-in before that period recording income on it - counting
 * only one dated from PAYCHECK_LEAD_DAYS before its first day through its
 * payday. An account with no confirmed paycheck before the period has no
 * deposit that opens it. A period with none has no entry and its window
 * opens on its payday. Returned as the PayLanded lookup fundingWindow takes,
 * covering `periods` and the period after each.
 */
export async function loadPayLanded(
  periods: readonly PeriodRef[],
  context: Pick<AppContext, "rates">,
): Promise<PayLanded> {
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
  const lastKey = all.map((ref) => periodKey(ref)).sort().at(-1) as string;
  const [rows, checkins, paychecks] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "INCOME", date: { gte: from, lte: through } },
      select: {
        id: true,
        date: true,
        source: true,
        type: true,
        isOneOffIncome: true,
        reimbursesTransactionId: true,
        accountId: true,
        amount: true,
        currency: true,
        originalAmount: true,
        originalCurrency: true,
        rate: true,
      },
    }),
    prisma.paydayCheckin.findMany({
      where: { status: "CONFIRMED", OR: all.map((ref) => ({ year: ref.year, month: ref.month, period: ref.period })) },
      select: { year: true, month: true, period: true, snapshots: { select: { incomeTransactionId: true } } },
    }),
    // Every confirmed paycheck up to the last period asked about, newest
    // first: the reference a deposit is measured against.
    prisma.paydayAccountSnapshot.findMany({
      where: { incomeEntered: { gt: 0 }, checkin: { status: "CONFIRMED" } },
      select: { accountId: true, incomeEntered: true, currency: true, checkin: { select: { year: true, month: true, period: true } } },
    }),
  ]);
  const paycheckHistory = paychecks
    .map((snapshot) => ({
      accountId: snapshot.accountId,
      key: periodKey(snapshot.checkin),
      amount: num(snapshot.incomeEntered),
      currency: snapshot.currency,
    }))
    .filter((paycheck) => paycheck.key <= lastKey)
    .sort((a, b) => b.key.localeCompare(a.key));
  // The account's most recent confirmed paycheck before the period `key`.
  const paycheckBefore = (accountId: string, key: string) =>
    paycheckHistory.find((paycheck) => paycheck.accountId === accountId && paycheck.key < key) ?? null;
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
    else if (!row.isOneOffIncome && reimbursedExpenseIdFromTransaction(row) === null) {
      const funded = fundedPeriodFor(row.date).key;
      const paycheck = paycheckBefore(row.accountId, funded);
      // Pay, not a refund or interest: at least half the account's last paycheck.
      const amount = paycheck ? accountAmount(moneyRow(row), paycheck.currency, context.rates) : 0;
      if (paycheck && amount + 0.005 >= paycheck.amount * PAY_SHARE_OF_PAYCHECK) key = funded;
    }
    const ref = key ? refs.get(key) : undefined;
    if (!key || !ref) continue;
    // Only pay landing from the lead through the payday opens the window.
    if (row.date.getTime() < incomeWindow(ref).from.getTime() || row.date.getTime() > paydayDateFor(ref).getTime()) continue;
    const current = landed.get(key);
    if (!current || row.date.getTime() < current.getTime()) landed.set(key, row.date);
  }
  return lookup;
}
