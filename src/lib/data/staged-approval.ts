/**
 * Approving a staged email row (the review queue), as a plain function - no
 * requireAuth()/cookies() - so scripts/verify-domain.ts drives the same code
 * approveStagedAction does; the action parses, checks the session and turns
 * each outcome into a toast.
 *
 * A receipt often arrives after recurring posting already charged the same
 * money (findPostedDuplicates). Such a row is never approved on its own: the
 * user says whether it is the posted charge or a different one, and the
 * review page shows the match before they are asked (stagedPostedMatches).
 * One that may be an upcoming payment in another currency, which posting has
 * not written yet, is asked the same way: "It's that payment" approves it
 * and records it as having paid that occurrence (recordUpcomingPayment).
 */
import { Prisma } from "@/generated/prisma/client";
import { inAccountCurrency, refuseZeroAmount } from "@/lib/account-money";
import { ratesFitForWriting } from "@/lib/currency";
import { prisma } from "@/lib/prisma";

import {
  applyPostedMatch,
  lookUpPostedDuplicates,
  recordUpcomingPayment,
  type PostedLookup,
  type PostedMatch,
} from "@/lib/data/posted-duplicates";

import type { RateTable } from "@/lib/currency";
import type { StagedRow } from "@/lib/data/staged";

export interface StagedApprovalInput {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  rawDescription: string;
  accountId: string;
  categoryId: string | null;
  /**
   * The user's answer to a posted match: "posted" - it is the posted charge,
   * write nothing new - or "different" - approve it as its own expense. For
   * a match with an upcoming payment in another currency, "upcoming" - it is
   * that payment: approve it and record it as having paid that occurrence.
   * Null when no match was shown.
   */
  resolution: "posted" | "different" | "upcoming" | null;
  /**
   * The posted row (or upcoming occurrence) the reviewer was shown and
   * answered "posted" or "upcoming" about. The match is recomputed here with
   * the reviewer's own picks - a changed category can make another
   * look-alike item the match - so an answer about one row is never applied
   * to another: a different match is refused as match_gone. Absent for
   * callers that showed nothing.
   */
  shownPostedId?: string | null;
}

export type StagedApprovalResult =
  | { ok: true; outcome: "approved" }
  | { ok: true; outcome: "kept_upcoming"; match: PostedMatch; itemName: string }
  | { ok: true; outcome: "kept_posted"; match: PostedMatch; updated: boolean }
  | { ok: false; reason: "not_found" | "already_reviewed" | "account_missing" | "account_not_active" | "exists" | "match_gone" | "check_failed" }
  | { ok: false; reason: "needs_choice"; match: PostedMatch };

/** The staged values as the row it would become - in its account's currency (K7) - for the matcher. */
function incomingFor(
  input: Omit<StagedApprovalInput, "id" | "resolution">,
  key: string,
  accountCurrency: string,
  rates: RateTable,
) {
  return {
    key,
    accountId: input.accountId,
    type: "EXPENSE" as const,
    date: input.date,
    // A receipt that comes to 0.00 in the account's currency is refused
    // (RoundsToZeroError, R29/S19), as a manual entry is.
    ...refuseZeroAmount(
      { amount: input.amount, currency: input.currency },
      inAccountCurrency({ amount: input.amount, currency: input.currency }, accountCurrency, rates),
    ),
    note: input.rawDescription,
    categoryId: input.categoryId,
  };
}

/**
 * Approves one staged row. With no answer, a row matching a posted charge in
 * the same currency is refused (needs_choice) - a possible one
 * (planPostedDuplicates) is only a warning and approves as before. "posted" writes no transaction: the
 * posted row takes the receipt's amount and currency where they differ, and
 * the staged row is marked APPROVED - it was accepted as the record of that
 * charge. "different" approves exactly as a row with no match does.
 *
 * The check fails open (lookUpPostedDuplicates): if it throws or times out, a
 * plain approval goes ahead as it did before the check existed, and only a
 * "posted" answer - which needs the match to act on - is refused, writing
 * nothing.
 */
