/**
 * Loads what planPostedDuplicates (src/lib/recurring-settlement.ts) needs and
 * turns its verdicts into what the entry points show: for each row being
 * brought in - a CSV row, an approved receipt, a manual entry - the RECURRING
 * row posting already wrote for that money, or the paycheck a check-in already
 * recorded, if one matches. Read by the CSV import (src/lib/data/import.ts and
 * detectCsvDuplicatesAction), the review queue (src/lib/data/staged-approval.ts)
 * and the transaction form (saveTransactionAction), and by
 * scripts/verify-no-double-counting.ts over rows already in the ledger.
 *
 * Nothing here decides: every match is put to the user. applyPostedMatch is
 * what "It's the posted charge" does to the posted row, and
 * keepPostedInsteadOfEntry the same answer for an entry already saved by hand.
 *
 * A charge entered by hand, a CSV row and a receipt being approved are also
 * checked against what has not posted yet (`upcoming`): an occurrence of an
 * item in another currency than its account's, which the charge - in the
 * account's currency - can never settle by amount, so posting would write it
 * again on its due date. Only ever a possible match; "It's that payment" is
 * recordUpcomingPayment, for a hand entry through keepEntryAsUpcoming.
 */
import { createHash } from "node:crypto";

import { roundRate, storedMoney, type StoredMoney } from "@/lib/account-money";

import { addDays, fromISODate, maxDate, minDate, toISODate } from "@/lib/date";
import { num, type DecimalLike } from "@/lib/money";
import { fundedPeriodFor, periodInfo } from "@/lib/period";
import { scheduleDates } from "@/lib/period-commitments";
import { prisma } from "@/lib/prisma";
import { advanceDate, skipReasonFor } from "@/lib/recurring";
import {
  itemIdFromOccurrenceKey,
  paycheckWindow,
  planPostedDuplicates,
  recurringExternalId,
  settlementWindow,
  type IncomingEntry,
  type MatchableItem,
  type PostedEntry,
} from "@/lib/recurring-settlement";

import { loadSettlementPlan, rolledPast } from "@/lib/data/recurring-settlement";

import type { Prisma } from "@/generated/prisma/client";
import type { RateTable } from "@/lib/currency";

/**
 * How far either side of the incoming rows' dates a posted row is looked for.
 * A window reaches at most a pay period plus SETTLEMENT_LEAD_DAYS around its
 * row's date, and a paycheck's row sits within a few days of its planned
 * period, so this only bounds the read.
 */
const LOOKUP_MARGIN_DAYS = 40;

/** One posted row as the entry points show it - for an upcoming occurrence, its key, due date and the item's charge. */
export interface PostedMatchRow {
  id: string;
  kind: "recurring" | "paycheck" | "upcoming";
  /** The recurring item's name (the row's note once the item is gone), or the paycheck's note. */
  label: string | null;
  /** The account it is on (for an upcoming occurrence, the item's). */
  accountName: string;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  currency: string;
}

export interface PostedMatch {
  kind: "recurring" | "paycheck" | "upcoming";
  /** Only after converting between currencies, or the row neither names the item nor lands within PROXIMITY_DAYS of it: a warning, never resolved unless the user says so. */
  possible: boolean;
  /** Several items survive the look-alike guard; `others` lists the rest. */
  ambiguous: boolean;
  /** The row "It's the posted charge" (or "the paycheck already recorded") pairs with. */
  posted: PostedMatchRow;
  others: PostedMatchRow[];
  /**
   * The incoming row's account, when it is not the posted row's: a charge
   * on another card than the one the item posts to. The question names both.
   */
  entryAccountName: string | null;
  /**
   * What choosing the posted charge writes on `posted`: the incoming amount and
   * currency in place of its own - as the incoming row stores them, in the
   * account's currency, with what it was entered as - and, for a charge on
   * another account, that account: the money left from there. Nothing else.
   * Null when they already agree, and always for a paycheck (a check-in owns
   * it), an ambiguous match (which row is meant is not known) and, on its
   * own account, a contribution's ledger half (its GoalContribution must stay
   * in step; on another account the match is exact, so the money is the same).
   */
  rewrite: (StoredMoney & { accountId?: string }) | null;
}

type Client = Prisma.TransactionClient;

/** A rate table, or how to get one - only called when a comparison across currencies is needed. */
export type RatesSource = RateTable | (() => Promise<RateTable>);

