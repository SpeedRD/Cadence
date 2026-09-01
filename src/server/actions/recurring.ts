"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError, formObject, recurringSchema } from "@/lib/validation";

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
