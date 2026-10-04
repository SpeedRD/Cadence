import { accountAmount, moneyRow } from "@/lib/account-money";
import { convert, type RateTable } from "@/lib/currency";
import { today as todayInAppZone } from "@/lib/date";
import { num, round2, type DecimalLike } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { balanceSign } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import { skipMissedOccurrences } from "@/lib/data/recurring";
import { loadReimbursementDetails, type SharedExpenseDetails } from "@/lib/data/transactions";
import { Prisma } from "@/generated/prisma/client";
import type { AccountStatus, AccountType } from "@/generated/prisma/enums";

export interface AccountBalance {
  id: string;
  name: string;
  type: AccountType;
  status: AccountStatus;
  currency: string;
  createdAt: Date;
  /** In the account's own currency, as of today: rows dated after today are not in it (see scheduled). */
  balance: number;
  /** Same balance converted to the selected display currency. */
  displayBalance: number;
  /**
   * What rows dated after today will do to the balance once their day comes,
   * signed, in the account's own currency - shown apart, never in `balance`
   * (QUANTITIES_MAP.md D42). 0 when there are none.
   */
  scheduled: number;
  transactionCount: number;
  /** Transactions other than the opening balance itself - gates the "Set opening balance" action. */
  otherTransactionCount: number;
  openingBalance: { id: string; amount: number; date: Date } | null;
}

export type AccountStatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

/**
 * Balances are aggregated in SQL per (account, type, currency, direction) and
 * read in the account's own currency (K7): a row stored in it is summed as
 * stored, and a row written before K7 in another currency is converted at
 * today's rate, as it always was. Transfers net to zero across their two legs.
 * A balance is the ledger as of today (ledgerAt): rows dated after today are
 * reported apart as `scheduled`.
 *
 * Defaults to active accounts only - the dynamic "active accounts" list the
 * payday check-in and every "pick an account" selector must use. Pass
 * { status: "ARCHIVED" } or { status: "ALL" } for historical/admin views.
 */
export async function getAccountBalances(
  context: AppContext,
  options: {
    status?: AccountStatusFilter;
    /** Read inside this transaction instead - what confirming a check-in does once it holds the period's lock. */
    client?: Prisma.TransactionClient;
  } = {},
): Promise<AccountBalance[]> {
  const status = options.status ?? "ACTIVE";
  const db = options.client ?? prisma;
  const [accounts, groups, laterGroups, counts, openingBalances] = await Promise.all([
    db.account.findMany({
      where: status === "ALL" ? undefined : { status },
      orderBy: { name: "asc" },
    }),
    db.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      where: { date: { lte: context.today } },
      _sum: { amount: true },
    }),
    db.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      where: { date: { gt: context.today } },
      _sum: { amount: true },
    }),
    db.transaction.groupBy({ by: ["accountId", "type"], _count: { _all: true } }),
    db.transaction.findMany({
      where: { type: "OPENING_BALANCE" },
      select: { id: true, accountId: true, amount: true, date: true },
    }),
  ]);

  const countsByAccount = new Map<string, number>();
  const otherCountsByAccount = new Map<string, number>();
  for (const row of counts) {
    countsByAccount.set(
      row.accountId,
      (countsByAccount.get(row.accountId) ?? 0) + row._count._all,
    );
    if (row.type !== "OPENING_BALANCE") {
      otherCountsByAccount.set(
        row.accountId,
        (otherCountsByAccount.get(row.accountId) ?? 0) + row._count._all,
      );
    }
  }
  const openingBalanceByAccount = new Map(
    openingBalances.map((row) => [
      row.accountId,
      { id: row.id, amount: num(row.amount), date: row.date },
    ]),
  );

  return accounts.map((account) => {
    const balance = signedTotal(groups, account, context.rates);
    const scheduled = signedTotal(laterGroups, account, context.rates);

    return {
      id: account.id,
      name: account.name,
      type: account.type,
      status: account.status,
      currency: account.currency,
      createdAt: account.createdAt,
      balance: round2(balance),
      displayBalance: round2(
        convert(balance, account.currency, context.displayCurrency, context.rates),
      ),
      scheduled: round2(scheduled),
      transactionCount: countsByAccount.get(account.id) ?? 0,
      otherTransactionCount: otherCountsByAccount.get(account.id) ?? 0,
      openingBalance: openingBalanceByAccount.get(account.id) ?? null,
    };
  });
}

