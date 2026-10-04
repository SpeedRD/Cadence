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
 *
 * An occurrence outside those periods that a deposit is already set aside
 * for - one already due in an earlier period - is listed for that deposit
 * only (EarmarkOption.onlyFor), so editing the deposit shows and keeps its
 * line. The writer changes only what the form changed: lines the form sends
 * unchanged are kept as stored, and a stored earmark goes only when the form
 * names it as removed.
 */
import {
  canBeEarmarked,
  EARMARK_TOLERANCE,
  earmarkIssue,
  offeredTo,
  stillAskedOf,
  type EarmarkIssue,
  type EarmarkOption,
  type EarmarkRequest,
} from "@/lib/earmarks";
import { exceedsCents, num, round2, withinCents } from "@/lib/money";
import { isAdoptedDeposit } from "@/lib/period-income";
import { nextPeriod, periodForDate, periodInfo, type PeriodInfo } from "@/lib/period";
import { wholeAmount, type CommitmentOccurrence } from "@/lib/period-commitments";
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
  const offered = new Set(periods.map((period) => period.key));
  // Occurrences outside the horizon that deposits are already set aside for,
  // each in its own period, and which deposits hold them.
  const stored = await prisma.recurringEarmark.findMany({
    where: { OR: [{ dueDate: { lt: periods[0].start } }, { dueDate: { gt: periods[periods.length - 1].end } }] },
    select: { occurrenceKey: true, transactionId: true, dueDate: true },
  });
  const heldBy = new Map<string, string[]>();
  const elsewhere = new Map<string, PeriodInfo>();
  for (const row of stored) {
    heldBy.set(row.occurrenceKey, [...(heldBy.get(row.occurrenceKey) ?? []), row.transactionId]);
    const period = periodForDate(row.dueDate);
    if (!offered.has(period.key)) elsewhere.set(period.key, period);
  }
  const commitments = await loadCommitments([...periods, ...elsewhere.values()], context);

  const optionOf = (occurrence: CommitmentOccurrence, onlyFor?: string[]): EarmarkOption | null => {
    if (occurrence.kind !== "SUBSCRIPTION" || occurrence.status === "wont_post" || !occurrence.accountId) return null;
    const stillAsked = round2(wholeAmount(occurrence));
    if (!onlyFor && stillAsked <= 0 && occurrence.earmarks.length === 0) return null;
    return {
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
      ...(onlyFor ? { onlyFor } : {}),
    };
  };
  const result: EarmarkOption[] = [];
  for (const [key, occurrences] of commitments) {
    for (const occurrence of occurrences) {
      const onlyFor = offered.has(key) ? undefined : heldBy.get(occurrence.key);
      if (!offered.has(key) && !onlyFor) continue;
      const option = optionOf(occurrence, onlyFor);
      if (option) result.push(option);
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
  /** When the deposit was written; null for one not written yet. */
  createdAt?: Date | null;
  isOneOffIncome?: boolean;
  reimbursesTransactionId?: string | null;
}

export type EarmarkCheck =
  | { ok: true; options: EarmarkOption[] }
  | { ok: false; issue: EarmarkIssue | "not_depositable" | "adopted_paycheck" };

/** What the form says about a deposit's earmarks besides its lines: the stored ones the user removed. */
export interface EarmarkChanges {
  /** Occurrence keys of stored earmarks the user removed (a line taken out, its payment changed, the switch turned off, the deposit moved to another account). */
  removed?: readonly string[];
  /**
   * The deposit was moved to another account: what it set aside on the old
   * one's payments goes unless sent again, and a line sent again is judged
   * against the new account's payments like a new one.
   */
  accountChanged?: boolean;
}

/** A deposit's stored earmarks, by occurrence key, amounts as stored. */
async function storedEarmarks(depositId: string | null): Promise<Map<string, { amount: number; currency: string }>> {
  if (!depositId) return new Map();
  const rows = await prisma.recurringEarmark.findMany({
    where: { transactionId: depositId },
    select: { occurrenceKey: true, amount: true, currency: true },
  });
  return new Map(rows.map((row) => [row.occurrenceKey, { amount: num(row.amount), currency: row.currency }]));
}

/**
 * Whether `requests` can be written for `deposit` (earmarkIssue over the
 * occurrences on its account). A line the form sends exactly as stored is
 * kept as it is, not judged again - its occurrence may since have fallen
 * into an earlier period, or shrunk - and a stored earmark the form neither
 * sends nor names as removed stays too; both still count toward what the
 * deposit can hold. No requests and no removals is always fine: nothing
 * changes.
 */
export async function checkEarmarks(
  deposit: EarmarkDeposit,
  requests: readonly EarmarkRequest[],
  context: TargetContext,
  changes: EarmarkChanges = {},
): Promise<EarmarkCheck> {
  if (requests.length === 0) return { ok: true, options: [] };
  const stored = await storedEarmarks(deposit.id);
  const requested = new Set(requests.map((request) => request.occurrenceKey));
  const removed = new Set(changes.removed ?? []);
  const accountCurrency = stored.size > 0
    ? (await prisma.account.findUnique({ where: { id: deposit.accountId }, select: { currency: true } }))?.currency
    : undefined;
  const asStored = (request: EarmarkRequest) => {
    const row = stored.get(request.occurrenceKey);
    return Boolean(
      !changes.accountChanged && row && row.currency === accountCurrency && withinCents(row.amount, request.amount, EARMARK_TOLERANCE),
    );
  };
  const kept = changes.accountChanged
    ? 0
    : round2(
        [...stored]
          .filter(([key, row]) => !requested.has(key) && !removed.has(key) && row.currency === accountCurrency)
          .reduce((sum, [, row]) => sum + row.amount, 0),
      );
  if (requests.every(asStored)) {
    const total = requests.reduce((sum, request) => sum + request.amount, 0);
    return exceedsCents(total + kept, deposit.amount, EARMARK_TOLERANCE) ? { ok: false, issue: "over_deposit" } : { ok: true, options: [] };
  }
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
        createdAt: deposit.createdAt ?? null,
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
    (option) => option.accountId === deposit.accountId && offeredTo(option, deposit.id),
  );
  const targets = new Map(options.map((option) => [option.occurrenceKey, stillAskedOf(option, deposit.id)]));
  // A line kept as stored passes as it stands.
  for (const request of requests) {
    if (asStored(request)) targets.set(request.occurrenceKey, Math.max(targets.get(request.occurrenceKey) ?? 0, request.amount));
  }
  const issue = earmarkIssue(
    deposit.amount,
    requests,
    [...targets].map(([occurrenceKey, stillAsked]) => ({ occurrenceKey, stillAsked })),
    kept,
  );
  return issue ? { ok: false, issue } : { ok: true, options };
}