/**
 * The posted row each incoming row most likely duplicates, keyed by the
 * incoming row's key. `incoming` is one batch: a posted row pairs with at
 * most one of them. A batch with no posted row near it costs one read and
 * never asks for rates; rates are resolved only when a posted row and an
 * incoming one on the same account are in different currencies.
 */
export async function findPostedDuplicates(
  incoming: readonly IncomingEntry[],
  rates: RatesSource,
  client: Client = prisma,
  options: { upcoming?: boolean } = {},
): Promise<Map<string, PostedMatch>> {
  const result = new Map<string, PostedMatch>();
  if (incoming.length === 0) return result;

  const accountIds = [...new Set(incoming.map((entry) => entry.accountId))];
  let earliest = incoming[0].date;
  let latest = incoming[0].date;
  for (const entry of incoming) {
    earliest = minDate(earliest, entry.date);
    latest = maxDate(latest, entry.date);
  }

  // A RECURRING row on any account: a charge from another card than the one
  // the item posts to is its money too (planPostedDuplicates). A paycheck
  // only on the deposit's own account.
  const rows = await client.transaction.findMany({
    where: {
      date: { gte: addDays(earliest, -LOOKUP_MARGIN_DAYS), lte: addDays(latest, LOOKUP_MARGIN_DAYS) },
      OR: [
        { source: "RECURRING", type: "EXPENSE" },
        { source: "PAYDAY_CHECKIN", type: "INCOME", accountId: { in: accountIds } },
      ],
    },
    select: {
      id: true,
      date: true,
      amount: true,
      currency: true,
      originalAmount: true,
      originalCurrency: true,
      type: true,
      accountId: true,
      source: true,
      externalId: true,
      note: true,
    },
  });
  const upcoming = options.upcoming ? await loadUpcomingEntries(incoming, earliest, latest, client) : [];
  if (rows.length === 0 && upcoming.length === 0) return result;

  const recurringKeys = rows
    .filter((row) => row.source === "RECURRING" && row.externalId)
    .map((row) => row.externalId as string);
  const itemIds = [...new Set(recurringKeys.map(itemIdFromOccurrenceKey).filter((id): id is string => id !== null))];
  const paycheckIds = rows.filter((row) => row.source === "PAYDAY_CHECKIN").map((row) => row.id);

  const [postedItems, activeItems, contributionKeys, snapshots, accounts] = await Promise.all([
    itemIds.length
      ? client.recurringItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, amount: true, currency: true, categoryId: true, frequency: true, anchorDay: true, secondAnchorDay: true },
        })
      : [],
    // The look-alike guard is judged over every active item, as posting judges it.
    client.recurringItem.findMany({
      where: { active: true },
      select: { id: true, name: true, amount: true, currency: true, categoryId: true },
    }),
    recurringKeys.length
      ? client.goalContribution.findMany({
          where: { recurringExternalId: { in: recurringKeys } },
          select: { recurringExternalId: true },
        })
      : [],
    paycheckIds.length
      ? client.paydayAccountSnapshot.findMany({
          where: { incomeTransactionId: { in: paycheckIds } },
          select: { incomeTransactionId: true, checkin: { select: { year: true, month: true, period: true } } },
        })
      : [],
    client.account.findMany({
      where: { id: { in: [...new Set([...accountIds, ...rows.map((row) => row.accountId), ...upcoming.map((entry) => entry.accountId)])] } },
      select: { id: true, name: true },
    }),
  ]);
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));

  const toMatchable = (item: { id: string; name: string; amount: DecimalLike; currency: string; categoryId: string | null }): MatchableItem => ({
    id: item.id,
    name: item.name,
    amount: num(item.amount),
    currency: item.currency,
    categoryId: item.categoryId,
  });
  const itemById = new Map(postedItems.map((item) => [item.id, toMatchable(item)]));
  const scheduleById = new Map(postedItems.map((item) => [item.id, item]));
  const contributionHalves = new Set(contributionKeys.map((row) => row.recurringExternalId as string));
  const plannedByPaycheck = new Map(
    snapshots.map((snapshot) => [snapshot.incomeTransactionId as string, periodInfo(snapshot.checkin)]),
  );

  const posted: PostedEntry[] = [];
  const viewById = new Map<string, PostedMatchRow>();
  const rewritable = new Set<string>();
  for (const row of rows) {
    const kind = row.source === "RECURRING" ? "recurring" : "paycheck";
    const itemId = kind === "recurring" && row.externalId ? (itemIdFromOccurrenceKey(row.externalId) ?? "") : "";
    const item = itemById.get(itemId) ?? null;
    const schedule = scheduleById.get(itemId);
    const keyDue = row.externalId ? fromISODate(row.externalId.slice(row.externalId.lastIndexOf(":") + 1)) : null;
    // The item's next occurrence bounds this one's window past its period.
    const nextDue = schedule && keyDue ? advanceDate(keyDue, schedule.frequency, schedule.anchorDay, schedule.secondAnchorDay) : null;
    const planned = plannedByPaycheck.get(row.id);
    posted.push({
      id: row.id,
      kind,
      accountId: row.accountId,
      type: row.type as "EXPENSE" | "INCOME",
      date: row.date,
      amount: num(row.amount),
      currency: row.currency,
      originalAmount: row.originalAmount === null ? null : num(row.originalAmount),
      originalCurrency: row.originalCurrency,
      // A paycheck whose snapshot is gone falls back to the funding window of
      // the period its own day funds.
      window:
        kind === "paycheck" ? paycheckWindow(planned ?? fundedPeriodFor(row.date)) : settlementWindow(row.date, nextDue),
      item,
    });
    viewById.set(row.id, {
      id: row.id,
      kind,
      label: item?.name ?? row.note,
      accountName: accountName.get(row.accountId) ?? "",
      date: toISODate(row.date),
      amount: num(row.amount),
      currency: row.currency,
    });
    if (kind === "recurring" && !(row.externalId && contributionHalves.has(row.externalId))) rewritable.add(row.id);
  }
  for (const entry of upcoming) {
    posted.push(entry);
    viewById.set(entry.id, {
      id: entry.id,
      kind: "upcoming",
      label: entry.item?.name ?? null,
      accountName: accountName.get(entry.accountId) ?? "",
      date: toISODate(entry.date),
      amount: entry.amount,
      currency: entry.currency,
    });
  }

  const incomingByKey = new Map(incoming.map((entry) => [entry.key, entry]));
  const crossCurrency = posted.some((row) =>
    incoming.some((entry) => entry.accountId === row.accountId && entry.currency !== row.currency),
  );
  // Without a pair in different currencies the planner never converts, so
  // an empty table stands in rather than loading (or fetching) real rates.
  const table: RateTable = !crossCurrency
    ? { rates: {}, fetchedAt: null, stale: true, source: "open-er-api", asOf: null }
    : typeof rates === "function"
      ? await rates()
      : rates;
  const plan = planPostedDuplicates({ incoming, posted, items: activeItems.map(toMatchable), rates: table });
  for (const [key, verdict] of plan) {
    const entry = incomingByKey.get(key) as IncomingEntry;
    const primary = viewById.get(verdict.postedId) as PostedMatchRow;
    const postedEntry = posted.find((row) => row.id === verdict.postedId) as PostedEntry;
    const incomingMoney = rewriteFor(storedMoney(entry), postedEntry);
    const otherAccount = postedEntry.accountId !== entry.accountId;
    const differs =
      otherAccount ||
      primary.currency !== incomingMoney.currency ||
      Math.round(primary.amount * 100) !== Math.round(incomingMoney.amount * 100) ||
      (postedEntry.originalCurrency ?? null) !== incomingMoney.originalCurrency ||
      Math.round((postedEntry.originalAmount ?? 0) * 100) !== Math.round((incomingMoney.originalAmount ?? 0) * 100);
    result.set(key, {
      kind: primary.kind,
      possible: verdict.possible,
      ambiguous: verdict.ambiguous,
      posted: primary,
      others: verdict.candidateIds.slice(1).map((id) => viewById.get(id) as PostedMatchRow),
      entryAccountName: otherAccount ? (accountName.get(entry.accountId) ?? "") : null,
      rewrite:
        !differs || verdict.ambiguous || postedEntry.kind !== "recurring"
          ? null
          : otherAccount
            ? { ...incomingMoney, accountId: entry.accountId }
            : rewritable.has(primary.id)
              ? incomingMoney
              : null,
    });
  }
  return result;
}