type BalanceGroup = {
  accountId: string;
  type: string;
  currency: string;
  transferDirection: string | null;
  _sum: { amount: DecimalLike };
};

/** One account's signed total of `groups`, in its own currency (accountAmount per group). */
function signedTotal(groups: readonly BalanceGroup[], account: { id: string; currency: string }, rates: RateTable): number {
  return groups
    .filter((group) => group.accountId === account.id)
    .reduce(
      (total, group) =>
        total +
        balanceSign(group.type, group.transferDirection) *
          accountAmount({ amount: num(group._sum.amount), currency: group.currency }, account.currency, rates),
      0,
    );
}

/**
 * K8: each account's ledger at the end of `date` - every row dated on or
 * before it, signed, in the account's own currency (K7) - less the rows in
 * `excludeIds`. Accounts with no such row read 0. What the payday check-in
 * reconciles against (the day before the period's pay landed) and, at
 * today, every balance.
 */
export async function ledgerAt(
  date: Date,
  context: Pick<AppContext, "rates">,
  options: { accountIds?: readonly string[]; excludeIds?: readonly string[]; client?: Prisma.TransactionClient } = {},
): Promise<Map<string, number>> {
  const db = options.client ?? prisma;
  const [accounts, groups] = await Promise.all([
    db.account.findMany({
      where: options.accountIds ? { id: { in: [...options.accountIds] } } : undefined,
      select: { id: true, currency: true },
    }),
    db.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      where: {
        date: { lte: date },
        ...(options.accountIds ? { accountId: { in: [...options.accountIds] } } : {}),
        ...(options.excludeIds && options.excludeIds.length > 0 ? { id: { notIn: [...options.excludeIds] } } : {}),
      },
      _sum: { amount: true },
    }),
  ]);
  return new Map(accounts.map((account) => [account.id, round2(signedTotal(groups, account, context.rates))]));
}

export type SetOpeningBalanceResult = { ok: true } | { ok: false; reason: "has_history" };

/**
 * Records (or replaces) the one-time starting balance for an account with no
 * ordinary transaction history. Stored as a single OPENING_BALANCE
 * transaction, not a separate ledger field - balanceSign() gives it the same
 * sign as income, and it's excluded from isCashflow() so it never counts as
 * income, spending, or budget activity.
 */
export async function setOpeningBalance(
  accountId: string,
  amount: number,
  date: Date,
): Promise<SetOpeningBalanceResult> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

  // The history check and the find-then-write run inside one transaction, and
  // the partial unique index added alongside this
  // ("Transaction_account_opening_balance_key") backstops it: two submits that
  // both find no existing row can no longer both insert one and silently double
  // the account's balance.
  const write = (): Promise<SetOpeningBalanceResult> =>
    prisma.$transaction(async (tx) => {
      const otherCount = await tx.transaction.count({
        where: { accountId, type: { not: "OPENING_BALANCE" } },
      });
      if (otherCount > 0) return { ok: false, reason: "has_history" };

      const existing = await tx.transaction.findFirst({
        where: { accountId, type: "OPENING_BALANCE" },
      });
      if (existing) {
        await tx.transaction.update({
          where: { id: existing.id },
          data: { amount, date, currency: account.currency },
        });
      } else {
        await tx.transaction.create({
          data: {
            accountId,
            amount,
            date,
            currency: account.currency,
            type: "OPENING_BALANCE",
            source: "OPENING_BALANCE",
          },
        });
      }
      return { ok: true };
    });

  try {
    return await write();
  } catch (error) {
    // The index rejected our insert because a concurrent request created the
    // row first. Retrying now takes the update path, which is what a double
    // submit means: the last amount entered wins, exactly as when the row
    // already existed.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return write();
    }
    throw error;
  }
}

export type CorrectStartingBalanceResult =
  | { ok: true; transactionId: string }
  | { ok: false; reason: "not_found" };