/**
 * Writes `deposit`'s earmarks as the form left them, after checking the new
 * and changed lines against the occurrences as they are now: those are
 * written in the account's currency, the stored ones `changes.removed`
 * names go, and every other stored earmark - sent unchanged, or not shown at
 * all - is kept as it is. Nothing is written when the check fails. A
 * deposit that can no longer carry earmarks (its type changed, say) keeps
 * none.
 */
export async function saveEarmarks(
  deposit: EarmarkDeposit & { id: string },
  requests: readonly EarmarkRequest[],
  context: TargetContext,
  changes: EarmarkChanges = {},
): Promise<EarmarkCheck> {
  if (!canBeEarmarked(deposit)) {
    await prisma.recurringEarmark.deleteMany({ where: { transactionId: deposit.id } });
    return requests.length === 0 ? { ok: true, options: [] } : { ok: false, issue: "not_depositable" };
  }
  const requestedKeys = new Set(requests.map((request) => request.occurrenceKey));
  const removed = (changes.accountChanged ? [...(await storedEarmarks(deposit.id)).keys()] : (changes.removed ?? [])).filter(
    (key) => !requestedKeys.has(key),
  );
  if (requests.length === 0) {
    if (removed.length > 0) {
      await prisma.recurringEarmark.deleteMany({ where: { transactionId: deposit.id, occurrenceKey: { in: removed } } });
    }
    return { ok: true, options: [] };
  }
  const first = await checkEarmarks(deposit, requests, context, { removed, accountChanged: changes.accountChanged });
  if (!first.ok) return first;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: deposit.accountId }, select: { currency: true } });
  const itemIds = [...new Set(requests.map((request) => itemIdFromOccurrenceKey(request.occurrenceKey)))].filter(
    (id): id is string => id !== null,
  );
  const existingItems = new Set(
    (await prisma.recurringItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } })).map((item) => item.id),
  );
  // One writer per occurrence, and per deposit, at a time: two saves for one
  // occurrence (two deposits, or the same form submitted twice) each checked
  // before the other wrote, and together could cover more than it costs. The
  // locks are taken in one order, and the bounds checked again once they are
  // held - after any save that held them first has committed, so its
  // earmarks are counted (the check reads through the shared client, which
  // sees what has committed; this transaction has written nothing yet).
  // Released at commit or rollback.
  const lockKeys = [`earmark-deposit:${deposit.id}`, ...[...requestedKeys].sort().map((key) => `earmark-occurrence:${key}`)];
  const check = await prisma.$transaction(async (tx) => {
    for (const key of lockKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const held = await checkEarmarks(deposit, requests, context, { removed, accountChanged: changes.accountChanged });
    if (!held.ok) return held;
    const optionByKey = new Map(held.options.map((option) => [option.occurrenceKey, option]));
    if (removed.length > 0) {
      await tx.recurringEarmark.deleteMany({ where: { transactionId: deposit.id, occurrenceKey: { in: removed } } });
    }
    for (const request of requests) {
      // A line sent as stored, whose occurrence is not offered any more, is
      // kept as it is.
      const option = optionByKey.get(request.occurrenceKey);
      if (!option) continue;
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
    return held;
  }, { maxWait: 10_000, timeout: 30_000 });
  return check;
}
