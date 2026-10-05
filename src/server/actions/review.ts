"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { formatMoney } from "@/lib/currency";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import {
  firstError,
  formObject,
  stagedApproveSchema,
  stagedEditSchema,
} from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import { approveStagedTransaction } from "@/lib/data/staged-approval";

import { done, fail, refusedWriteMessage, revalidateApp, type ActionState } from "./utils";

/** Saves inline edits to a still-pending staged row without approving it. */
export async function updateStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).review;
  const parsed = stagedEditSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));
  const { id, date, amount, currency, rawDescription, accountId, categoryId } =
    parsed.data;

  const staged = await prisma.stagedTransaction.findUnique({ where: { id } });
  if (!staged) return fail(t.itemNoLongerExists);
  if (staged.status !== "PENDING") return fail(t.alreadyReviewed);

  await prisma.stagedTransaction.update({
    where: { id },
    data: {
      date,
      amount,
      currency,
      rawDescription,
      accountId,
      suggestedCategoryId: categoryId,
    },
  });

  revalidateApp();
  return done(t.stagedSaved);
}

/**
 * Approving writes a real Transaction with the staged row's source/externalId
 * and marks the staged row APPROVED - it is never mutated back to pending.
 * Every Phase 2A source (receipts, invoices, subscriptions, order
 * confirmations) represents money going out, so the transaction type is
 * always EXPENSE; nothing in this pipeline stages income. A row matching a
 * charge recurring posting already wrote carries the user's answer in
 * `resolution` ("posted" or "different") - see approveStagedTransaction in
 * src/lib/data/staged-approval.ts, which owns the write.
 */
export async function approveStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const dictionary = getDictionary(locale);
  const t = dictionary.review;
  const parsed = stagedApproveSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));
  const { id, date, amount, currency, rawDescription, accountId, categoryId } =
    parsed.data;
  const rawResolution = String(formData.get("resolution") ?? "");
  const resolution =
    rawResolution === "posted" || rawResolution === "different" || rawResolution === "upcoming" ? rawResolution : null;

  let result;
  try {
    result = await approveStagedTransaction(
      { id, date, amount, currency, rawDescription, accountId, categoryId, resolution },
      (await getAppContext()).rates,
    );
  } catch (error) {
    // In another currency with no current rate to convert it (R20), or 0.00
    // in the account's currency (S19): not approved.
    const message = refusedWriteMessage(error, locale);
    if (message) return fail(message);
    throw error;
  }
  if (!result.ok) {
    if (result.reason === "not_found") return fail(t.itemNoLongerExists);
    if (result.reason === "already_reviewed") return fail(t.alreadyReviewed);
    if (result.reason === "account_missing") return fail(t.accountNoLongerExists);
    if (result.reason === "account_not_active") return fail(t.accountNoLongerActive);
    if (result.reason === "needs_choice") return fail(t.postedMatchNeedsChoice);
    if (result.reason === "match_gone") return fail(dictionary.transactions.postedMatchGone);
    if (result.reason === "check_failed") return fail(dictionary.transactions.postedMatchCheckFailed);
    return fail(t.transactionAlreadyExists);
  }

  revalidateApp();
  if (result.outcome === "kept_upcoming") return done(dictionary.transactions.upcomingKept(result.itemName));
  if (result.outcome === "kept_posted") {
    const { match } = result;
    return done(
      result.updated && match.rewrite
        ? t.keptAsPostedUpdated(
            formatMoney(match.posted.amount, match.posted.currency),
            formatMoney(match.rewrite.amount, match.rewrite.currency),
          )
        : t.keptAsPosted,
    );
  }
  return done(t.approvedToast);
}

export async function rejectStagedAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).review;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.nothingToReject);

  const staged = await prisma.stagedTransaction.findUnique({ where: { id } });
  if (!staged) return fail(t.itemNoLongerExists);
  if (staged.status !== "PENDING") return fail(t.alreadyReviewed);

  await prisma.stagedTransaction.update({
    where: { id },
    data: { status: "REJECTED", reviewedAt: new Date() },
  });

  revalidateApp();
  return done(t.rejectedToast);
}
