"use server";

import { randomUUID } from "node:crypto";

import { getSettings, requireAuth } from "@/lib/auth";
import { backfillUncategorizedTransactions } from "@/lib/categorization";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { recomputeGoalSaved, removeContribution } from "@/lib/goals";
import { num } from "@/lib/money";
import { checkReferences } from "@/lib/references";
import { ownShare, yourShareIssue } from "@/lib/shared-expense";
import {
  canBeExtraordinary,
  canBeSharedExpense,
  manualContributionIdFromTransaction,
  recurringContributionKeyFromTransaction,
  transactionEditBlock,
  transferLegs,
} from "@/lib/transactions";
import {
  firstError,
  formObject,
  localizeValidationMessage,
  transactionSchema,
  transferSchema,
} from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import { findExtraordinaryCandidates } from "@/lib/data/extraordinary";

import { done, fail, revalidateApp, type ActionState, type ExtraordinarySuggestion } from "./utils";

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

  // A deposit may only pay back a real shared expense (src/lib/shared-expense.ts):
  // the picker offers exactly those, but the form is not trusted to have
  // picked one. Whether it is already settled is not checked - a late or
  // over-generous payback is still money coming back, and the row's own
  // display simply stops counting a pending figure.
  if (values.reimbursesTransactionId !== null) {
    const reimbursed = await prisma.transaction.findUnique({
      where: { id: values.reimbursesTransactionId },
      select: { type: true, yourShare: true },
    });
    if (!reimbursed || reimbursed.type !== "EXPENSE" || reimbursed.yourShare === null) {
      return fail(t.reimbursedExpenseNotShared);
    }
  }

  if (id) {
    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing) return fail(t.transactionNoLongerExists);
    const block = transactionEditBlock(existing);
    if (block === "transfer") return fail(t.editFromTransferForm);
    if (block === "opening_balance") return fail(t.editOpeningBalanceFromAccounts);
    if (block === "goal_contribution") return fail(t.editContributionFromGoal);
    if (block === "payday_income") return fail(t.editPaycheckFromCheckin);
    // A RECURRING row that carries a goal contribution is that contribution's
    // ledger half: its amount is corrected from the goal's page so both stay
    // in step, the same rule the manual pair follows. Only a lookup can tell
    // it from a subscription's row, so this check lives here, not in the
    // pure transactionEditBlock.
    const recurringKey = recurringContributionKeyFromTransaction(existing);
    if (recurringKey !== null) {
      const paired = await prisma.goalContribution.findFirst({
        where: { recurringExternalId: recurringKey },
        select: { id: true },
      });
      if (paired) return fail(t.editContributionFromGoal);
    }
    // A share belongs on an organic expense only (canBeSharedExpense, the
    // same rows the one-off flag admits); a subscription's posted row is
    // scheduled, not split with anyone.
    if (values.yourShare != null && !canBeSharedExpense({ ...existing, type: values.type })) {
      return fail(t.sharedNotApplicable);
    }
    // A share the form did not offer to change (yourShare undefined - see
    // transactionSchema) stays as it is, but the amount it sits inside may
    // be the very thing being edited: the same bound the form applies to a
    // share it does set.
    if (values.yourShare === undefined && existing.yourShare !== null) {
      const kept = num(existing.yourShare);
      const shareIssue = yourShareIssue(values.amount, kept);
      if (shareIssue) return fail(localizeValidationMessage(shareIssue, locale));
    }
    // Taking the share off an expense (or turning it into something other
    // than an expense) while deposits still point at it would leave those
    // deposits paying back nothing in particular - and still excluded from
    // income averages by their link. The deposits are unlinked or removed
    // first, from their own rows.
    if (existing.yourShare !== null && values.yourShare === null) {
      const linked = await prisma.transaction.count({ where: { reimbursesTransactionId: id } });
      if (linked > 0) return fail(t.sharedHasReimbursements);
    }
    await prisma.transaction.update({ where: { id }, data: values });
  } else {
    // Measured before the row lands so it is not its own history. The row is
    // saved unflagged whatever the verdict; a hit only asks the form to put
    // the question to the user (see src/lib/extraordinary.ts). A shared
    // expense is measured at the user's own share: that is the figure the
    // averages the flag protects would read for it.
    const measured = ownShare({ amount: values.amount, yourShare: values.yourShare ?? null });
    const suggestion =
      values.type === "EXPENSE" && values.categoryId
        ? await findExtraordinaryCandidates(
            [{ key: "new", categoryId: values.categoryId, amount: measured, currency: values.currency }],
            await getAppContext(),
          )
        : null;
    const created = await prisma.transaction.create({ data: { ...values, source: "MANUAL" } });
    const hit = suggestion?.get("new");
    if (hit) {
      const extraordinarySuggestion: ExtraordinarySuggestion = {
        transactionId: created.id,
        amount: measured,
        currency: values.currency,
        categoryName: hit.categoryName,
        median: hit.median,
        medianCurrency: hit.currency,
      };
      revalidateApp();
      return done(t.transactionAdded, { extraordinarySuggestion });
    }
  }

  revalidateApp();
  return done(id ? t.transactionUpdated : t.transactionAdded);
}

