/**
 * Recurring-pattern suggestions: the database side of
 * src/lib/recurring-detection.ts. Finding suggestions reads the organic
 * ledger and writes nothing; accepting one creates its RecurringItem
 * through the same creation path the Recurring form uses; dismissing one
 * writes the RecurringSuggestionDismissal row that keeps it from ever coming
 * back. Every entry point takes the suggestion's identity (account + merchant
 * key) and re-runs detection against the current ledger, so nothing the
 * client sends - an amount, a date, a name - is ever written as given.
 */
import { convert } from "@/lib/currency";
import { addDays } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  detectRecurringPatterns,
  type RecurringCandidate,
  type RecurringSuggestion,
} from "@/lib/recurring-detection";

import type { AppContext } from "@/lib/data/context";
import {
  createRecurringItem,
  type NewRecurringItem,
  type RecurringReferenceProblem,
} from "@/lib/data/recurring";

/**
 * How far back the ledger is read: about three years, enough for three
 * yearly charges (two gaps) plus slack. Bounds the query, and older history
 * could only describe patterns the staleness rule would drop anyway.
 */
export const DETECTION_LOOKBACK_DAYS = 1100;

/** A suggestion's identity - what a dismissal is keyed by. */
export interface SuggestionRef {
  accountId: string;
  merchantKey: string;
}

/**
 * Every pattern in the organic ledger worth suggesting, most charges first.
 * Only active accounts are read: an item on an archived account could never
 * post, so accepting would be refused anyway. Reads only.
 */
export async function findRecurringSuggestions(context: AppContext): Promise<RecurringSuggestion[]> {
  const [transactions, items, dismissed, accounts, categories] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        type: "EXPENSE",
        source: { in: ["MANUAL", "CSV"] },
        isExtraordinary: false,
        note: { not: null },
        date: { gte: addDays(context.today, -DETECTION_LOOKBACK_DAYS) },
        account: { status: "ACTIVE" },
      },
      select: {
        id: true,
        date: true,
        amount: true,
        currency: true,
        type: true,
        source: true,
        accountId: true,
        categoryId: true,
        note: true,
        externalId: true,
        isExtraordinary: true,
      },
    }),
    prisma.recurringItem.findMany({
      select: { name: true, amount: true, currency: true, accountId: true, categoryId: true, active: true },
    }),
    prisma.recurringSuggestionDismissal.findMany({ select: { accountId: true, merchantKey: true } }),
    prisma.account.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true } }),
    prisma.category.findMany({ select: { id: true, name: true } }),
  ]);

  const candidates = detectRecurringPatterns({
    transactions: transactions.map((row) => ({ ...row, amount: num(row.amount) })),
    trackedItems: items.map((item) => ({ ...item, amount: num(item.amount) })),
    dismissed,
    today: context.today,
  });

  const accountNameById = new Map(accounts.map((account) => [account.id, account.name]));
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
  return candidates.map((candidate) => ({
    ...candidate,
    accountName: accountNameById.get(candidate.accountId) ?? "",
    categoryName: candidate.categoryId ? (categoryNameById.get(candidate.categoryId) ?? null) : null,
    displayAmount: round2(
      convert(candidate.amount, candidate.currency, context.displayCurrency, context.rates),
    ),
  }));
}

/**
 * The single RecurringItem an accepted candidate becomes: one SUBSCRIPTION,
 * whatever the cadence. A SEMI_MONTHLY candidate maps directly onto
 * RecurringItem's own SEMI_MONTHLY frequency (anchorDay and
 * secondAnchorDay from the candidate's two anchor days - which of the two
 * lands in which field doesn't matter, advanceDate() treats them
 * symmetrically). nextDate is the *earlier* of the candidate's two computed
 * next-dates: detection reports one next-date per anchor in a fixed
 * (smaller-day-first) order, which is not always the chronologically sooner
 * one - if today falls between the two anchors, the smaller day's own next
 * occurrence can be a full cycle later than the larger day's. Taking the
 * minimum keeps the new item's first occurrence from silently skipping
 * whichever anchor is actually due first.
 */
export function recurringItemForCandidate(
  candidate: RecurringCandidate,
): NewRecurringItem {
  const nextDate =
    candidate.nextDates.length > 1 &&
    candidate.nextDates[1].getTime() < candidate.nextDates[0].getTime()
      ? candidate.nextDates[1]
      : candidate.nextDates[0];
  return {
    name: candidate.name,
    amount: candidate.amount,
    currency: candidate.currency,
    kind: "SUBSCRIPTION",
    frequency: candidate.cadence,
    nextDate,
    anchorDay: candidate.anchorDays[0] ?? nextDate.getUTCDate(),
    secondAnchorDay: candidate.cadence === "SEMI_MONTHLY" ? candidate.anchorDays[1] : null,
    active: true,
    categoryId: candidate.categoryId,
    accountId: candidate.accountId,
    goalId: null,
    note: candidate.sampleNote,
    remainingOccurrences: null,
    detectedFrom: candidate.detectedFrom,
  };
}

export type AcceptSuggestionResult =
  | { ok: true; candidate: RecurringCandidate; itemId: string }
  | { ok: false; reason: "not_found" | RecurringReferenceProblem };

/**
 * Creates the real RecurringItem for the suggestion `ref` names, from the
 * values detection infers right now - never from anything the client sent.
 * "not_found" when the pattern is no longer suggested: already accepted or
 * dismissed, its account archived, or the ledger changed under it.
 */
export async function acceptRecurringSuggestion(
  ref: SuggestionRef,
  context: AppContext,
): Promise<AcceptSuggestionResult> {
  const suggestions = await findRecurringSuggestions(context);
  const candidate = suggestions.find(
    (row) => row.accountId === ref.accountId && row.merchantKey === ref.merchantKey,
  );
  if (!candidate) return { ok: false, reason: "not_found" };

  const created = await createRecurringItem(recurringItemForCandidate(candidate));
  if (!created.ok) return { ok: false, reason: created.problem };
  return { ok: true, candidate, itemId: created.id };
}

/**
 * Never suggest this merchant on this account again. Idempotent: dismissing
 * something already dismissed keeps the one row and its original time.
 */
export async function dismissRecurringSuggestion(ref: SuggestionRef): Promise<void> {
  await prisma.recurringSuggestionDismissal.upsert({
    where: { accountId_merchantKey: { accountId: ref.accountId, merchantKey: ref.merchantKey } },
    create: { accountId: ref.accountId, merchantKey: ref.merchantKey },
    update: {},
  });
}
