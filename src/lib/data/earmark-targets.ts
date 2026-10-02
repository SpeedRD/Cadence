/**
 * The transaction form's side of earmarked income (src/lib/earmarks.ts):
 * which upcoming occurrences a deposit can be set aside for, and the one
 * writer of RecurringEarmark rows.
 *
 * A target is an occurrence of a subscription (an installment plan or any
 * recurring charge) in the period commitments (src/lib/period-commitments.ts)
 * from the current period through EARMARK_HORIZON_PERIODS ahead, charged to
 * the deposit's own account - money set aside in one account does not lower
 * what another account's charge asks of it - and not one posting will skip.
 * What it still asks is its cost less what every other deposit already
 * covers (wholeAmount), in the account's currency. A recurring contribution
 * is not a target: it is a goal's own money, planned by the goal (K3).
 */
import {
  canBeEarmarked,
  earmarkIssue,
  stillAskedOf,
  type EarmarkIssue,
  type EarmarkOption,
  type EarmarkRequest,
} from "@/lib/earmarks";
import { round2 } from "@/lib/money";
import { isAdoptedDeposit } from "@/lib/period-income";
import { nextPeriod, periodInfo, type PeriodInfo } from "@/lib/period";
import { wholeAmount } from "@/lib/period-commitments";
import { prisma } from "@/lib/prisma";
import { itemIdFromOccurrenceKey } from "@/lib/recurring-settlement";

import { loadAdoptedWindows } from "@/lib/data/period-income";
import { loadCommitments } from "@/lib/data/period-commitments";

import type { AppContext } from "@/lib/data/context";

/** How many pay periods, from the current one, the form offers occurrences in: six months, a typical installment plan's length. */
export const EARMARK_HORIZON_PERIODS = 12;

type TargetContext = Pick<AppContext, "today" | "rates" | "currentPeriod">;

function horizon(current: PeriodInfo): PeriodInfo[] {
  const periods = [current];
  while (periods.length < EARMARK_HORIZON_PERIODS) periods.push(periodInfo(nextPeriod(periods[periods.length - 1])));
  return periods;
}

/**
 * Every occurrence a deposit can be earmarked for (see the module comment),
 * soonest first, on every account - the form keeps the ones on the account
 * it is saving to. An occurrence nothing more can be set aside for is still
 * listed while a deposit covers part of it, so editing that deposit shows its
 * own earmark (stillAskedOf adds it back).
 */
export async function listEarmarkOptions(context: TargetContext): Promise<EarmarkOption[]> {
  const periods = horizon(context.currentPeriod);
  const commitments = await loadCommitments(periods, context);
  const result: EarmarkOption[] = [];
  for (const period of periods) {
    for (const occurrence of commitments.get(period.key) ?? []) {
      if (occurrence.kind !== "SUBSCRIPTION" || occurrence.status === "wont_post" || !occurrence.accountId) continue;
      const stillAsked = round2(wholeAmount(occurrence));
      if (stillAsked <= 0 && occurrence.earmarks.length === 0) continue;
      result.push({
        occurrenceKey: occurrence.key,
        itemId: occurrence.itemId,
        name: occurrence.name,
        dueDate: occurrence.dueDate,
        accountId: occurrence.accountId,
        currency: occurrence.currency,
        charge: round2(occurrence.amount),
        stillAsked,
        coveredBy: occurrence.earmarks.map((earmark) => ({ transactionId: earmark.transactionId, amount: earmark.amount })),
        itemAmount: occurrence.itemAmount,
        itemCurrency: occurrence.itemCurrency,
      });
    }
  }
  return result.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.name.localeCompare(b.name));
}

/** A deposit as the writer judges it: its stored amount, in its account's currency. */
export interface EarmarkDeposit {
  /** Null for a deposit not written yet. */
  id: string | null;
  accountId: string;
  amount: number;
  type: string;
  source: string;
  transferDirection: string | null;
  /**
   * The deposit's date and income flags as saved: a deposit a confirmed
   * check-in adopted as pay (isAdoptedDeposit) cannot be earmarked. Absent
   * skips that check.
   */
  date?: Date;
  isOneOffIncome?: boolean;
  reimbursesTransactionId?: string | null;
}