export async function approveStagedTransaction(
  input: StagedApprovalInput,
  rates: RateTable,
  options: { lookup?: PostedLookup; timeoutMs?: number } = {},
): Promise<StagedApprovalResult> {
  const staged = await prisma.stagedTransaction.findUnique({ where: { id: input.id } });
  if (!staged) return { ok: false, reason: "not_found" };
  if (staged.status !== "PENDING") return { ok: false, reason: "already_reviewed" };

  const account = await prisma.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, status: true, currency: true },
  });
  if (!account) return { ok: false, reason: "account_missing" };
  if (account.status !== "ACTIVE") return { ok: false, reason: "account_not_active" };

  // The receipt's amount as the account will store it: converted once, now,
  // when the receipt is in another currency, with the receipt's own figure kept.
  const incoming = incomingFor(input, staged.id, account.currency, rates);
  // A receipt may also be an upcoming payment in another currency that
  // posting has not written yet (findPostedDuplicates' `upcoming`).
  const found = await lookUpPostedDuplicates([incoming], rates, { ...options, upcoming: true });
  if (!found && (input.resolution === "posted" || input.resolution === "upcoming")) return { ok: false, reason: "check_failed" };
  const match = found?.get(staged.id) ?? null;
  const answersShownMatch = !input.shownPostedId || match?.posted.id === input.shownPostedId;
  if ((input.resolution === "posted" || input.resolution === "upcoming") && !answersShownMatch) return { ok: false, reason: "match_gone" };
  const reviewed = {
    date: input.date,
    amount: input.amount,
    currency: input.currency,
    rawDescription: input.rawDescription,
    accountId: input.accountId,
    suggestedCategoryId: input.categoryId,
    status: "APPROVED" as const,
    reviewedAt: new Date(),
  };

  if (input.resolution === "posted") {
    if (!match || match.kind === "upcoming") return { ok: false, reason: "match_gone" };
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await applyPostedMatch(tx, match);
      await tx.stagedTransaction.update({ where: { id: staged.id }, data: reviewed });
      return changed;
    });
    return { ok: true, outcome: "kept_posted", match, updated };
  }
  if (match && !match.possible && input.resolution !== "different") {
    return { ok: false, reason: "needs_choice", match };
  }
  const upcoming = input.resolution === "upcoming" ? match : null;
  if (input.resolution === "upcoming" && (!upcoming || upcoming.kind !== "upcoming")) return { ok: false, reason: "match_gone" };

  let itemName: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          date: input.date,
          amount: incoming.amount,
          currency: incoming.currency,
          originalAmount: incoming.originalAmount,
          originalCurrency: incoming.originalCurrency,
          rate: incoming.rate,
          type: "EXPENSE",
          accountId: input.accountId,
          categoryId: input.categoryId,
          note: input.rawDescription,
          source: staged.source,
          externalId: staged.externalId,
        },
      });
      // "It's that payment": recorded with the row, in the same database
      // transaction, or neither is written.
      if (upcoming) {
        const recorded = await recordUpcomingPayment(tx, created.id, upcoming.posted.id);
        if (recorded === "match_gone") throw new UpcomingPaymentGone();
        itemName = recorded.itemName;
      }
      await tx.stagedTransaction.update({ where: { id: staged.id }, data: reviewed });
    });
  } catch (error) {
    if (error instanceof UpcomingPaymentGone) return { ok: false, reason: "match_gone" };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, reason: "exists" };
    }
    throw error;
  }
  if (upcoming && itemName !== null) return { ok: true, outcome: "kept_upcoming", match: upcoming, itemName };
  return { ok: true, outcome: "approved" };
}

/** Thrown inside the approval's transaction to roll it back when the upcoming payment it answers is gone. */
class UpcomingPaymentGone extends Error {}

/**
 * For the review page: each pending row's posted match on every account it
 * could be approved into, since the reviewer picks the account on the page.
 * Each row is judged on its own, as its approval will be, against its own
 * values and suggested category. A row whose check fails shows no notice.
 */
export async function stagedPostedMatches(
  rows: readonly StagedRow[],
  accountIds: readonly string[],
  rates: RateTable,
): Promise<Record<string, Record<string, PostedMatch>>> {
  const result: Record<string, Record<string, PostedMatch>> = {};
  const accounts = await prisma.account.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true, currency: true } });
  const currencyOf = new Map(accounts.map((account) => [account.id, account.currency]));
  for (const row of rows) {
    if (row.status !== "PENDING") continue;
    const values = {
      date: row.date,
      amount: row.amount,
      currency: row.currency,
      rawDescription: row.rawDescription,
      categoryId: row.suggestedCategoryId,
    };
    // One call per row: entries on different accounts never pair with each
    // other's posted rows, so this is each account judged separately.
    const found = await lookUpPostedDuplicates(
      accountIds.flatMap((accountId) => {
        const accountCurrency = currencyOf.get(accountId);
        // No stored figure to judge without a current rate (R20): no notice.
        if (accountCurrency && !ratesFitForWriting(rates, values.currency, accountCurrency)) return [];
        return accountCurrency ? [incomingFor({ ...values, accountId }, accountId, accountCurrency, rates)] : [];
      }),
      rates,
      { upcoming: true },
    );
    if (found && found.size > 0) result[row.id] = Object.fromEntries(found);
  }
  return result;
}
