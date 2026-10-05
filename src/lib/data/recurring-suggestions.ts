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
import { enteredMoney, moneyRow } from "@/lib/account-money";
import { convert } from "@/lib/currency";
import { addDays } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { loadPairedCharges } from "@/lib/data/recurring-settlement";
import {
  detectRecurringPatterns,
  repeatedItem,
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
 * post, so accepting would be refused anyway. A charge that already pays an
 * occurrence of an item - paired by a RecurringSettlement row, or by the
 * settlement plan before posting records it (loadPairedCharges) - is that
 * item's, not evidence of a second pattern, whatever account it left. Reads
 * only.
 */
export async function findRecurringSuggestions(context: AppContext): Promise<RecurringSuggestion[]> {
  const [found, items, dismissed, accounts, categories, paired] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        type: "EXPENSE",
        source: { in: ["MANUAL", "CSV"] },
        isExtraordinary: false,
        note: { not: null },
        date: { gte: addDays(context.today, -DETECTION_LOOKBACK_DAYS) },
        account: { status: "ACTIVE" },
        recurringSettlement: { is: null },
      },
      select: {
        id: true,
        date: true,
        amount: true,
        currency: true,
        originalAmount: true,
        originalCurrency: true,
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
      select: { name: true, note: true, amount: true, currency: true, accountId: true, categoryId: true, active: true, frequency: true },
      orderBy: { name: "asc" },
    }),
    prisma.recurringSuggestionDismissal.findMany({ select: { accountId: true, merchantKey: true } }),
    // Every account: an item the hint names may sit on an archived one.
    prisma.account.findMany({ select: { id: true, name: true } }),
    prisma.category.findMany({ select: { id: true, name: true } }),
    loadPairedCharges(context.today),
  ]);
  const transactions = found.filter((row) => !paired.has(row.id));
  const tracked = items.map((item) => ({ ...item, amount: num(item.amount) }));

  const candidates = detectRecurringPatterns({
    // A charge is suggested as what it was entered as (K7): a subscription billed
    // in dollars repeats as the same dollars, while its peso figure moves with
    // the rate of each month's charge.
    transactions: transactions.map(({ originalAmount, originalCurrency, ...row }) => ({
      ...row,
      ...enteredMoney(moneyRow({ amount: row.amount, currency: row.currency, originalAmount, originalCurrency })),
    })),
    trackedItems: tracked,
    dismissed,
    today: context.today,
  });

  const accountNameById = new Map(accounts.map((account) => [account.id, account.name]));
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));
  return candidates.map((candidate) => {
    const repeated = repeatedItem(candidate, tracked);
    return {
      ...candidate,
      accountName: accountNameById.get(candidate.accountId) ?? "",
      categoryName: candidate.categoryId ? (categoryNameById.get(candidate.categoryId) ?? null) : null,
      displayAmount: round2(
        convert(candidate.amount, candidate.currency, context.displayCurrency, context.rates),
      ),
      mayRepeat: repeated
        ? { itemName: repeated.name, accountName: repeated.accountId ? (accountNameById.get(repeated.accountId) ?? null) : null }
        : null,
    };
  });
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