export type EarmarkCheck =
  | { ok: true; options: EarmarkOption[] }
  | { ok: false; issue: EarmarkIssue | "not_depositable" | "adopted_paycheck" };

/**
 * Whether `requests` can be written for `deposit` (earmarkIssue over the
 * occurrences on its account). No requests is always fine - it clears the
 * deposit's earmarks.
 */
export async function checkEarmarks(
  deposit: EarmarkDeposit,
  requests: readonly EarmarkRequest[],
  context: TargetContext,
): Promise<EarmarkCheck> {
  if (requests.length === 0) return { ok: true, options: [] };
  if (!canBeEarmarked(deposit)) return { ok: false, issue: "not_depositable" };
  // Part of a confirmed check-in's paycheck: already the plan's income, so
  // setting it aside for a payment would count the money twice - the rule a
  // check-in's own paycheck row is under (canBeEarmarked).
  if (
    deposit.date &&
    isAdoptedDeposit(
      {
        accountId: deposit.accountId,
        date: deposit.date,
        type: deposit.type,
        source: deposit.source,
        isOneOffIncome: deposit.isOneOffIncome ?? false,
        reimbursesTransactionId: deposit.reimbursesTransactionId ?? null,
      },
      await loadAdoptedWindows(),
    )
  ) {
    return { ok: false, issue: "adopted_paycheck" };
  }
  const options = (await listEarmarkOptions(context)).filter(
    (option) => option.accountId === deposit.accountId,
  );
  const issue = earmarkIssue(
    deposit.amount,
    requests,
    options.map((option) => ({ occurrenceKey: option.occurrenceKey, stillAsked: stillAskedOf(option, deposit.id) })),
  );
  return issue ? { ok: false, issue } : { ok: true, options };
}

/**
 * Replaces `deposit`'s earmarks with `requests`, after checking them again
 * against the occurrences as they are now: the rows it no longer names go,
 * the rest are written in the account's currency. Nothing is written when
 * the check fails. A deposit that can no longer carry earmarks (its type
 * changed, say) keeps none.
 */
export async function saveEarmarks(
  deposit: EarmarkDeposit & { id: string },
  requests: readonly EarmarkRequest[],
  context: TargetContext,
): Promise<EarmarkCheck> {
  if (!canBeEarmarked(deposit) || requests.length === 0) {
    await prisma.recurringEarmark.deleteMany({ where: { transactionId: deposit.id } });
    return requests.length === 0 ? { ok: true, options: [] } : { ok: false, issue: "not_depositable" };
  }
  const check = await checkEarmarks(deposit, requests, context);
  if (!check.ok) return check;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: deposit.accountId }, select: { currency: true } });
  const optionByKey = new Map(check.options.map((option) => [option.occurrenceKey, option]));
  const itemIds = [...new Set(requests.map((request) => itemIdFromOccurrenceKey(request.occurrenceKey)))].filter(
    (id): id is string => id !== null,
  );
  const existingItems = new Set(
    (await prisma.recurringItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } })).map((item) => item.id),
  );
  await prisma.$transaction(async (tx) => {
    await tx.recurringEarmark.deleteMany({
      where: { transactionId: deposit.id, occurrenceKey: { notIn: requests.map((request) => request.occurrenceKey) } },
    });
    for (const request of requests) {
      const option = optionByKey.get(request.occurrenceKey) as EarmarkOption;
      const itemId = itemIdFromOccurrenceKey(request.occurrenceKey);
      const data = {
        amount: round2(request.amount),
        currency: account.currency,
        dueDate: option.dueDate,
        recurringItemId: itemId && existingItems.has(itemId) ? itemId : null,
      };
      await tx.recurringEarmark.upsert({
        where: { transactionId_occurrenceKey: { transactionId: deposit.id, occurrenceKey: request.occurrenceKey } },
        create: { transactionId: deposit.id, occurrenceKey: request.occurrenceKey, ...data },
        update: data,
      });
    }
  });
  return check;
}
