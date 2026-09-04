"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import {
  logManualContribution,
  rebuildGoalSaved,
  recomputeGoalSaved,
  removeContribution,
} from "@/lib/goals";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { checkReferences } from "@/lib/references";
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
 * from them after every write. A contribution also moves the money out of the
 * chosen account - see logManualContribution for the paired Transaction.
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
  // Same check the transaction form runs: the account must still exist and,
  // since this writes a new row against it, still be active.
  const referenceError = await checkReferences(
    getDictionary(locale).transactions,
    [parsed.data.accountId],
    null,
    true,
  );
  if (referenceError) return fail(referenceError);

  await logManualContribution({
    goalId: goal.id,
    accountId: parsed.data.accountId,
    amount: parsed.data.amount,
    date: parsed.data.date,
    note: parsed.data.note,
  });
  const { justAchieved } = await rebuildGoalSaved(goal.id);

  revalidateApp();
  return done(
    t.contributionLogged,
    justAchieved ? { achievedGoalId: goal.id } : undefined,
  );
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
    select: { id: true, goalId: true, accountId: true },
  });
  if (!contribution) return fail(t.contributionNoLongerExists);

  await removeContribution(contribution);
  await recomputeGoalSaved(contribution.goalId);

  revalidateApp();
  return done(t.contributionRemoved);
}