/**
 * The lossless way to fix a starting balance once an account has history and
 * setOpeningBalance refuses: an incoming EXTERNAL_TRANSFER dated at the
 * start. balanceSign() raises the balance with it exactly as it does for an
 * OPENING_BALANCE row and isCashflow() excludes both, so it never counts as
 * income, spending, or budget activity. It stays a real external transfer -
 * the ledger shows it as one - written through a guided entry point instead
 * of the generic transfer form.
 */
export async function correctStartingBalance(
  accountId: string,
  amount: number,
  date: Date,
  note: string,
): Promise<CorrectStartingBalanceResult> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, currency: true },
  });
  if (!account) return { ok: false, reason: "not_found" };
  const created = await prisma.transaction.create({
    data: {
      accountId: account.id,
      amount,
      date,
      currency: account.currency,
      type: "EXTERNAL_TRANSFER",
      transferDirection: "IN",
      source: "MANUAL",
      note,
    },
    select: { id: true },
  });
  return { ok: true, transactionId: created.id };
}

export type UpdateAccountResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  /** The account holds transactions: its currency stays (R19). */
  | { ok: false; reason: "currency_locked" };

/**
 * Renames an account or changes its type - and its currency only while it
 * holds no transaction (R19). Every row is stored in its account's currency
 * (K7); relabelling the account would leave each one read as foreign money,
 * converted at whatever today's rate is, so its balance and history would
 * drift daily and the typed figures would be lost. Money in another
 * currency belongs in a new account. The condition is part of the update
 * itself, so a row saved meanwhile is seen.
 */
export async function updateAccount(
  id: string,
  values: { name: string; currency: string; type: AccountType },
): Promise<UpdateAccountResult> {
  const updated = await prisma.account.updateMany({
    where: { id, OR: [{ currency: values.currency }, { transactions: { none: {} } }] },
    data: values,
  });
  if (updated.count === 1) return { ok: true };
  const exists = await prisma.account.findUnique({ where: { id }, select: { id: true } });
  return exists ? { ok: false, reason: "currency_locked" } : { ok: false, reason: "not_found" };
}

export async function archiveAccount(accountId: string): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
}

/**
 * Restores an archived account. Its recurring items sat unposted for as long as
 * it was archived (skipReasonFor's account_archived), and what they missed was
 * never charged, so those that can post now move to the first occurrence on or
 * after `today` instead of posting the whole stretch (skipMissedOccurrences).
 * Restoring an account that was not archived changes nothing, its items
 * included: an overdue one is a failed run's backlog, not something skipped.
 */
export async function restoreAccount(accountId: string, today: Date = todayInAppZone()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    await tx.account.update({
      where: { id: accountId },
      data: { status: "ACTIVE", archivedAt: null },
    });
    if (account?.status === "ARCHIVED") await skipMissedOccurrences({ accountId }, today, tx);
  });
}

export type DeleteAccountResult = { ok: true } | { ok: false; reason: "has_history" };

/**
 * Permanent deletion is only safe when the account has no financial history at
 * all - transactions (including both legs of a transfer, since a transfer leg
 * is a Transaction row on this account), staged items awaiting review, and
 * payday check-in snapshots. Anything else must be archived instead.
 */
export async function deleteAccountIfSafe(accountId: string): Promise<DeleteAccountResult> {
  const [transactionCount, stagedCount, snapshotCount] = await Promise.all([
    prisma.transaction.count({ where: { accountId } }),
    prisma.stagedTransaction.count({ where: { accountId } }),
    prisma.paydayAccountSnapshot.count({ where: { accountId } }),
  ]);
  if (transactionCount > 0 || stagedCount > 0 || snapshotCount > 0) {
    return { ok: false, reason: "has_history" };
  }
  await prisma.account.delete({ where: { id: accountId } });
  return { ok: true };
}