/**
 * What "It's the posted charge" writes on a posted row: the incoming money as
 * the account stores it. A bank's figure in the account's own currency for a
 * row posting converted from the item's currency keeps what that row was
 * entered as - the item's amount - with the rate the bank's figure implies,
 * so the row still says what it was charged for.
 */
function rewriteFor(incoming: StoredMoney, posted: PostedEntry): StoredMoney {
  if (incoming.originalCurrency !== null || posted.originalCurrency == null || posted.originalAmount == null) return incoming;
  if (posted.originalCurrency === incoming.currency || posted.currency !== incoming.currency || posted.originalAmount <= 0) {
    return incoming;
  }
  return {
    ...incoming,
    originalAmount: posted.originalAmount,
    originalCurrency: posted.originalCurrency,
    rate: roundRate(incoming.amount / posted.originalAmount),
  };
}

/**
 * The occurrences a hand-entered charge may be although posting has not
 * written them: for each active subscription on one of the charges' accounts
 * whose currency is not that account's, every due date from its nextDate
 * whose settlement window can hold one of the charges, unless posting already
 * wrote it or its own settlement plan already pairs a charge with it (then
 * posting takes care of it), or posting will skip the item. Only charges
 * entered in their account's currency are asked about: one entered in the
 * item's currency is settled by posting on its own when it holds the item's
 * amount.
 */
