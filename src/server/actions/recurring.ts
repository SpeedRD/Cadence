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

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.recurringItem.update({ where: { id }, data: values });
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
