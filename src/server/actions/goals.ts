"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { recomputeGoalSaved } from "@/lib/goals";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import {
  contributionSchema,
  firstError,
  formObject,
  goalSchema,
} from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveGoalAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = goalSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.goal.update({ where: { id }, data: values });
    // The currency may have changed, which changes what the cache should hold.
    await recomputeGoalSaved(id);
  } else {
    await prisma.goal.create({ data: values });
  }

  revalidateApp();
  return done(id ? t.goalUpdated : t.goalCreated);
}

export async function deleteGoalAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(common.nothingToDelete);
  await prisma.goal.delete({ where: { id } });
  revalidateApp();
  return done(t.goalDeleted);
}

/**
 * Contributions are the source of truth; the cached Goal.savedAmount is rebuilt
 * from them after every write.
 */
export async function addContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = contributionSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const goal = await prisma.goal.findUnique({
    where: { id: parsed.data.goalId },
    select: { id: true, currency: true },
  });
  if (!goal) return fail(t.goalNoLongerExists);

  await prisma.goalContribution.create({
    data: {
      goalId: goal.id,
      amount: parsed.data.amount,
      currency: goal.currency,
      date: parsed.data.date,
      note: parsed.data.note,
    },
  });
  await recomputeGoalSaved(goal.id);

  revalidateApp();
  return done(t.contributionLogged);
}

export async function deleteContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const id = String(formData.get("id") ?? "").trim();
  const contribution = await prisma.goalContribution.findUnique({
    where: { id },
    select: { goalId: true },
  });
  if (!contribution) return fail(t.contributionNoLongerExists);

  await prisma.goalContribution.delete({ where: { id } });
  await recomputeGoalSaved(contribution.goalId);

  revalidateApp();
  return done(t.contributionRemoved);
}
