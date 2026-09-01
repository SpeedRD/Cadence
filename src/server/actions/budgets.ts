"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
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
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).budgets;
  const parsed = budgetSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { year, month, period, categoryId, amount, currency } = parsed.data;
  const existing = await prisma.budget.findFirst({
    where: { year, month, period, categoryId },
  });

  if (amount === null) {
    if (existing) await prisma.budget.delete({ where: { id: existing.id } });
    revalidateApp();
    return done(t.budgetCleared);
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
  return done(t.budgetSaved);
}

export async function copyPreviousBudgetsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).budgets;
  const year = Number(formData.get("year"));
  const month = Number(formData.get("month"));
  const period = String(formData.get("period") ?? "") as PayPeriodCode;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !"AB".includes(period)) {
    return fail(t.pickPeriodFirst);
  }

  const source = previousPeriod({ year, month, period });
  const [sourceBudgets, targetBudgets] = await Promise.all([
    prisma.budget.findMany({
      where: { year: source.year, month: source.month, period: source.period },
    }),
    prisma.budget.findMany({ where: { year, month, period } }),
  ]);

  if (sourceBudgets.length === 0) {
    return fail(t.noBudgetToCopy);
  }

  const existingKeys = new Set(
    targetBudgets.map((budget) => budget.categoryId ?? "overall"),
  );
  const toCreate = sourceBudgets.filter(
    (budget) => !existingKeys.has(budget.categoryId ?? "overall"),
  );

  if (toCreate.length === 0) {
    return fail(t.everyBudgetAlreadyCopied);
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
  return done(t.copiedForward(toCreate.length));
}
