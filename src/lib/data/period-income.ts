/**
 * Loads period income (QUANTITIES_MAP.md K5) on one attribution - the rules
 * are in src/lib/period-income.ts. `fact` is what the hero, Reports and the
 * check-in read; `estimate` is what Afford's history walk averages (and so the
 * subscription-room check, the From Afford tracker and the goal forecast).
 */
import { createHash } from "node:crypto";

import { accountAmount, moneyRow } from "@/lib/account-money";
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { incomeWindow, periodInfo, type PeriodRef } from "@/lib/period";
import {
  adoptedWithoutIds,
  incomePeriodFor,
  rowCountsAsIncome,
  rowIncome,
  snapshotIncome,
  type AdoptedWindow,
  type IncomeBasis,
} from "@/lib/period-income";
import { prisma } from "@/lib/prisma";

import { loadDepositCover } from "@/lib/data/period-commitments";

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
  context: Pick<AppContext, "displayCurrency" | "rates" | "today">,
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
        id: true,
        _count: { select: { earmarks: true } },
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

  // As an estimate a deposit leaves out what of it is earmarked for a
  // payment - only the part that still covers an occurrence's cost (K2's
  // effective earmark): an occurrence lowered or no longer due hands the
  // rest back.
  const earmarkedRows = basis === "estimate" ? rows.filter((row) => row._count.earmarks > 0) : [];
  const currencyOfRow = new Map(earmarkedRows.map((row) => [row.id, row.currency]));
  const cover = await loadDepositCover(
    earmarkedRows.map((row) => row.id),
    (id) => currencyOfRow.get(id) as string,
    context,
  );
  for (const row of rows) {
    const income = { ...row, amount: num(row.amount), earmarked: cover.get(row.id) ?? 0 };
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
  context: Pick<AppContext, "displayCurrency" | "rates" | "today">,
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
   * one-off, or with a part earmarked for a recurring payment that still
   * covers it. Step 2 says so in one line.
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
 * one earmarked in full is not listed. The earmarked part is what still
 * covers a payment (loadDepositCover, K2's applied earmark) - the same part
 * the income estimate leaves out - so an earmark whose payment was lowered
 * or paused hands the rest back to pay here as it does there.
 */
export async function loadLedgerDeposits(
  ref: PeriodRef,
  context: Pick<AppContext, "rates" | "today">,
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
      _count: { select: { earmarks: true } },
    },
  });
  const earmarkedRows = rows.filter((row) => row._count.earmarks > 0);
  const currencyOfRow = new Map(earmarkedRows.map((row) => [row.id, row.currency]));
  const cover = await loadDepositCover(
    earmarkedRows.map((row) => row.id),
    (id) => currencyOfRow.get(id) as string,
    context,
  );
  const result = new Map<string, LedgerDeposit[]>();
  const setAside = new Map<string, number>();
  for (const row of rows) {
    const whole = round2(accountAmount(moneyRow(row), row.account.currency, context.rates));
    const earmarked = Math.min(whole, round2(convert(cover.get(row.id) ?? 0, row.currency, row.account.currency, context.rates)));
    if (row.isOneOffIncome || earmarked > 0) setAside.set(row.accountId, (setAside.get(row.accountId) ?? 0) + 1);
    if (row.isOneOffIncome) continue;
    if (whole - earmarked <= 0) continue;
    const list = result.get(row.accountId) ?? [];
    list.push({ transactionId: row.id, date: row.date, amount: round2(whole - earmarked), earmarked, note: row.note });
    result.set(row.accountId, list);
  }
  return { byAccount: result, setAside };
}

/**
 * The adoption window (AdoptedWindow) of every confirmed check-in that
 * adopted deposits without recording which (adoptedWithoutIds): the income
 * window of its period on each such account. A deposit in one
 * (isAdoptedDeposit) is pay that check-in froze, and cannot be earmarked. A
 * check-in that recorded its deposits follows them (paycheckNow) and has
 * none.
 */
export async function loadAdoptedWindows(): Promise<AdoptedWindow[]> {
  const snapshots = await prisma.paydayAccountSnapshot.findMany({
    where: { adoptedIncome: { gt: 0 }, checkin: { status: "CONFIRMED" } },
    select: {
      accountId: true,
      adoptedIncome: true,
      adoptedTransactionIds: true,
      checkin: { select: { year: true, month: true, period: true, updatedAt: true } },
    },
  });
  return snapshots
    .filter((snapshot) => adoptedWithoutIds({ incomeEntered: 0, adoptedIncome: num(snapshot.adoptedIncome), adoptedTransactionIds: snapshot.adoptedTransactionIds }))
    .map((snapshot) => {
      const window = incomeWindow(snapshot.checkin);
      return { accountId: snapshot.accountId, from: window.from, until: window.until, confirmedAt: snapshot.checkin.updatedAt };
    });
}

/**
 * A fingerprint of the deposits Step 2 lists on `accountIds` (S2): each
 * one's id and its pay, the amount confirm adopts. The draft carries it
 * (PaydayCheckinDraft.depositsVersion) and confirm recomputes it under its
 * lock: a deposit earmarked, edited, deleted, marked one-off or added in
 * between changes it, and the confirm is refused rather than recording the
 * difference as the check-in's own paycheck row.
 */
export function ledgerDepositsVersion(
  byAccount: ReadonlyMap<string, readonly LedgerDeposit[]>,
  accountIds: Iterable<string>,
): string {
  const lines = [...new Set(accountIds)]
    .flatMap((accountId) => (byAccount.get(accountId) ?? []).map((deposit) => `${accountId}:${deposit.transactionId}:${deposit.amount.toFixed(2)}`))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/**
 * What each deposit the ledger holds for `periods` is as pay now, keyed by
 * period key, account and transaction id, in the account's currency - the
 * `payNow` paycheckNow (src/lib/period-income.ts) reads a confirmed
 * snapshot's adopted deposits through. One loadLedgerDeposits per period.
 */
export async function loadPayNow(
  periods: readonly PeriodRef[],
  context: Pick<AppContext, "rates" | "today">,
  options: { client?: Prisma.TransactionClient } = {},
): Promise<(period: PeriodRef, accountId: string, transactionId: string) => number> {
  const byPeriod = new Map<string, Map<string, LedgerDeposit[]>>();
  for (const period of periods) {
    const key = periodInfo(period).key;
    if (!byPeriod.has(key)) byPeriod.set(key, (await loadLedgerDeposits(period, context, options)).byAccount);
  }
  return (period, accountId, transactionId) =>
    byPeriod.get(periodInfo(period).key)?.get(accountId)?.find((deposit) => deposit.transactionId === transactionId)?.amount ?? 0;
}

/** What `deposits` hold together, rounded to the cent. */
export function ledgerDepositsTotal(deposits: readonly LedgerDeposit[] | undefined): number {
  return round2((deposits ?? []).reduce((sum, deposit) => sum + deposit.amount, 0));
}

/** Moved to src/lib/data/pay-landed.ts, which the period commitments read too; re-exported for existing readers. */
export { loadPayLanded, PAY_SHARE_OF_PAYCHECK } from "@/lib/data/pay-landed";
