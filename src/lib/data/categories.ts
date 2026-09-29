import { Prisma } from "@/generated/prisma/client";
import {
  isUnused,
  protectedCategoryReason,
  type CategoryRow,
  type CategoryUsage,
  type ProtectedCategoryReason,
} from "@/lib/categories";
import { convert, type RateTable } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import type { CategoryKind } from "@/generated/prisma/enums";

export type {
  CategoryRow,
  CategoryUsage,
  ProtectedCategoryReason,
} from "@/lib/categories";

async function usageByCategory(): Promise<Map<string, CategoryUsage>> {
  const [transactions, recurringItems, budgets] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["categoryId"],
      where: { categoryId: { not: null } },
      _count: { _all: true },
    }),
    prisma.recurringItem.groupBy({
      by: ["categoryId"],
      where: { categoryId: { not: null } },
      _count: { _all: true },
    }),
    prisma.budget.groupBy({
      by: ["categoryId"],
      where: { categoryId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const usage = new Map<string, CategoryUsage>();
  const entry = (id: string) => {
    const existing = usage.get(id);
    if (existing) return existing;
    const fresh = { transactions: 0, recurringItems: 0, budgets: 0 };
    usage.set(id, fresh);
    return fresh;
  };
  for (const row of transactions) {
    if (row.categoryId) entry(row.categoryId).transactions = row._count._all;
  }
  for (const row of recurringItems) {
    if (row.categoryId) entry(row.categoryId).recurringItems = row._count._all;
  }
  for (const row of budgets) {
    if (row.categoryId) entry(row.categoryId).budgets = row._count._all;
  }
  return usage;
}

export async function getCategoryUsage(categoryId: string): Promise<CategoryUsage> {
  const [transactions, recurringItems, budgets] = await Promise.all([
    prisma.transaction.count({ where: { categoryId } }),
    prisma.recurringItem.count({ where: { categoryId } }),
    prisma.budget.count({ where: { categoryId } }),
  ]);
  return { transactions, recurringItems, budgets };
}

export async function listCategoriesWithUsage(): Promise<CategoryRow[]> {
  const [categories, usage] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    usageByCategory(),
  ]);
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    kind: category.kind,
    color: category.color,
    isSubscriptionDefault: category.isSubscriptionDefault,
    isSavingsDefault: category.isSavingsDefault,
    isEssentialFixed: category.isEssentialFixed,
    usage: usage.get(category.id) ?? { transactions: 0, recurringItems: 0, budgets: 0 },
    protectedBy: protectedCategoryReason(category),
  }));
}

export type CategoryWriteResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "name_taken" }
  /** The kind can only change while nothing has been filed under the category. */
  | { ok: false; reason: "kind_in_use"; transactions: number };

/** True when the unique-constraint on Category.name fired. */
function isNameCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Category.name is unique at the database, case-sensitively; "groceries"
 * beside "Groceries" would only confuse the by-name matching import rules
 * use, so the check here is case-insensitive.
 */
async function nameTakenByAnother(name: string, exceptId: string | null): Promise<boolean> {
  const other = await prisma.category.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return other !== null;
}

export async function createCategory(input: {
  name: string;
  kind: CategoryKind;
  color: string;
}): Promise<CategoryWriteResult> {
  if (await nameTakenByAnother(input.name, null)) return { ok: false, reason: "name_taken" };
  try {
    const created = await prisma.category.create({
      data: { name: input.name, kind: input.kind, color: input.color },
      select: { id: true },
    });
    return { ok: true, id: created.id };
  } catch (error) {
    if (isNameCollision(error)) return { ok: false, reason: "name_taken" };
    throw error;
  }
}

/**
 * Name and color always; kind only while the category has no transactions.
 * The flags (subscription/savings default, essential fixed) are not touched
 * here - the first two are seed-only, the third has its own toggle.
 */
