"use server";

import { randomUUID } from "node:crypto";

import { getSettings, requireAuth } from "@/lib/auth";
import { isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import {
  firstError,
  formObject,
  transactionSchema,
  transferSchema,
} from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveTransactionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const parsed = transactionSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;

  if (id) {
    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing) return fail("That transaction no longer exists");
    if (existing.transferId) {
      return fail("Edit this transfer from the transfer form");
    }
    await prisma.transaction.update({ where: { id }, data: values });
  } else {
    await prisma.transaction.create({ data: { ...values, source: "MANUAL" } });
  }

  revalidateApp();
  return done(id ? "Transaction updated" : "Transaction added");
}

export async function deleteTransactionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Nothing to delete");

  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing) return fail("That transaction no longer exists");

  // Deleting one leg of a transfer removes both, so balances stay consistent.
  if (existing.transferId) {
    await prisma.transaction.deleteMany({
      where: { transferId: existing.transferId },
    });
  } else {
    await prisma.transaction.delete({ where: { id } });
  }

  revalidateApp();
  return done("Transaction deleted");
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
  const parsed = transferSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { transferId, date, amount, currency, fromAccountId, toAccountId, note } =
    parsed.data;

  if (transferId) {
    const legs = await prisma.transaction.findMany({ where: { transferId } });
    if (legs.length !== 2) return fail("That transfer no longer exists");

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
    return done("Transfer updated");
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
  return done("Transfer recorded");
}
