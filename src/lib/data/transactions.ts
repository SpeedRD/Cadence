import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

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
          account: { select: { name: true } },
        },
      })
    : [];

  const rows: TransactionRow[] = transactions.map((transaction) => {
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
