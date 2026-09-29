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
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

import { applyPostedMatch, lookUpPostedDuplicates, type PostedLookup, type PostedMatch } from "@/lib/data/posted-duplicates";

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
   * write nothing new - or "different" - approve it as its own expense. Null
   * when no match was shown.
   */
  resolution: "posted" | "different" | null;
}

export type StagedApprovalResult =
  | { ok: true; outcome: "approved" }
  | { ok: true; outcome: "kept_posted"; match: PostedMatch; updated: boolean }
  | { ok: false; reason: "not_found" | "already_reviewed" | "account_missing" | "exists" | "match_gone" | "check_failed" }
  | { ok: false; reason: "needs_choice"; match: PostedMatch };

/** The staged values as the row it would become, for the matcher. */
function incomingFor(input: Omit<StagedApprovalInput, "id" | "resolution">, key: string) {
  return {
    key,
    accountId: input.accountId,
    type: "EXPENSE" as const,
    date: input.date,
    amount: input.amount,
    currency: input.currency,
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

  const account = await prisma.account.findUnique({ where: { id: input.accountId }, select: { id: true } });
  if (!account) return { ok: false, reason: "account_missing" };

  const found = await lookUpPostedDuplicates([incomingFor(input, staged.id)], rates, options);
  if (!found && input.resolution === "posted") return { ok: false, reason: "check_failed" };
  const match = found?.get(staged.id) ?? null;
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
    if (!match) return { ok: false, reason: "match_gone" };
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

  try {
    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          date: input.date,
          amount: input.amount,
          currency: input.currency,
          type: "EXPENSE",
          accountId: input.accountId,
          categoryId: input.categoryId,
          note: input.rawDescription,
          source: staged.source,
          externalId: staged.externalId,
        },
      }),
      prisma.stagedTransaction.update({ where: { id: staged.id }, data: reviewed }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, reason: "exists" };
    }
    throw error;
  }
  return { ok: true, outcome: "approved" };
}

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
      accountIds.map((accountId) => incomingFor({ ...values, accountId }, accountId)),
      rates,
    );
    if (found && found.size > 0) result[row.id] = Object.fromEntries(found);
  }
  return result;
}
