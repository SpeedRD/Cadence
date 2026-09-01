"use server";

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

  await prisma.account.update({
    where: { id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

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

  await prisma.account.update({
    where: { id },
    data: { status: "ACTIVE", archivedAt: null },
  });

  revalidateApp();
  return done(t.accountRestored);
}

/**
 * Permanent deletion is only safe when the account has no financial history at
 * all - transactions (including both legs of a transfer, since a transfer leg
 * is a Transaction row on this account), staged items awaiting review, and
 * payday check-in snapshots. Anything else must be archived instead.
 */
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

  const [transactionCount, stagedCount, snapshotCount] = await Promise.all([
    prisma.transaction.count({ where: { accountId: id } }),
    prisma.stagedTransaction.count({ where: { accountId: id } }),
    prisma.paydayAccountSnapshot.count({ where: { accountId: id } }),
  ]);
  if (transactionCount > 0 || stagedCount > 0 || snapshotCount > 0) {
    return fail(t.archiveInstead);
  }

  await prisma.account.delete({ where: { id } });

  revalidateApp();
  return done(t.accountDeleted);
}