async function loadUpcomingEntries(
  incoming: readonly IncomingEntry[],
  earliest: Date,
  latest: Date,
  client: Client,
): Promise<PostedEntry[]> {
  const charges = incoming.filter((entry) => entry.type === "EXPENSE" && !entry.originalCurrency);
  if (charges.length === 0) return [];
  const accountIds = [...new Set(charges.map((entry) => entry.accountId))];
  const [accounts, items] = await Promise.all([
    client.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, currency: true } }),
    client.recurringItem.findMany({
      where: { active: true, kind: "SUBSCRIPTION", accountId: { in: accountIds } },
      select: {
        id: true,
        name: true,
        amount: true,
        currency: true,
        categoryId: true,
        kind: true,
        goalId: true,
        frequency: true,
        nextDate: true,
        anchorDay: true,
        secondAnchorDay: true,
        remainingOccurrences: true,
        accountId: true,
        account: { select: { status: true } },
        goal: { select: { achievedAt: true } },
      },
    }),
  ]);
  const currencyOf = new Map(accounts.map((account) => [account.id, account.currency]));
  const foreign = items.filter(
    (item) => item.accountId && item.currency !== currencyOf.get(item.accountId) && skipReasonFor(item) === null,
  );
  if (foreign.length === 0) return [];
  // A window reaches SETTLEMENT_LEAD_DAYS before its due date and to its
  // period's end, so a due date within LOOKUP_MARGIN_DAYS of the charges
  // covers every window that can hold one.
  const through = addDays(latest, LOOKUP_MARGIN_DAYS);
  const from = addDays(earliest, -LOOKUP_MARGIN_DAYS);
  const plan = await loadSettlementPlan(through);
  const entries: PostedEntry[] = [];
  for (const item of foreign) {
    const matchable: MatchableItem = { id: item.id, name: item.name, amount: num(item.amount), currency: item.currency, categoryId: item.categoryId };
    for (const date of scheduleDates({ ...item }, earliest, {
      through,
      alreadyPosted: (due) => rolledPast(plan, recurringExternalId(item.id, due)),
    })) {
      const key = recurringExternalId(item.id, date.dueDate);
      if (date.dueDate.getTime() < from.getTime() || plan.posted.has(key) || plan.settledBy.has(key)) continue;
      const nextDue = advanceDate(date.dueDate, item.frequency, item.anchorDay, item.secondAnchorDay);
      entries.push({
        id: key,
        kind: "upcoming",
        accountId: item.accountId as string,
        type: "EXPENSE",
        date: date.dueDate,
        amount: matchable.amount,
        currency: item.currency,
        originalAmount: null,
        originalCurrency: null,
        window: settlementWindow(date.dueDate, nextDue),
        item: matchable,
      });
    }
  }
  return entries;
}

export type PostedLookup = typeof findPostedDuplicates;

/** How long a duplicate hint may take before the write it hints at goes ahead without it. */
export const POSTED_LOOKUP_TIMEOUT_MS = 2000;

/**
 * findPostedDuplicates for the entry points, failing open: a duplicate hint
 * must never block a money write, so a lookup that throws or takes longer
 * than `timeoutMs` is logged and answered with null - the caller then writes
 * as it did before this check existed, with no notice. `lookup` exists for
 * scripts/verify-domain.ts to force both failures.
 */
