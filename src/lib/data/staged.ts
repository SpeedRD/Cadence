import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import type { StagedStatus, TransactionSource } from "@/generated/prisma/enums";

export interface StagedRow {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  rawDescription: string;
  source: TransactionSource;
  status: StagedStatus;
  accountId: string | null;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  createdAt: Date;
  parsedAt: Date | null;
  reviewedAt: Date | null;
}

export async function listStagedTransactions(options: {
  includeReviewed: boolean;
}): Promise<StagedRow[]> {
  const rows = await prisma.stagedTransaction.findMany({
    where: options.includeReviewed ? {} : { status: "PENDING" },
    include: { suggestedCategory: { select: { name: true } } },
    orderBy: [{ source: "asc" }, { date: "desc" }, { createdAt: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    amount: num(row.amount),
    currency: row.currency,
    rawDescription: row.rawDescription,
    source: row.source,
    status: row.status,
    accountId: row.accountId,
    suggestedCategoryId: row.suggestedCategoryId,
    suggestedCategoryName: row.suggestedCategory?.name ?? null,
    createdAt: row.createdAt,
    parsedAt: row.parsedAt,
    reviewedAt: row.reviewedAt,
  }));
}
