"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError, formObject, recurringAccountSchema, recurringSchema } from "@/lib/validation";

import { setRecurringItemAccount } from "@/lib/data/recurring";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveRecurringAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const parsed = recurringSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, updatedAt, ...values } = parsed.data;

  // Posting refuses an item on an archived account, so saving one here would
  // create something that silently never posts. Checking the category and goal
  // too keeps a stale id from arriving as a raw foreign-key error.
  const account = await prisma.account.findUnique({
    where: { id: values.accountId },
    select: { status: true },
  });
  if (!account) return fail(t.accountNoLongerActive);
  if (account.status !== "ACTIVE") return fail(t.accountNoLongerActive);
  if (values.categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: values.categoryId },
      select: { id: true },
    });
    if (!category) return fail(t.categoryNoLongerExists);
  }
  if (values.goalId) {
    const goal = await prisma.goal.findUnique({
      where: { id: values.goalId },
      select: { id: true },
    });
    if (!goal) return fail(t.goalNoLongerExists);
  }

  if (id) {
    // This form posts every field, including ones it only read. If something
    // else changed the item while the form was open - the payday wizard
    // reassigning its account in another tab is the case that bites - saving
    // would write the stale value back over it. The updatedAt the form was
    // rendered with is the guard: no rows match once the item has moved on, and
    // the user is told to reopen rather than silently undoing the other change.
    const claimed = await prisma.recurringItem.updateMany({
      where: updatedAt ? { id, updatedAt } : { id },
      data: values,
    });
    if (claimed.count === 0) {
      const stillThere = await prisma.recurringItem.findUnique({
        where: { id },
        select: { id: true },
      });
      return fail(stillThere ? t.itemChangedElsewhere : t.itemNoLongerExists);
    }
  } else {
    await prisma.recurringItem.create({ data: values });
  }

  revalidateApp();
  return done(id ? t.itemUpdated : t.itemAdded);
}

export async function deleteRecurringAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(common.nothingToDelete);
  await prisma.recurringItem.delete({ where: { id } });
  revalidateApp();
  return done(t.itemDeleted);
}

export async function toggleRecurringAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const id = String(formData.get("id") ?? "").trim();
  const item = await prisma.recurringItem.findUnique({ where: { id } });
  if (!item) return fail(t.itemNoLongerExists);

  await prisma.recurringItem.update({
    where: { id },
    data: { active: !item.active },
  });
  revalidateApp();
  return done(item.active ? t.itemPaused : t.itemResumed);
}

/**
 * Repoints one recurring item at another account - the account field of
 * saveRecurringAction's form on its own, for the payday check-in's Step 3
 * where reassigning a subscription is the whole edit. Same column, same
 * revalidation, so the Recurring page shows the change immediately.
 */
export async function reassignRecurringAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const parsed = recurringAccountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const account = await prisma.account.findFirst({
    where: { id: parsed.data.accountId, status: "ACTIVE" },
  });
  if (!account) return fail(t.accountNoLongerActive);
  if (!(await setRecurringItemAccount(parsed.data.id, parsed.data.accountId))) {
    return fail(t.itemNoLongerExists);
  }

  revalidateApp();
  return done(t.itemUpdated);
}
