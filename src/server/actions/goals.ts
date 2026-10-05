"use server";

import { redirect } from "next/navigation";

import { inAccountCurrency, RatesUnavailableError } from "@/lib/account-money";
import { getSettings, requireAuth } from "@/lib/auth";
import { formatDate } from "@/lib/date-format";
import {
  deleteGoalDetachingLedger,
  logManualContribution,
  rebuildGoalSaved,
  recomputeGoalSaved,
  removeContribution,
  updateManualContribution,
  updateGoal,
  updateRecurringContributionAmount,
} from "@/lib/goals";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { checkReferences } from "@/lib/references";
import { manualContributionExternalId } from "@/lib/transactions";
import {
  contributionSchema,
  firstError,
  formObject,
  goalSchema,
  manualContributionEditSchema,
  recurringContributionEditSchema,
} from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import { contributionSettles, contributionWouldSettle } from "@/lib/data/recurring-settlement";

import { done, fail, refusedWriteMessage, revalidateApp, type ActionState } from "./utils";

export async function saveGoalAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = goalSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  if (id) {
    // The currency is refused once the goal holds a contribution (updateGoal).
    const updated = await updateGoal(id, values);
    if (!updated.ok) return fail(updated.reason === "currency_locked" ? t.currencyLocked : t.goalNoLongerExists);
    // The target may have changed, which changes whether the goal is reached.
    await recomputeGoalSaved(id);
  } else {
    await prisma.goal.create({ data: values });
  }

  revalidateApp();
  return done(id ? t.goalUpdated : t.goalCreated);
}

export async function deleteGoalAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(common.nothingToDelete);
  // The contributions cascade; the expenses they wrote stay in the ledger as
  // ordinary rows - see deleteGoalDetachingLedger.
  if (!(await deleteGoalDetachingLedger(id))) return fail(t.goalNoLongerExists);
  revalidateApp();
  // From the goal's own page the form asks to be sent to the list: that page
  // has nothing left to render. Only the one fixed path is honoured.
  if (String(formData.get("redirectTo") ?? "") === "/goals") redirect("/goals");
  return done(t.goalDeleted);
}

/**
 * Corrects the amount of one contribution recurring posting wrote, and the
 * ledger row beside it, without touching the recurring item's own amount.
 */
export async function updateRecurringContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = recurringContributionEditSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  let result;
  try {
    result = await updateRecurringContributionAmount(parsed.data.id, parsed.data.amount);
  } catch (error) {
    const message = refusedWriteMessage(error, locale);
    if (message) return fail(message);
    throw error;
  }
  if (!result.ok) {
    return fail(
      result.reason === "not_found" ? t.contributionNoLongerExists : t.contributionNotRecurring,
    );
  }
  await recomputeGoalSaved(result.goalId);

  revalidateApp();
  return done(t.contributionUpdated);
}

/**
 * Contributions are the source of truth; the cached Goal.savedAmount is rebuilt
 * from them after every write. A contribution also moves the money out of the
 * chosen account - see logManualContribution for the paired Transaction.
 */
export async function addContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = contributionSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const goal = await prisma.goal.findUnique({
    where: { id: parsed.data.goalId },
    select: { id: true, currency: true },
  });
  if (!goal) return fail(t.goalNoLongerExists);
  // Same check the transaction form runs: the account must still exist and,
  // since this writes a new row against it, still be active.
  const referenceError = await checkReferences(
    getDictionary(locale).transactions,
    [parsed.data.accountId],
    null,
    true,
  );
  if (referenceError) return fail(referenceError);

  let logged;
  try {
    logged = await logManualContribution({
      goalId: goal.id,
      accountId: parsed.data.accountId,
      amount: parsed.data.amount,
      date: parsed.data.date,
      note: parsed.data.note,
    });
  } catch (error) {
    // No current rate to convert it, 0.00 in the account's currency, or the
    // same contribution submitted again: nothing was written.
    const message = refusedWriteMessage(error, locale);
    if (message) return fail(message);
    throw error;
  }
  const { justAchieved } = await rebuildGoalSaved(goal.id);
  // A contribution of the automatic one's amount, to the same goal, near its
  // due date counts as it (B16): the toast says so, as the dialog did.
  const settles = await contributionSettles(logged.transactionId, parsed.data.date);

  revalidateApp();
  return done(
    settles ? t.contributionLoggedCountsAsAutomatic(formatDate(settles.dueDate, locale)) : t.contributionLogged,
    justAchieved ? { achievedGoalId: goal.id } : undefined,
  );
}

