import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { balanceSign } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import { Prisma } from "@/generated/prisma/client";
import type { AccountStatus, AccountType } from "@/generated/prisma/enums";

export interface AccountBalance {
  id: string;
  name: string;
  type: AccountType;
  status: AccountStatus;
  currency: string;
  createdAt: Date;
  /** In the account's own currency. */
  balance: number;
  /** Same balance converted to the selected display currency. */
  displayBalance: number;
  transactionCount: number;
  /** Transactions other than the opening balance itself - gates the "Set opening balance" action. */
  otherTransactionCount: number;
  openingBalance: { id: string; amount: number; date: Date } | null;
}

export type AccountStatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

/**
 * Balances are aggregated in SQL per (account, type, currency, direction) and
 * converted afterwards, so a foreign-currency transaction lands in the account's
 * own currency. Transfers net to zero across their two legs.
 *
 * Defaults to active accounts only - the dynamic "active accounts" list the
 * payday check-in and every "pick an account" selector must use. Pass
 * { status: "ARCHIVED" } or { status: "ALL" } for historical/admin views.
 */
export async function getAccountBalances(
  context: AppContext,
  options: { status?: AccountStatusFilter } = {},
): Promise<AccountBalance[]> {
  const status = options.status ?? "ACTIVE";
  const [accounts, groups, counts, openingBalances] = await Promise.all([
    prisma.account.findMany({
      where: status === "ALL" ? undefined : { status },
      orderBy: { name: "asc" },
    }),
    prisma.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({ by: ["accountId", "type"], _count: { _all: true } }),
    prisma.transaction.findMany({
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
    const balance = groups
      .filter((group) => group.accountId === account.id)
      .reduce((total, group) => {
        const amount = convert(
          num(group._sum.amount),
          group.currency,
          account.currency,
          context.rates,
        );
        return total + balanceSign(group.type, group.transferDirection) * amount;
      }, 0);

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
      transactionCount: countsByAccount.get(account.id) ?? 0,
      otherTransactionCount: otherCountsByAccount.get(account.id) ?? 0,
      openingBalance: openingBalanceByAccount.get(account.id) ?? null,
    };
  });
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

export async function archiveAccount(accountId: string): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
}

export async function restoreAccount(accountId: string): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: "ACTIVE", archivedAt: null },
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

export interface AccountLedgerRow {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  /** Signed, in the account's currency. */
  effect: number;
  runningBalance: number;
  type: string;
  source: string;
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

  let running = 0;
  const rows: AccountLedgerRow[] = transactions.map((transaction) => {
    const amountInAccountCurrency = convert(
      num(transaction.amount),
      transaction.currency,
      account.currency,
      context.rates,
    );
    const effect =
      balanceSign(transaction.type, transaction.transferDirection) *
      amountInAccountCurrency;
    running += effect;
    return {
      id: transaction.id,
      date: transaction.date,
      amount: num(transaction.amount),
      currency: transaction.currency,
      effect: round2(effect),
      runningBalance: round2(running),
      type: transaction.type,
      source: transaction.source,
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
    balance: round2(running),
    displayBalance: round2(
      convert(running, account.currency, context.displayCurrency, context.rates),
    ),
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
