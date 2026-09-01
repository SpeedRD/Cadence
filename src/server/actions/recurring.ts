"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { isLocale } from "@/lib/i18n";
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
  const parsed = recurringSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.recurringItem.update({ where: { id }, data: values });
  } else {
    await prisma.recurringItem.create({ data: values });
  }

  revalidateApp();
  return done(id ? "Recurring item updated" : "Recurring item added");
}

export async function deleteRecurringAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Nothing to delete");
  await prisma.recurringItem.delete({ where: { id } });
  revalidateApp();
  return done("Recurring item deleted");
}

export async function toggleRecurringAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  const item = await prisma.recurringItem.findUnique({ where: { id } });
  if (!item) return fail("That item no longer exists");

  await prisma.recurringItem.update({
    where: { id },
    data: { active: !item.active },
  });
  revalidateApp();
  return done(item.active ? "Paused" : "Resumed");
}