export type ContributionSettlesResult = { ok: true; dueDate: string | null } | { ok: false };

/**
 * The contribution dialogs' notice, before saving: the due date (ISO) of
 * the automatic contribution this one would count as - the pairing posting
 * makes (contributionWouldSettle) - or null when it pays none. Logging names
 * the goal; editing names the hand-logged contribution (`contributionId`),
 * whose goal it is and whose own expense the edited one is judged in place
 * of. Read only.
 */
export async function previewContributionSettlesAction(payload: unknown): Promise<ContributionSettlesResult> {
  await requireAuth();
  const input = (payload ?? {}) as Record<string, unknown>;
  const contributionId = typeof input.contributionId === "string" ? input.contributionId : null;
  const editing = contributionId
    ? await prisma.goalContribution.findUnique({ where: { id: contributionId }, select: { goalId: true, recurringExternalId: true } })
    : null;
  if (contributionId && (!editing || editing.recurringExternalId)) return { ok: false };
  const parsed = contributionSchema.safeParse({ ...input, goalId: editing?.goalId ?? input.goalId, note: "" });
  if (!parsed.success) return { ok: false };
  const replacing = contributionId
    ? (await prisma.transaction.findFirst({ where: { source: "MANUAL", externalId: manualContributionExternalId(contributionId) }, select: { id: true } }))?.id
    : undefined;
  const [goal, account, savingsCategory] = await Promise.all([
    prisma.goal.findUnique({ where: { id: parsed.data.goalId }, select: { id: true, name: true, currency: true } }),
    prisma.account.findUnique({ where: { id: parsed.data.accountId }, select: { id: true, currency: true } }),
    prisma.category.findFirst({ where: { isSavingsDefault: true }, select: { id: true } }),
  ]);
  if (!goal || !account) return { ok: false };
  const context = await getAppContext();
  // The expense logManualContribution would write for it - none without a
  // current rate to convert it, which the save itself refuses (R20).
  let twin;
  try {
    twin = inAccountCurrency({ amount: parsed.data.amount, currency: goal.currency }, account.currency, context.rates);
  } catch (error) {
    if (error instanceof RatesUnavailableError) return { ok: false };
    throw error;
  }
  const settles = await contributionWouldSettle({
    date: parsed.data.date,
    amount: twin.amount,
    currency: twin.currency,
    originalAmount: twin.originalAmount ?? null,
    originalCurrency: twin.originalCurrency ?? null,
    categoryId: savingsCategory?.id ?? null,
    note: goal.name,
    contributionGoalId: goal.id,
    accountId: account.id,
  }, { replacing });
  return { ok: true, dueDate: settles ? settles.dueDate.toISOString().slice(0, 10) : null };
}

/**
 * Corrects a hand-logged contribution in place: amount, date, and which
 * account the money left. The manual counterpart to
 * updateRecurringContributionAction above - see updateManualContribution for
 * how the paired Transaction is moved and re-converted.
 */
export async function updateContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const parsed = manualContributionEditSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  // Editing accepts an archived account, same as the transaction form - see
  // checkReferences.
  const referenceError = await checkReferences(
    getDictionary(locale).transactions,
    [parsed.data.accountId],
    null,
    false,
  );
  if (referenceError) return fail(referenceError);

  let result;
  try {
    result = await updateManualContribution(parsed.data.id, {
      amount: parsed.data.amount,
      date: parsed.data.date,
      accountId: parsed.data.accountId,
    });
  } catch (error) {
    const message = refusedWriteMessage(error, locale);
    if (message) return fail(message);
    throw error;
  }
  if (!result.ok) {
    return fail(
      result.reason === "not_found" ? t.contributionNoLongerExists : t.contributionNotManual,
    );
  }
  await recomputeGoalSaved(result.goalId);

  revalidateApp();
  return done(t.contributionUpdated);
}

export async function deleteContributionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).goals;
  const id = String(formData.get("id") ?? "").trim();
  const contribution = await prisma.goalContribution.findUnique({
    where: { id },
    select: { id: true, goalId: true, accountId: true, recurringExternalId: true },
  });
  if (!contribution) return fail(t.contributionNoLongerExists);

  await removeContribution(contribution);
  await recomputeGoalSaved(contribution.goalId);

  revalidateApp();
  return done(t.contributionRemoved);
}
