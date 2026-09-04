"use server";

import { randomUUID } from "node:crypto";

import { getSettings, requireAuth } from "@/lib/auth";
import { backfillUncategorizedTransactions } from "@/lib/categorization";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { recomputeGoalSaved, removeContribution } from "@/lib/goals";
import { checkReferences } from "@/lib/references";
import {
  manualContributionIdFromTransaction,
  transactionEditBlock,
} from "@/lib/transactions";
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
    if (block === "goal_contribution") return fail(t.editContributionFromGoal);
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
  // Likewise the expense a goal contribution wrote takes the GoalContribution
  // with it - the same outcome as removing it from the goal's own history -
  // and the goal's cached progress is rebuilt afterwards, as that path does.
  const contributionId = manualContributionIdFromTransaction(existing);
  if (existing.transferId) {
    await prisma.transaction.deleteMany({
      where: { transferId: existing.transferId },
    });
  } else if (contributionId !== null) {
    const contribution = await prisma.goalContribution.findUnique({
      where: { id: contributionId },
      select: { id: true, goalId: true, accountId: true },
    });
    if (contribution) {
      await removeContribution(contribution);
      await recomputeGoalSaved(contribution.goalId);
    } else {
      // The contribution is already gone (its goal was deleted, say); only the
      // orphaned ledger row is left to remove.
      await prisma.transaction.delete({ where: { id } });
    }
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
