"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { num } from "@/lib/money";
import {
  firstError,
  formObject,
  recurringAccountSchema,
  recurringSchema,
  subscriptionRoomSchema,
  suggestionRefSchema,
} from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import {
  checkRecurringReferences,
  createRecurringItem,
  markRecurringItemPaidOff,
  setRecurringItemAccount,
  type RecurringReferenceProblem,
} from "@/lib/data/recurring";
import {
  acceptRecurringSuggestion,
  dismissRecurringSuggestion,
} from "@/lib/data/recurring-suggestions";
import { checkSubscriptionRoom, type SubscriptionRoom } from "@/lib/data/subscription-room";
import { isFinishedPlan } from "@/lib/recurring";

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

  const { id, updatedAt, ...values } = parsed.data;

  if (id) {
    const problem = await checkRecurringReferences(values);
    if (problem) return fail(referenceProblemMessage(problem, t));
    // This form posts every field, including ones it only read. If something
    // else changed the item while the form was open - the payday wizard
    // reassigning its account in another tab is the case that bites - saving
    // would write the stale value back over it. The updatedAt the form was
    // rendered with is the guard: no rows match once the item has moved on, and
    // the user is told to reopen rather than silently undoing the other change.
    const claimed = await prisma.recurringItem.updateMany({
      where: updatedAt ? { id, updatedAt } : { id },
      data: values,
    });
    if (claimed.count === 0) {
      const stillThere = await prisma.recurringItem.findUnique({
        where: { id },
        select: { id: true },
      });
      return fail(stillThere ? t.itemChangedElsewhere : t.itemNoLongerExists);
    }
  } else {
    const created = await createRecurringItem(values);
    if (!created.ok) return fail(referenceProblemMessage(created.problem, t));
  }

  revalidateApp();
  return done(id ? t.itemUpdated : t.itemAdded);
}

function referenceProblemMessage(
  problem: RecurringReferenceProblem,
  t: ReturnType<typeof getDictionary>["recurring"],
): string {
  if (problem === "category") return t.categoryNoLongerExists;
  if (problem === "goal") return t.goalNoLongerExists;
  return t.accountNoLongerActive;
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
  // Flipping a finished plan back on would only have posting retire it again
  // on the next run, after a toast that said "Resumed". It needs new Payments
  // left first, which the edit form sets.
  if (isFinishedPlan(item)) return fail(t.finishedCannotResume);

  await prisma.recurringItem.update({
    where: { id },
    data: { active: !item.active },
  });
  revalidateApp();
  return done(item.active ? t.itemPaused : t.itemResumed);
}

/** The rest of an installment plan was paid in one go outside the app. */
export async function markPaidOffAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const id = String(formData.get("id") ?? "").trim();
  const result = await markRecurringItemPaidOff(id);
  if (!result.ok) {
    return fail(result.reason === "not_found" ? t.itemNoLongerExists : t.notAnInstallmentPlan);
  }
  revalidateApp();
  return done(t.itemPaidOff);
}

/**
 * Repoints one recurring item at another account - the account field of
 * saveRecurringAction's form on its own, for the payday check-in's Step 3
 * where reassigning a subscription is the whole edit. Same column, same
 * revalidation, so the Recurring page shows the change immediately.
 */
export async function reassignRecurringAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const parsed = recurringAccountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const account = await prisma.account.findFirst({
    where: { id: parsed.data.accountId, status: "ACTIVE" },
  });
  if (!account) return fail(t.accountNoLongerActive);
  if (!(await setRecurringItemAccount(parsed.data.id, parsed.data.accountId))) {
    return fail(t.itemNoLongerExists);
  }

  revalidateApp();
  return done(t.itemUpdated);
}

/**
 * "Add as recurring" on a pattern suggestion. The form carries only the
 * suggestion's identity; the item's name, amount, cadence and dates come
 * from detection re-run against the ledger now, through the same creation
 * path the Recurring form uses. Nothing is ever created without this click.
 */
export async function acceptRecurringSuggestionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const parsed = suggestionRefSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const result = await acceptRecurringSuggestion(parsed.data, await getAppContext());
  if (!result.ok) {
    return fail(result.reason === "not_found" ? t.suggestionGone : referenceProblemMessage(result.reason, t));
  }

  revalidateApp();
  return done(t.suggestionAdded(result.candidate.name));
}

/** "Dismiss" on a pattern suggestion: it is never suggested again for that account. */
export async function dismissRecurringSuggestionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).recurring;
  const parsed = suggestionRefSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const account = await prisma.account.findUnique({
    where: { id: parsed.data.accountId },
    select: { id: true },
  });
  if (!account) return fail(t.suggestionGone);
  await dismissRecurringSuggestion(parsed.data);

  revalidateApp();
  return done(t.suggestionDismissed);
}

export type SubscriptionRoomResult = { ok: true; room: SubscriptionRoom } | { ok: false };

/**
 * The Recurring form's advisory room check for a large subscription: a pure
 * read over Afford's projection (see src/lib/data/subscription-room.ts). It
 * never blocks the save, so an input the schema refuses - a half-typed
 * amount, an incomplete date - simply yields no panel rather than an error;
 * saveRecurringAction reports those when the user submits. A contribution is
 * never checked here: its funding is planned per account in the payday
 * check-in's Step 3.
 */
export async function checkSubscriptionRoomAction(payload: unknown): Promise<SubscriptionRoomResult> {
  await requireAuth();
  const parsed = subscriptionRoomSchema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "SUBSCRIPTION") return { ok: false };

  const [context, settings] = await Promise.all([getAppContext(), getSettings()]);
  const room = await checkSubscriptionRoom(parsed.data, {
    ...context,
    bufferPercent: settings.bufferPercent,
    bufferFloorAmount: num(settings.bufferFloorAmount),
    bufferFloorCurrency: settings.bufferFloorCurrency,
  });
  return { ok: true, room };
}
