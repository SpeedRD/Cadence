import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { balanceSign } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import type { AccountType } from "@/generated/prisma/enums";

export interface AccountBalance {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  createdAt: Date;
  /** In the account's own currency. */
  balance: number;
  /** Same balance converted to the selected display currency. */
  displayBalance: number;
  transactionCount: number;
}

/**
 * Balances are aggregated in SQL per (account, type, currency, direction) and
 * converted afterwards, so a foreign-currency transaction lands in the account's
 * own currency. Transfers net to zero across their two legs.
 */
export async function getAccountBalances(
  context: AppContext,
): Promise<AccountBalance[]> {
  const [accounts, groups, counts] = await Promise.all([
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({ by: ["accountId"], _count: { _all: true } }),
  ]);

  const countByAccount = new Map(
    counts.map((row) => [row.accountId, row._count._all]),
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
      currency: account.currency,
      createdAt: account.createdAt,
      balance: round2(balance),
      displayBalance: round2(
        convert(balance, account.currency, context.displayCurrency, context.rates),
      ),
      transactionCount: countByAccount.get(account.id) ?? 0,
    };
  });
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
    },
  };
}
