"use server";

import { archiveAccount, deleteAccountIfSafe, restoreAccount } from "@/lib/data/accounts";
import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { accountSchema, firstError, formObject } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const parsed = accountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.account.update({ where: { id }, data: values });
  } else {
    await prisma.account.create({ data: values });
  }

  revalidateApp();
  return done(id ? t.accountUpdated : t.accountAdded);
}

export async function archiveAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.accountNoLongerExists);

  await archiveAccount(id);

  revalidateApp();
  return done(t.accountArchived);
}

export async function restoreAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.accountNoLongerExists);

  await restoreAccount(id);

  revalidateApp();
  return done(t.accountRestored);
}

export async function deleteAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(common.nothingToDelete);

  const result = await deleteAccountIfSafe(id);
  if (!result.ok) return fail(t.archiveInstead);

  revalidateApp();
  return done(t.accountDeleted);
}
