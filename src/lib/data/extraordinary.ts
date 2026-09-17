import { convert } from "@/lib/currency";
import { addMonths } from "@/lib/date";
import {
  classifyExtraordinary,
  EXTRAORDINARY_LOOKBACK_MONTHS,
  type ExtraordinaryClassification,
} from "@/lib/extraordinary";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import type { AppContext } from "@/lib/data/context";

/** One new expense to measure against its category's recent history. */
export interface ExtraordinaryCandidate<K> {
  /** Whatever the caller uses to find the row again - a CSV row index, say. */
  key: K;
  categoryId: string;
  amount: number;
  currency: string;
}

export interface ExtraordinaryHit extends ExtraordinaryClassification {
  categoryId: string;
  categoryName: string;
  /** `median` and the candidate are compared in this currency - the display currency. */
  currency: string;
}

/**
 * Which of the candidates look extraordinary for their own category: above
 * EXTRAORDINARY_MULTIPLIER x the median of the category's organic EXPENSE
 * amounts over the last EXTRAORDINARY_LOOKBACK_MONTHS. The history is the
 * same rows the category-suggestion average reads - EXPENSE transactions
 * filed under the category - minus the two kinds it cannot speak for:
 * RECURRING rows (scheduled amounts, not organic spending) and one-offs
 * already confirmed extraordinary. Amounts are compared in the display
 * currency so a category paid in two currencies still has one median.
 *
 * Only candidates that trip the threshold come back; a category with too
 * little history yields nothing (see classifyExtraordinary). The map is keyed
 * by the caller's own key. Reads only - nothing is written or decided here.
 */
export async function findExtraordinaryCandidates<K>(
  candidates: readonly ExtraordinaryCandidate<K>[],
  context: AppContext,
): Promise<Map<K, ExtraordinaryHit>> {
  const hits = new Map<K, ExtraordinaryHit>();
  const categoryIds = [...new Set(candidates.map((candidate) => candidate.categoryId))];
  if (categoryIds.length === 0) return hits;

  const [history, categories] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        type: "EXPENSE",
        source: { not: "RECURRING" },
        isExtraordinary: false,
        categoryId: { in: categoryIds },
        date: { gte: addMonths(context.today, -EXTRAORDINARY_LOOKBACK_MONTHS) },
      },
      select: { categoryId: true, amount: true, currency: true },
    }),
    prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    }),
  ]);

  const toDisplay = (amount: number, currency: string) =>
    convert(amount, currency, context.displayCurrency, context.rates);
  const priorByCategory = new Map<string, number[]>();
  for (const row of history) {
    const list = priorByCategory.get(row.categoryId as string) ?? [];
    list.push(toDisplay(num(row.amount), row.currency));
    priorByCategory.set(row.categoryId as string, list);
  }
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));

  for (const candidate of candidates) {
    const verdict = classifyExtraordinary(
      priorByCategory.get(candidate.categoryId) ?? [],
      toDisplay(candidate.amount, candidate.currency),
    );
    if (!verdict?.possiblyExtraordinary) continue;
    hits.set(candidate.key, {
      ...verdict,
      median: round2(verdict.median),
      categoryId: candidate.categoryId,
      categoryName: categoryNameById.get(candidate.categoryId) ?? "",
      currency: context.displayCurrency,
    });
  }
  return hits;
}
