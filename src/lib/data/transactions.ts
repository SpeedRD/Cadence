import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  isOpenSharedExpense,
  reimbursementProgress,
  type ReimbursedExpenseRef,
  type ReimbursementProgress,
} from "@/lib/shared-expense";
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

/**
 * A row's shared-expense facts, the same on every listing that shows rows
 * (TransactionRow here, AccountLedgerRow in accounts.ts): loaded once per
 * page by loadReimbursementDetails, never stored.
 */
export interface SharedExpenseDetails {
  /** The user's own part of a shared expense's amount, in the row's currency, or null - see Transaction.yourShare. */
  yourShare: number | null;
  /**
   * For a shared expense: how far its linked deposits have paid the rest
   * back, in the row's own currency (src/lib/shared-expense.ts). Re-summed
   * from the linked rows on every read. Null on any other row.
   */
  reimbursement: ReimbursementProgress | null;
  /** For a deposit that pays back a shared expense: that expense, to name it by. Null on any other row. */
  reimburses: ReimbursedExpenseRef | null;
}

export interface TransactionRow extends SharedExpenseDetails {
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
  /** The user marked this expense as a one-off - see Transaction.isExtraordinary. */
  isExtraordinary: boolean;
  /** The shared expense this INCOME row pays back, or null - see Transaction.reimbursesTransactionId. */
  reimbursesTransactionId: string | null;
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

  const sharedDetails = await loadReimbursementDetails(transactions, context);

  const rows: TransactionRow[] = transactions.map((transaction) => {
    const contributionKey = recurringContributionKeyFromTransaction(transaction);
    const counterpart = counterparts.find(
      (row) =>
        row.transferId === transaction.transferId && row.id !== transaction.id,
    );
    // Every row has an entry (see loadReimbursementDetails).
    const details = sharedDetails.get(transaction.id) as SharedExpenseDetails;
    return {
      ...details,
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
      isExtraordinary: transaction.isExtraordinary,
      reimbursesTransactionId: transaction.reimbursesTransactionId,
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

/**
 * The linked deposits of each shared expense in `expenseIds`, summed into
 * that expense's own currency (a deposit in another currency converts at the
 * current rate, as every cross-currency figure here does). Expenses with no
 * deposit yet are simply absent from the map.
 */
async function sumReimbursements(
  expenseIds: string[],
  expenses: { id: string; currency: string }[],
  context: AppContext,
): Promise<Map<string, number>> {
  if (expenseIds.length === 0) return new Map();
  const currencyById = new Map(expenses.map((expense) => [expense.id, expense.currency]));
  const deposits = await prisma.transaction.findMany({
    where: { type: "INCOME", reimbursesTransactionId: { in: expenseIds } },
    select: { reimbursesTransactionId: true, amount: true, currency: true },
  });
  const recovered = new Map<string, number>();
  for (const deposit of deposits) {
    const expenseId = deposit.reimbursesTransactionId as string;
    const currency = currencyById.get(expenseId);
    if (!currency) continue;
    recovered.set(
      expenseId,
      (recovered.get(expenseId) ?? 0) +
        convert(num(deposit.amount), deposit.currency, currency, context.rates),
    );
  }
  return recovered;
}

/**
 * Every listed row's shared-expense facts (SharedExpenseDetails), keyed by
 * row id: for a shared expense, its share and how far its linked deposits
 * have paid the rest back; for a deposit that pays one back, that expense's
 * description. Two lookups per page at most - one for the page's shared
 * expenses' deposits, one for the expenses its deposits point at - the same
 * one-lookup-per-pairing shape listTransactions already uses for goal
 * contributions and transfer legs. Every row gets an entry, so a listing
 * can spread it in unconditionally.
 */
export async function loadReimbursementDetails(
  rows: readonly {
    id: string;
    amount: { toString(): string };
    currency: string;
    yourShare: { toString(): string } | null;
    reimbursesTransactionId: string | null;
  }[],
  context: AppContext,
): Promise<Map<string, SharedExpenseDetails>> {
  const shared = rows.filter((row) => row.yourShare !== null);
  const reimbursedIds = [
    ...new Set(
      rows
        .map((row) => row.reimbursesTransactionId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const [recoveredById, reimbursed] = await Promise.all([
    sumReimbursements(
      shared.map((row) => row.id),
      shared,
      context,
    ),
    reimbursedIds.length
      ? prisma.transaction.findMany({
          where: { id: { in: reimbursedIds } },
          select: { id: true, note: true, category: { select: { name: true } } },
        })
      : [],
  ]);
  const reimbursedById = new Map(
    reimbursed.map((expense) => [
      expense.id,
      { note: expense.note, categoryName: expense.category?.name ?? null },
    ]),
  );

  return new Map(
    rows.map((row) => {
      const yourShare = row.yourShare === null ? null : num(row.yourShare);
      return [
        row.id,
        {
          yourShare,
          reimbursement:
            yourShare === null
              ? null
              : reimbursementProgress(
                  { amount: num(row.amount), yourShare },
                  recoveredById.get(row.id) ?? 0,
                ),
          reimburses:
            row.reimbursesTransactionId === null
              ? null
              : (reimbursedById.get(row.reimbursesTransactionId) ?? null),
        },
      ];
    }),
  );
}

/** A shared expense the reimbursement picker can offer, with what is still owed on it. */
export interface OpenSharedExpense {
  id: string;
  date: Date;
  note: string | null;
  categoryName: string | null;
  amount: number;
  yourShare: number;
  currency: string;
  reimbursement: ReimbursementProgress;
}

/**
 * The shared expenses a new deposit can be linked to: every EXPENSE with a
 * share whose linked deposits so far come to less than what others owe on it
 * (src/lib/shared-expense.ts), newest first. `keepIds` - the expenses that
 * deposits already on the page point at - are included even when settled, so
 * editing such a deposit shows its current link instead of silently dropping
 * it.
 */
export async function listOpenSharedExpenses(
  context: AppContext,
  keepIds: readonly string[] = [],
): Promise<OpenSharedExpense[]> {
  const expenses = await prisma.transaction.findMany({
    where: { type: "EXPENSE", yourShare: { not: null } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      date: true,
      note: true,
      amount: true,
      yourShare: true,
      currency: true,
      category: { select: { name: true } },
    },
  });
  if (expenses.length === 0) return [];
  const recoveredById = await sumReimbursements(
    expenses.map((expense) => expense.id),
    expenses,
    context,
  );
  return expenses.flatMap((expense) => {
    const amount = num(expense.amount);
    const yourShare = num(expense.yourShare);
    const recovered = recoveredById.get(expense.id) ?? 0;
    if (!keepIds.includes(expense.id) && !isOpenSharedExpense({ amount, yourShare }, recovered)) {
      return [];
    }
    return [
      {
        id: expense.id,
        date: expense.date,
        note: expense.note,
        categoryName: expense.category?.name ?? null,
        amount,
        yourShare,
        currency: expense.currency,
        reimbursement: reimbursementProgress({ amount, yourShare }, recovered),
      },
    ];
  });
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