/**
 * The user's own verdict on one expense: mark it as a one-off, or take the
 * mark back. Available from the Transactions page on any organic expense,
 * whether or not the threshold ever suggested it - the only way the flag is
 * ever written. A RECURRING row is refused: its amount is scheduled, not
 * organic, so there is nothing to classify (see canBeExtraordinary).
 */
export async function setExtraordinaryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;
  const id = String(formData.get("id") ?? "").trim();
  const isExtraordinary = String(formData.get("isExtraordinary") ?? "") === "true";
  if (!id) return fail(t.transactionNoLongerExists);

  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing) return fail(t.transactionNoLongerExists);
  if (!canBeExtraordinary(existing)) return fail(t.extraordinaryNotApplicable);

  await prisma.transaction.update({ where: { id }, data: { isExtraordinary } });

  revalidateApp();
  return done(isExtraordinary ? t.markedExtraordinary : t.unmarkedExtraordinary);
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

  // The paycheck a payday check-in recorded is owned by that check-in's
  // snapshot (see transactionEditBlock): removing it here would leave the
  // period's income and the next check-in's expected balance counting a row
  // that no longer exists, and a re-confirm would recreate it anyway.
  if (transactionEditBlock(existing) === "payday_income") {
    return fail(t.deletePaycheckFromCheckin);
  }

  // A shared expense with deposits still linked to it stays until they are
  // unlinked or removed from their own rows: the deposits are real money in
  // and must not go with it, and left behind pointing at nothing they would
  // still be excluded from income averages by a link to an expense that no
  // longer exists.
  if (existing.yourShare !== null) {
    const linked = await prisma.transaction.count({ where: { reimbursesTransactionId: id } });
    if (linked > 0) return fail(t.sharedHasReimbursements);
  }

  // Deleting one leg of a transfer removes both, so balances stay consistent.
  // Likewise the expense a goal contribution wrote takes the GoalContribution
  // with it - the same outcome as removing it from the goal's own history -
  // and the goal's cached progress is rebuilt afterwards, as that path does.
  const contributionId = manualContributionIdFromTransaction(existing);
  const recurringKey = recurringContributionKeyFromTransaction(existing);
  if (existing.transferId) {
    await prisma.transaction.deleteMany({
      where: { transferId: existing.transferId },
    });
  } else if (contributionId !== null) {
    const contribution = await prisma.goalContribution.findUnique({
      where: { id: contributionId },
      select: { id: true, goalId: true, accountId: true, recurringExternalId: true },
    });
    if (contribution) {
      await removeContribution(contribution);
      await recomputeGoalSaved(contribution.goalId);
    } else {
      // The contribution is already gone (its goal was deleted, say); only the
      // orphaned ledger row is left to remove.
      await prisma.transaction.delete({ where: { id } });
    }
  } else if (recurringKey !== null) {
    // The same pairing for a row recurring posting wrote: if a contribution
    // was logged beside it, the two go together, exactly as deleting from the
    // goal's page does. A subscription's row has no contribution and is
    // deleted on its own.
    const contribution = await prisma.goalContribution.findFirst({
      where: { recurringExternalId: recurringKey },
      select: { id: true, goalId: true, accountId: true, recurringExternalId: true },
    });
    if (contribution) {
      await removeContribution(contribution);
      await recomputeGoalSaved(contribution.goalId);
    } else {
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

  const { transferId, date, amount, currency, fromAccountId, toAccountId, note, receivedAmount } =
    parsed.data;

  const referenceError = await checkReferences(
    t,
    [fromAccountId, toAccountId],
    null,
    !transferId,
  );
  if (referenceError) return fail(referenceError);

  // The receiving leg may carry what the bank actually credited when the two
  // accounts are in different currencies - see transferLegs.
  const accounts = await prisma.account.findMany({
    where: { id: { in: [fromAccountId, toAccountId] } },
    select: { id: true, currency: true },
  });
  const fromAccount = accounts.find((account) => account.id === fromAccountId);
  const toAccount = accounts.find((account) => account.id === toAccountId);
  if (!fromAccount || !toAccount) return fail(t.accountNoLongerExists);
  const legs = transferLegs({
    amount,
    currency,
    receivedAmount,
    fromCurrency: fromAccount.currency,
    toCurrency: toAccount.currency,
  });

  if (transferId) {
    const existingLegs = await prisma.transaction.findMany({ where: { transferId } });
    if (existingLegs.length !== 2) return fail(t.transferNoLongerExists);

    await prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({
        where: { transferId, transferDirection: "OUT" },
        data: { date, amount: legs.out.amount, currency: legs.out.currency, note, accountId: fromAccountId },
      });
      await tx.transaction.updateMany({
        where: { transferId, transferDirection: "IN" },
        data: { date, amount: legs.in.amount, currency: legs.in.currency, note, accountId: toAccountId },
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
        amount: legs.out.amount,
        currency: legs.out.currency,
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
        amount: legs.in.amount,
        currency: legs.in.currency,
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