/** Carries the same shared-expense facts as a Transactions row (SharedExpenseDetails), so the ledger shows the same badges. */
export interface AccountLedgerRow extends SharedExpenseDetails {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  /** What the row was entered as, when that was another currency than the account's (K7), and the rate it was stored at. */
  originalAmount: number | null;
  originalCurrency: string | null;
  rate: number | null;
  /** Dated after today: in the running balance, not in the account's balance (see scheduled). */
  scheduled: boolean;
  /** Signed, in the account's currency. */
  effect: number;
  runningBalance: number;
  type: string;
  source: string;
  /** The user marked this income as a one-off - see Transaction.isOneOffIncome. */
  isOneOffIncome: boolean;
  transferId: string | null;
  transferDirection: string | null;
  note: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  counterpartAccountName: string | null;
}

export async function getAccountLedger(accountId: string, context: AppContext) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return null;

  const transactions = await prisma.transaction.findMany({
    where: { accountId },
    include: { category: { select: { name: true, color: true } } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const transferIds = transactions
    .map((transaction) => transaction.transferId)
    .filter((id): id is string => Boolean(id));
  const counterparts = transferIds.length
    ? await prisma.transaction.findMany({
        where: { transferId: { in: transferIds }, accountId: { not: accountId } },
        select: { transferId: true, account: { select: { name: true } } },
      })
    : [];
  const counterpartByTransfer = new Map(
    counterparts.map((row) => [row.transferId, row.account.name]),
  );
  const sharedDetails = await loadReimbursementDetails(transactions, context);

  let running = 0;
  let asOfToday = 0;
  let scheduled = 0;
  const rows: AccountLedgerRow[] = transactions.map((transaction) => {
    const money = moneyRow(transaction);
    const effect =
      balanceSign(transaction.type, transaction.transferDirection) *
      accountAmount(money, account.currency, context.rates);
    running += effect;
    const later = transaction.date.getTime() > context.today.getTime();
    if (later) scheduled += effect;
    else asOfToday += effect;
    return {
      ...(sharedDetails.get(transaction.id) as SharedExpenseDetails),
      id: transaction.id,
      date: transaction.date,
      amount: money.amount,
      currency: transaction.currency,
      originalAmount: money.originalAmount ?? null,
      originalCurrency: money.originalCurrency ?? null,
      rate: money.rate ?? null,
      scheduled: later,
      effect: round2(effect),
      runningBalance: round2(running),
      type: transaction.type,
      source: transaction.source,
      isOneOffIncome: transaction.isOneOffIncome,
      transferId: transaction.transferId,
      transferDirection: transaction.transferDirection,
      note: transaction.note,
      categoryName: transaction.category?.name ?? null,
      categoryColor: transaction.category?.color ?? null,
      counterpartAccountName: transaction.transferId
        ? (counterpartByTransfer.get(transaction.transferId) ?? null)
        : null,
    };
  });

  const inflow = rows
    .filter((row) => row.type === "INCOME")
    .reduce((total, row) => total + row.effect, 0);
  const outflow = rows
    .filter((row) => row.type === "EXPENSE")
    .reduce((total, row) => total + Math.abs(row.effect), 0);
  const transfersIn = rows
    .filter((row) => row.type === "TRANSFER" && row.effect > 0)
    .reduce((total, row) => total + row.effect, 0);
  const transfersOut = rows
    .filter((row) => row.type === "TRANSFER" && row.effect < 0)
    .reduce((total, row) => total + Math.abs(row.effect), 0);
  const externalIn = rows
    .filter((row) => row.type === "EXTERNAL_TRANSFER" && row.effect > 0)
    .reduce((total, row) => total + row.effect, 0);
  const externalOut = rows
    .filter((row) => row.type === "EXTERNAL_TRANSFER" && row.effect < 0)
    .reduce((total, row) => total + Math.abs(row.effect), 0);

  return {
    account,
    rows: rows.reverse(),
    // As of today, like the Accounts list (D42); what is dated later is apart.
    balance: round2(asOfToday),
    displayBalance: round2(
      convert(asOfToday, account.currency, context.displayCurrency, context.rates),
    ),
    scheduled: round2(scheduled),
    totals: {
      inflow: round2(inflow),
      outflow: round2(outflow),
      transfersIn: round2(transfersIn),
      transfersOut: round2(transfersOut),
      externalIn: round2(externalIn),
      externalOut: round2(externalOut),
    },
  };
}