export async function lookUpPostedDuplicates(
  incoming: readonly IncomingEntry[],
  rates: RatesSource,
  options: { lookup?: PostedLookup; timeoutMs?: number; upcoming?: boolean } = {},
): Promise<Map<string, PostedMatch> | null> {
  const lookup = options.lookup ?? findPostedDuplicates;
  const timeoutMs = options.timeoutMs ?? POSTED_LOOKUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(incoming, rates, prisma, { upcoming: options.upcoming }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[posted-duplicates] lookup gave no answer within ${timeoutMs}ms; writing without the hint`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error("[posted-duplicates] lookup failed; writing without the hint", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "It's the posted charge": the incoming row is not written, and when the
 * match carries a rewrite, the posted RECURRING row takes the incoming amount
 * and currency - the bank's or the receipt's figure for the money that really
 * moved, in the account's currency, with what it was entered as - and, for a
 * charge on another account, moves to that account. No other field changes,
 * a paycheck is never touched, and nothing is deleted. Returns whether the
 * posted row changed.
 */
export async function applyPostedMatch(client: Client, match: PostedMatch): Promise<boolean> {
  if (!match.rewrite) return false;
  const updated = await client.transaction.updateMany({
    where: { id: match.posted.id, source: "RECURRING" },
    data: {
      ...(match.rewrite.accountId ? { accountId: match.rewrite.accountId } : {}),
      amount: match.rewrite.amount,
      currency: match.rewrite.currency,
      originalAmount: match.rewrite.originalAmount,
      originalCurrency: match.rewrite.originalCurrency,
      rate: match.rewrite.rate,
    },
  });
  return updated.count > 0;
}

/**
 * The saved state of a hand entry, as a short digest: what the transaction
 * form's save hands to its "It's the posted charge" question, so the answer
 * applies only to the row exactly as it was saved.
 */
export function entryDigest(row: {
  id: string;
  createdAt: Date;
  date: Date;
  amount: DecimalLike;
  currency: string;
  originalAmount: DecimalLike;
  originalCurrency: string | null;
  rate: DecimalLike;
  type: string;
  accountId: string;
  categoryId: string | null;
  note: string | null;
  yourShare: DecimalLike;
  reimbursesTransactionId: string | null;
  isExtraordinary: boolean;
  isOneOffIncome: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.createdAt.toISOString(),
        toISODate(row.date),
        num(row.amount).toFixed(2),
        row.currency,
        row.originalAmount === null || row.originalAmount === undefined ? null : num(row.originalAmount).toFixed(2),
        row.originalCurrency,
        row.rate === null || row.rate === undefined ? null : num(row.rate).toString(),
        row.type,
        row.accountId,
        row.categoryId,
        row.note,
        row.yourShare === null || row.yourShare === undefined ? null : num(row.yourShare).toFixed(2),
        row.reimbursesTransactionId,
        row.isExtraordinary,
        row.isOneOffIncome,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export type KeepPostedResult =
  | { ok: true; match: PostedMatch; updated: boolean }
  | { ok: false; reason: "not_found" | "not_applicable" | "changed" | "match_gone" | "check_failed" };

/**
 * "It's the posted charge" (or "the paycheck already recorded") for an entry
 * the user just added by hand - the transaction form asks after saving, the
 * way it asks about a one-off. It removes that entry and nothing else:
 *
 *   - the row is named by the id the save returned, and must still be exactly
 *     as saved (`savedDigest`, entryDigest) - an entry edited since, in this
 *     tab or another, is refused;
 *   - the match is recomputed here from the stored row, never taken from the
 *     client, and must still be the posted row the question showed
 *     (`postedId`);
 *   - the delete is a compare-and-delete on every field the digest covers,
 *     inside the same database transaction as the posted row's rewrite, and
 *     the rewrite only happens when that delete removed exactly one row - so
 *     a second click, or the same answer from a second tab, finds nothing to
 *     delete and changes nothing.
 *
 * Only a plain hand entry qualifies: MANUAL, no externalId (a goal
 * contribution's own expense has one), not a transfer leg, not already
 * standing for a recurring occurrence, and with no deposits paying it back.
 */
export async function keepPostedInsteadOfEntry(
  input: { transactionId: string; savedDigest: string; postedId: string },
  rates: RatesSource,
  options: { lookup?: PostedLookup; timeoutMs?: number } = {},
): Promise<KeepPostedResult> {
  const entry = await prisma.transaction.findUnique({
    where: { id: input.transactionId },
    include: {
      recurringSettlement: { select: { id: true } },
      _count: { select: { reimbursements: true } },
    },
  });
  if (!entry) return { ok: false, reason: "not_found" };
  if (
    entry.source !== "MANUAL" ||
    entry.externalId !== null ||
    entry.transferId !== null ||
    (entry.type !== "EXPENSE" && entry.type !== "INCOME") ||
    entry.recurringSettlement !== null ||
    entry._count.reimbursements > 0
  ) {
    return { ok: false, reason: "not_applicable" };
  }
  if (entryDigest(entry) !== input.savedDigest) return { ok: false, reason: "changed" };

  const found = await lookUpPostedDuplicates(
    [
      {
        key: entry.id,
        accountId: entry.accountId,
        type: entry.type,
        date: entry.date,
        amount: num(entry.amount),
        currency: entry.currency,
        originalAmount: entry.originalAmount === null ? null : num(entry.originalAmount),
        originalCurrency: entry.originalCurrency,
        rate: entry.rate === null ? null : num(entry.rate),
        note: entry.note,
        categoryId: entry.categoryId,
      },
    ],
    rates,
    options,
  );
  if (!found) return { ok: false, reason: "check_failed" };
  const match = found.get(entry.id);
  if (!match || match.posted.id !== input.postedId) return { ok: false, reason: "match_gone" };

  const outcome = await prisma.$transaction(async (tx) => {
    const deleted = await tx.transaction.deleteMany({
      where: {
        id: entry.id,
        source: "MANUAL",
        createdAt: entry.createdAt,
        date: entry.date,
        amount: entry.amount,
        currency: entry.currency,
        originalAmount: entry.originalAmount,
        originalCurrency: entry.originalCurrency,
        rate: entry.rate,
        type: entry.type,
        accountId: entry.accountId,
        categoryId: entry.categoryId,
        note: entry.note,
        yourShare: entry.yourShare,
        reimbursesTransactionId: entry.reimbursesTransactionId,
        isExtraordinary: entry.isExtraordinary,
        isOneOffIncome: entry.isOneOffIncome,
        recurringSettlement: { is: null },
      },
    });
    if (deleted.count !== 1) return null;
    return { updated: await applyPostedMatch(tx, match) };
  });
  if (!outcome) return { ok: false, reason: "not_found" };
  return { ok: true, match, updated: outcome.updated };
}

export type KeepUpcomingResult =
  | { ok: true; match: PostedMatch; itemName: string }
  | { ok: false; reason: "not_found" | "not_applicable" | "changed" | "match_gone" | "check_failed" };

/**
 * "It's that payment" for an entry the user just added by hand that may be
 * an upcoming occurrence in another currency (findPostedDuplicates'
 * `upcoming`): the user's answer is recorded as the pairing itself - a
 * RecurringSettlement of the entry with that occurrence key, the row posting
 * writes when it settles an occurrence with a charge. Posting then claims
 * the occurrence as settled by it (loadSettlementPlan keeps a recorded
 * pairing) and never charges it again, whatever the entry's note or category
 * say later. The entry itself is left exactly as typed.
 *
 * The pairing goes as one posting wrote it: deleting the entry deletes it
 * (ON DELETE CASCADE) and the occurrence posts on its due date as usual; an
 * edit to the entry keeps it.
 *
 * Guarded as keepPostedInsteadOfEntry is: a plain MANUAL expense entered in
 * its account's currency and paired with nothing, still exactly as saved
 * (`savedDigest`), whose recomputed match is still this occurrence. The
 * write is one database transaction that locks the entry, checks it again,
 * checks the occurrence is still ahead of posting (its item active, its
 * nextDate not past the due date, no RECURRING row for it) and inserts the
 * row - both of RecurringSettlement's unique keys refuse a second pairing of
 * either side.
 */
export async function keepEntryAsUpcoming(
  input: { transactionId: string; savedDigest: string; occurrenceKey: string },
  rates: RatesSource,
  options: { lookup?: PostedLookup; timeoutMs?: number } = {},
): Promise<KeepUpcomingResult> {
  const entry = await prisma.transaction.findUnique({
    where: { id: input.transactionId },
    include: { recurringSettlement: { select: { id: true } } },
  });
  if (!entry) return { ok: false, reason: "not_found" };
  if (
    entry.source !== "MANUAL" ||
    entry.externalId !== null ||
    entry.transferId !== null ||
    entry.type !== "EXPENSE" ||
    entry.originalCurrency !== null ||
    entry.recurringSettlement !== null
  ) {
    return { ok: false, reason: "not_applicable" };
  }
  if (entryDigest(entry) !== input.savedDigest) return { ok: false, reason: "changed" };

  const found = await lookUpPostedDuplicates(
    [
      {
        key: entry.id,
        accountId: entry.accountId,
        type: entry.type,
        date: entry.date,
        amount: num(entry.amount),
        currency: entry.currency,
        originalAmount: null,
        originalCurrency: null,
        rate: null,
        note: entry.note,
        categoryId: entry.categoryId,
      },
    ],
    rates,
    { ...options, upcoming: true },
  );
  if (!found) return { ok: false, reason: "check_failed" };
  const match = found.get(entry.id);
  if (!match || match.kind !== "upcoming" || match.posted.id !== input.occurrenceKey) return { ok: false, reason: "match_gone" };

  const outcome = await prisma.$transaction(async (tx) => {
    // The item's lock before the entry's, the order posting's claim takes
    // them in (the item, then the charge it settles with).
    const itemId = itemIdFromOccurrenceKey(input.occurrenceKey);
    if (itemId) await tx.$queryRaw`SELECT "id" FROM "RecurringItem" WHERE "id" = ${itemId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Transaction" WHERE "id" = ${entry.id} FOR UPDATE`;
    const current = await tx.transaction.findUnique({
      where: { id: entry.id },
      include: { recurringSettlement: { select: { id: true } } },
    });
    if (!current) return "not_found" as const;
    if (current.recurringSettlement !== null || entryDigest(current) !== input.savedDigest) return "changed" as const;
    return recordUpcomingPayment(tx, entry.id, input.occurrenceKey);
  });
  if (typeof outcome === "string") return { ok: false, reason: outcome };
  return { ok: true, match, itemName: outcome.itemName };
}

