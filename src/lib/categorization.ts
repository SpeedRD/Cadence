/**
 * Server-side categorization helpers. The deterministic rules themselves live
 * in src/lib/categorization-rules.ts (no Prisma import, safe for client
 * bundles too — see src/lib/import-grouping.ts); this file re-exports them
 * for existing callers and adds the one function that actually needs the
 * database.
 */
import { prisma } from "@/lib/prisma";

export {
  EXPLICIT_NO_CATEGORY,
  resolveImportCategoryId,
  suggestCategoryName,
} from "@/lib/categorization-rules";
import { resolveImportCategoryId } from "@/lib/categorization-rules";

/**
 * One-time cleanup for transactions imported before automatic categorization
 * existed: assigns a category to every EXPENSE transaction that's still
 * Uncategorized, using the exact same resolution rules CSV import already
 * applies. Only touches EXPENSE rows with categoryId null - never income,
 * transfers, opening balances, or a transaction that already has a category
 * (manually chosen or otherwise). A row whose merchant matches no rule is
 * queried again on the next run but still resolves to no match, so running
 * this repeatedly is a no-op once every matchable row has been categorized.
 */
export async function backfillUncategorizedTransactions(): Promise<number> {
  const [candidates, categories] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "EXPENSE", categoryId: null },
      select: { id: true, note: true },
    }),
    prisma.category.findMany({ select: { id: true, name: true } }),
  ]);
  if (candidates.length === 0) return 0;

  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const categoryIdByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category.id]),
  );

  let updated = 0;
  for (const transaction of candidates) {
    const categoryId = resolveImportCategoryId({
      explicitCategoryId: null,
      note: transaction.note,
      type: "EXPENSE",
      knownCategoryIds,
      categoryIdByName,
    });
    if (!categoryId) continue;
    await prisma.transaction.update({ where: { id: transaction.id }, data: { categoryId } });
    updated += 1;
  }
  return updated;
}
