"use server";

import { randomUUID } from "node:crypto";

import { getSettings, requireAuth } from "@/lib/auth";
import { backfillUncategorizedTransactions } from "@/lib/categorization";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { transactionEditBlock } from "@/lib/transactions";
import {
  firstError,
  formObject,
  transactionSchema,
  transferSchema,
} from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

/**
 * Confirms the rows a write is about to point at actually exist, and that a new
 * row is not being filed against an archived account. Without this a stale id -
 * a category deleted in another tab, an account archived since the form
 * opened - reached the database and came back as a raw foreign-key error.
 * Editing an existing row accepts an archived account, since its history has to
 * stay editable; only creating something new requires an active one.
 */
async function checkReferences(
  t: ReturnType<typeof getDictionary>["transactions"],
  accountIds: string[],
  categoryId: string | null,
  requireActiveAccounts: boolean,
): Promise<string | null> {
  for (const accountId of accountIds) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (!account) return t.accountNoLongerExists;
    if (requireActiveAccounts && account.status !== "ACTIVE") return t.accountNoLongerActive;
  }
  if (categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) return t.categoryNoLongerExists;
  }
  return null;
}

export async function saveTransactionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;
  const parsed = transactionSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;

  const referenceError = await checkReferences(t, [values.accountId], values.categoryId, !id);
  if (referenceError) return fail(referenceError);

  if (id) {
    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing) return fail(t.transactionNoLongerExists);
    const block = transactionEditBlock(existing);
    if (block === "transfer") return fail(t.editFromTransferForm);
    if (block === "opening_balance") return fail(t.editOpeningBalanceFromAccounts);
    await prisma.transaction.update({ where: { id }, data: values });
  } else {
    await prisma.transaction.create({ data: { ...values, source: "MANUAL" } });
  }

  revalidateApp();
  return done(id ? t.transactionUpdated : t.transactionAdded);
}

export async function deleteTransactionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.nothingToDelete);

  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing) return fail(t.transactionNoLongerExists);

  // Deleting one leg of a transfer removes both, so balances stay consistent.
  if (existing.transferId) {
    await prisma.transaction.deleteMany({
      where: { transferId: existing.transferId },
    });
  } else {
    await prisma.transaction.delete({ where: { id } });
  }

  revalidateApp();
  return done(t.transactionDeleted);
}

/** One-time cleanup: categorize existing Uncategorized expenses using the same rules CSV import applies. */
export async function backfillCategorizationAction(
  _previous: ActionState,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const count = await backfillUncategorizedTransactions();
  revalidateApp();
  return done(t.categorizationBackfilled(count));
}

/**
 * A transfer is two linked rows - a debit on the source account and a credit on
 * the destination - written in one database transaction so a half-transfer can
 * never exist. Both rows are type TRANSFER, so they are invisible to income,
 * expense, budget and safe-to-spend maths.
 */
export async function saveTransferAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;
  const parsed = transferSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { transferId, date, amount, currency, fromAccountId, toAccountId, note } =
    parsed.data;

  const referenceError = await checkReferences(
    t,
    [fromAccountId, toAccountId],
    null,
    !transferId,
  );
  if (referenceError) return fail(referenceError);

  if (transferId) {
    const legs = await prisma.transaction.findMany({ where: { transferId } });
    if (legs.length !== 2) return fail(t.transferNoLongerExists);

    await prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({
        where: { transferId, transferDirection: "OUT" },
        data: { date, amount, currency, note, accountId: fromAccountId },
      });
      await tx.transaction.updateMany({
        where: { transferId, transferDirection: "IN" },
        data: { date, amount, currency, note, accountId: toAccountId },
      });
    });

    revalidateApp();
    return done(t.transferUpdated);
  }

  const newTransferId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        date,
        amount,
        currency,
        note,
        type: "TRANSFER",
        source: "MANUAL",
        accountId: fromAccountId,
        transferId: newTransferId,
        transferDirection: "OUT",
      },
    });
    await tx.transaction.create({
      data: {
        date,
        amount,
        currency,
        note,
        type: "TRANSFER",
        source: "MANUAL",
        accountId: toAccountId,
        transferId: newTransferId,
        transferDirection: "IN",
      },
    });
  });

  revalidateApp();
  return done(t.transferRecorded);
}