/**
 * "It's that payment", written: the pairing of a charge already in the ledger
 * (`transactionId`) with an occurrence posting has not written yet
 * (`occurrenceKey`), as the RecurringSettlement row posting itself writes when
 * it settles an occurrence with a charge. The one writer of the answer for a
 * hand entry (keepEntryAsUpcoming), a CSV row (importCsvTransactions) and an
 * approved receipt (approveStagedTransaction); run inside the caller's
 * database transaction, after the caller's own checks of the charge. The
 * occurrence must still be ahead of posting - its item active with nextDate
 * not past the due date, and no RECURRING row for it - and both of
 * RecurringSettlement's unique keys refuse a second pairing of either side;
 * otherwise "match_gone" and nothing is written.
 *
 * It first takes the item's row lock, the one posting's claim takes before
 * it reads anything (postOccurrence in src/lib/recurring-posting.ts), so the
 * two serialize on the due date: an answer that lands first is the pairing
 * the claim then keeps; one that waits on a claim finds the occurrence
 * claimed. The row leaves claimedByPostingAt empty, which is what tells
 * posting to claim it once, counting its installment.
 */
export async function recordUpcomingPayment(
  tx: Client,
  transactionId: string,
  occurrenceKey: string,
): Promise<{ itemName: string } | "match_gone"> {
  const itemId = itemIdFromOccurrenceKey(occurrenceKey);
  const dueDate = fromISODate(occurrenceKey.slice(occurrenceKey.lastIndexOf(":") + 1));
  if (!itemId || !dueDate) return "match_gone";
  await tx.$queryRaw`SELECT "id" FROM "RecurringItem" WHERE "id" = ${itemId} FOR UPDATE`;
  const item = await tx.recurringItem.findFirst({
    where: { id: itemId, active: true, nextDate: { lte: dueDate } },
    select: { id: true, name: true, kind: true },
  });
  const posted = await tx.transaction.findUnique({
    where: { source_externalId: { source: "RECURRING", externalId: occurrenceKey } },
    select: { id: true },
  });
  if (!item || posted) return "match_gone";
  const recorded = await tx.recurringSettlement.createMany({
    data: [{ transactionId, occurrenceKey, recurringItemId: item.id, kind: item.kind, dueDate }],
    skipDuplicates: true,
  });
  return recorded.count === 1 ? { itemName: item.name } : "match_gone";
}