export async function updateCategory(input: {
  id: string;
  name: string;
  kind: CategoryKind;
  color: string;
}): Promise<CategoryWriteResult> {
  const existing = await prisma.category.findUnique({
    where: { id: input.id },
    select: { id: true, kind: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (await nameTakenByAnother(input.name, input.id)) return { ok: false, reason: "name_taken" };
  if (existing.kind !== input.kind) {
    const transactions = await prisma.transaction.count({ where: { categoryId: input.id } });
    if (transactions > 0) return { ok: false, reason: "kind_in_use", transactions };
  }
  try {
    // The kind check above and this write are not one transaction; a
    // transaction filed under the category in between is a race a single
    // user cannot run, and an EXPENSE row under an INCOME category is what
    // the check exists to prevent, so the write re-checks with the same
    // condition and gives up rather than flipping the kind underneath it.
    const claimed = await prisma.category.updateMany({
      where:
        existing.kind === input.kind
          ? { id: input.id }
          : { id: input.id, transactions: { none: {} } },
      data: { name: input.name, kind: input.kind, color: input.color },
    });
    if (claimed.count === 0) {
      const transactions = await prisma.transaction.count({ where: { categoryId: input.id } });
      return transactions > 0
        ? { ok: false, reason: "kind_in_use", transactions }
        : { ok: false, reason: "not_found" };
    }
    return { ok: true, id: input.id };
  } catch (error) {
    if (isNameCollision(error)) return { ok: false, reason: "name_taken" };
    throw error;
  }
}

export type CategoryDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "protected"; protectedBy: ProtectedCategoryReason }
  /** Something still points at it; the caller shows the reassignment step with these counts. */
  | { ok: false; reason: "in_use"; usage: CategoryUsage };

/**
 * Deletes a category nothing references. Anything still filed under it is
 * reported back rather than cascaded or nulled: transactions and recurring
 * items would silently become uncategorized, and the Budget cascade would
 * erase per-period budgets nobody asked to lose.
 */
export async function deleteCategoryIfUnused(categoryId: string): Promise<CategoryDeleteResult> {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { isSubscriptionDefault: true, isSavingsDefault: true },
  });
  if (!category) return { ok: false, reason: "not_found" };
  const protectedBy = protectedCategoryReason(category);
  if (protectedBy) return { ok: false, reason: "protected", protectedBy };

  const usage = await getCategoryUsage(categoryId);
  if (!isUnused(usage)) return { ok: false, reason: "in_use", usage };

  // Re-checked inside the delete: a row filed under the category between the
  // count and the delete would otherwise be nulled by the FK.
  const deleted = await prisma.category.deleteMany({
    where: {
      id: categoryId,
      transactions: { none: {} },
      recurringItems: { none: {} },
      budgets: { none: {} },
    },
  });
  if (deleted.count === 0) {
    const stillThere = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!stillThere) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "in_use", usage: await getCategoryUsage(categoryId) };
  }
  return { ok: true };
}

export type CategoryReassignResult =
  | { ok: true; moved: CategoryUsage }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "target_not_found" }
  | { ok: false; reason: "same_category" }
  /** Expense rows under an income category (or the reverse) would corrupt every report, so the target must share the kind. */
  | { ok: false; reason: "kind_mismatch" }
  | { ok: false; reason: "protected"; protectedBy: ProtectedCategoryReason };

/**
 * The reassignment step: every Transaction and RecurringItem filed under the
 * category moves to `moveToId`, each of the category's per-period Budget rows
 * is carried over with it, and then the category is deleted - all in one
 * database transaction, so a failure part-way leaves everything where it was.
 *
 * A budget is carried over because the spending it covered moves too: dropping
 * it would shrink the period's budget while the spending moved in. Where the
 * target already has a budget for that period the two are added, in the
 * target's currency, converted at `rates` as of the merge; where it has none,
 * the merged budget moves to it as it was, currency included.
 * `moved.budgets` counts the budgets carried over either way.
 */
export async function reassignAndDeleteCategory(
  categoryId: string,
  moveToId: string,
  rates: RateTable,
): Promise<CategoryReassignResult> {
  if (categoryId === moveToId) return { ok: false, reason: "same_category" };
  const [category, target] = await Promise.all([
    prisma.category.findUnique({
      where: { id: categoryId },
      select: { kind: true, isSubscriptionDefault: true, isSavingsDefault: true },
    }),
    prisma.category.findUnique({ where: { id: moveToId }, select: { kind: true } }),
  ]);
  if (!category) return { ok: false, reason: "not_found" };
  if (!target) return { ok: false, reason: "target_not_found" };
  const protectedBy = protectedCategoryReason(category);
  if (protectedBy) return { ok: false, reason: "protected", protectedBy };
  if (category.kind !== target.kind) return { ok: false, reason: "kind_mismatch" };

  const moved = await prisma.$transaction(async (tx) => {
    const transactions = await tx.transaction.updateMany({
      where: { categoryId },
      data: { categoryId: moveToId },
    });
    const recurringItems = await tx.recurringItem.updateMany({
      where: { categoryId },
      data: { categoryId: moveToId },
    });
    // A staged (email-parsed) candidate only suggests a category, so its
    // suggestion follows the move too rather than being nulled by the FK:
    // the reviewer then sees the target pre-picked, as they would have seen
    // the removed category. No kind check - it is a hint, not a filed row.
    await tx.stagedTransaction.updateMany({
      where: { suggestedCategoryId: categoryId },
      data: { suggestedCategoryId: moveToId },
    });
    const mergedBudgets = await tx.budget.findMany({ where: { categoryId } });
    for (const budget of mergedBudgets) {
      const targetBudget = await tx.budget.findFirst({
        where: { year: budget.year, month: budget.month, period: budget.period, categoryId: moveToId },
      });
      if (!targetBudget) {
        await tx.budget.update({ where: { id: budget.id }, data: { categoryId: moveToId } });
        continue;
      }
      await tx.budget.update({
        where: { id: targetBudget.id },
        data: {
          amount: round2(
            num(targetBudget.amount) + convert(num(budget.amount), budget.currency, targetBudget.currency, rates),
          ),
        },
      });
      await tx.budget.delete({ where: { id: budget.id } });
    }
    await tx.category.delete({ where: { id: categoryId } });
    return {
      transactions: transactions.count,
      recurringItems: recurringItems.count,
      budgets: mergedBudgets.length,
    };
  });
  return { ok: true, moved };
}
