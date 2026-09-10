import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { recurringContributionKeyFromTransaction } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import type { Prisma } from "@/generated/prisma/client";

export const PAGE_SIZE = 50;

export interface TransactionFilters {
  accountId?: string;
  categoryId?: string;
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  query?: string;
  page?: number;
}

export interface TransactionRow {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  displayAmount: number;
  type: string;
  source: string;
  /** Read by transactionEditBlock to recognise the expense a goal contribution wrote. */
  externalId: string | null;
  /**
   * True for a RECURRING row that a GoalContribution was posted beside (see
   * recurringExternalId on GoalContribution). transactionEditBlock cannot
   * tell such a row from a subscription's - both carry "<itemId>:<date>" -
   * so listTransactions looks the pairing up once per page and the table
   * locks the row up front, as the actions would refuse it after the fact.
   */
  hasLinkedGoalContribution: boolean;
  note: string | null;
  transferId: string | null;
  transferDirection: string | null;
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  counterpartAccountName: string | null;
  counterpartAccountId: string | null;
  /** The other leg's own figure - differs from this row's on a cross-currency transfer with a declared received amount. */
  counterpartAmount: number | null;
  counterpartCurrency: string | null;
}

function buildWhere(filters: TransactionFilters): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {};
  if (filters.accountId) where.accountId = filters.accountId;
  if (filters.categoryId === "none") where.categoryId = null;
  else if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.type) where.type = filters.type as Prisma.EnumTransactionTypeFilter;
  if (filters.source) where.source = filters.source as Prisma.EnumTransactionSourceFilter;
  if (filters.from || filters.to) {
    where.date = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (filters.query) {
    where.note = { contains: filters.query, mode: "insensitive" };
  }
  return where;
}

export async function listTransactions(
  filters: TransactionFilters,
  context: AppContext,
) {
  const where = buildWhere(filters);
  const page = Math.max(1, filters.page ?? 1);

  const [total, transactions] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, color: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const transferIds = transactions
    .map((transaction) => transaction.transferId)
    .filter((id): id is string => Boolean(id));
  const counterparts = transferIds.length
    ? await prisma.transaction.findMany({
        where: { transferId: { in: transferIds } },
        select: {
          id: true,
          transferId: true,
          transferDirection: true,
          accountId: true,
          amount: true,
          currency: true,
          account: { select: { name: true } },
        },
      })
    : [];

  const contributionKeys = transactions
    .map((transaction) => recurringContributionKeyFromTransaction(transaction))
    .filter((key): key is string => key !== null);
  const pairedKeys = new Set(
    contributionKeys.length
      ? (
          await prisma.goalContribution.findMany({
            where: { recurringExternalId: { in: contributionKeys } },
            select: { recurringExternalId: true },
          })
        ).map((contribution) => contribution.recurringExternalId)
      : [],
  );

  const rows: TransactionRow[] = transactions.map((transaction) => {
    const contributionKey = recurringContributionKeyFromTransaction(transaction);
    const counterpart = counterparts.find(
      (row) =>
        row.transferId === transaction.transferId && row.id !== transaction.id,
    );
    return {
      id: transaction.id,
      date: transaction.date,
      amount: num(transaction.amount),
      currency: transaction.currency,
      displayAmount: round2(
        convert(
          num(transaction.amount),
          transaction.currency,
          context.displayCurrency,
          context.rates,
        ),
      ),
      type: transaction.type,
      source: transaction.source,
      externalId: transaction.externalId,
      hasLinkedGoalContribution: contributionKey !== null && pairedKeys.has(contributionKey),
      note: transaction.note,
      transferId: transaction.transferId,
      transferDirection: transaction.transferDirection,
      accountId: transaction.accountId,
      accountName: transaction.account.name,
      categoryId: transaction.categoryId,
      categoryName: transaction.category?.name ?? null,
      categoryColor: transaction.category?.color ?? null,
      counterpartAccountName: counterpart?.account.name ?? null,
      counterpartAccountId: counterpart?.accountId ?? null,
      counterpartAmount: counterpart ? num(counterpart.amount) : null,
      counterpartCurrency: counterpart?.currency ?? null,
    };
  });

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/** Totals for the filtered set, transfers excluded. */
export async function summarizeTransactions(
  filters: TransactionFilters,
  context: AppContext,
) {
  const where = buildWhere(filters);
  const groups = await prisma.transaction.groupBy({
    by: ["type", "currency"],
    where,
    _sum: { amount: true },
  });

  let income = 0;
  let expense = 0;
  for (const group of groups) {
    const amount = convert(
      num(group._sum.amount),
      group.currency,
      context.displayCurrency,
      context.rates,
    );
    if (group.type === "INCOME") income += amount;
    if (group.type === "EXPENSE") expense += amount;
  }
  return { income: round2(income), expense: round2(expense) };
}
