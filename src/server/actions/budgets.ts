"use server";

import { requireAuth } from "@/lib/auth";
import { previousPeriod, type PayPeriodCode } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { budgetSchema, firstError, formObject } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

/**
 * One budget per (year, month, period, categoryId). The overall budget uses a
 * null categoryId, which a plain composite UNIQUE cannot keep unique - the
 * partial index in the migration does that, and this find-then-write keeps the
 * app from ever attempting a duplicate in the first place.
 * An empty amount clears the budget.
 */
export async function saveBudgetAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const parsed = budgetSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error));

  const { year, month, period, categoryId, amount, currency } = parsed.data;
  const existing = await prisma.budget.findFirst({
    where: { year, month, period, categoryId },
  });

  if (amount === null) {
    if (existing) await prisma.budget.delete({ where: { id: existing.id } });
    revalidateApp();
    return done("Budget cleared");
  }

  if (existing) {
    await prisma.budget.update({
      where: { id: existing.id },
      data: { amount, currency },
    });
  } else {
    await prisma.budget.create({
      data: { year, month, period, categoryId, amount, currency },
    });
  }

  revalidateApp();
  return done("Budget saved");
}

export async function copyPreviousBudgetsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const year = Number(formData.get("year"));
  const month = Number(formData.get("month"));
  const period = String(formData.get("period") ?? "") as PayPeriodCode;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !"AB".includes(period)) {
    return fail("Pick a period first");
  }

  const source = previousPeriod({ year, month, period });
  const [sourceBudgets, targetBudgets] = await Promise.all([
    prisma.budget.findMany({
      where: { year: source.year, month: source.month, period: source.period },
    }),
    prisma.budget.findMany({ where: { year, month, period } }),
  ]);

  if (sourceBudgets.length === 0) {
    return fail("The previous period has no budget to copy");
  }

  const existingKeys = new Set(
    targetBudgets.map((budget) => budget.categoryId ?? "overall"),
  );
  const toCreate = sourceBudgets.filter(
    (budget) => !existingKeys.has(budget.categoryId ?? "overall"),
  );

  if (toCreate.length === 0) {
    return fail("This period already has every budget from last period");
  }

  await prisma.budget.createMany({
    data: toCreate.map((budget) => ({
      year,
      month,
      period,
      categoryId: budget.categoryId,
      amount: budget.amount,
      currency: budget.currency,
    })),
  });

  revalidateApp();
  return done(
    `Copied ${toCreate.length} budget${toCreate.length === 1 ? "" : "s"} forward`,
  );
}
