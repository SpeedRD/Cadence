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
 */
import { createHash } from "node:crypto";

import { addDays, maxDate, minDate, toISODate } from "@/lib/date";
import { num, type DecimalLike } from "@/lib/money";
import { fundedPeriodFor, periodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import {
  itemIdFromOccurrenceKey,
  paycheckWindow,
  planPostedDuplicates,
  settlementWindow,
  type IncomingEntry,
  type MatchableItem,
  type PostedEntry,
} from "@/lib/recurring-settlement";

import type { Prisma } from "@/generated/prisma/client";
import type { RateTable } from "@/lib/currency";

/**
 * How far either side of the incoming rows' dates a posted row is looked for.
 * A window reaches at most a pay period plus SETTLEMENT_LEAD_DAYS around its
 * row's date, and a paycheck's row sits within a few days of its planned
 * period, so this only bounds the read.
 */
const LOOKUP_MARGIN_DAYS = 40;

/** One posted row as the entry points show it. */
export interface PostedMatchRow {
  id: string;
  kind: "recurring" | "paycheck";
  /** The recurring item's name (the row's note once the item is gone), or the paycheck's note. */
  label: string | null;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  currency: string;
}

export interface PostedMatch {
  kind: "recurring" | "paycheck";
  /** Only after converting between currencies, or the row neither names the item nor lands within PROXIMITY_DAYS of it: a warning, never resolved unless the user says so. */
  possible: boolean;
  /** Several items survive the look-alike guard; `others` lists the rest. */
  ambiguous: boolean;
  /** The row "It's the posted charge" (or "the paycheck already recorded") pairs with. */
  posted: PostedMatchRow;
  others: PostedMatchRow[];
  /**
   * What choosing the posted charge writes on `posted`: the incoming amount and
   * currency in place of its own, nothing else. Null when they already agree,
   * and always for a paycheck (a check-in owns it), a contribution's ledger
   * half (its GoalContribution must stay in step) and an ambiguous match
   * (which row is meant is not known).
   */
  rewrite: { amount: number; currency: string } | null;
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

  const rows = await client.transaction.findMany({
    where: {
      accountId: { in: accountIds },
      date: { gte: addDays(earliest, -LOOKUP_MARGIN_DAYS), lte: addDays(latest, LOOKUP_MARGIN_DAYS) },
      OR: [
        { source: "RECURRING", type: "EXPENSE" },
        { source: "PAYDAY_CHECKIN", type: "INCOME" },
      ],
    },
    select: { id: true, date: true, amount: true, currency: true, type: true, accountId: true, source: true, externalId: true, note: true },
  });
  if (rows.length === 0) return result;

  const recurringKeys = rows
    .filter((row) => row.source === "RECURRING" && row.externalId)
    .map((row) => row.externalId as string);
  const itemIds = [...new Set(recurringKeys.map(itemIdFromOccurrenceKey).filter((id): id is string => id !== null))];
  const paycheckIds = rows.filter((row) => row.source === "PAYDAY_CHECKIN").map((row) => row.id);

  const [postedItems, activeItems, contributionKeys, snapshots] = await Promise.all([
    itemIds.length
      ? client.recurringItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, amount: true, currency: true, categoryId: true },
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
  ]);

  const toMatchable = (item: { id: string; name: string; amount: DecimalLike; currency: string; categoryId: string | null }): MatchableItem => ({
    ...item,
    amount: num(item.amount),
  });
  const itemById = new Map(postedItems.map((item) => [item.id, toMatchable(item)]));
  const contributionHalves = new Set(contributionKeys.map((row) => row.recurringExternalId as string));
  const plannedByPaycheck = new Map(
    snapshots.map((snapshot) => [snapshot.incomeTransactionId as string, periodInfo(snapshot.checkin)]),
  );

  const posted: PostedEntry[] = [];
  const viewById = new Map<string, PostedMatchRow>();
  const rewritable = new Set<string>();
  for (const row of rows) {
    const kind = row.source === "RECURRING" ? "recurring" : "paycheck";
    const item = kind === "recurring" && row.externalId ? (itemById.get(itemIdFromOccurrenceKey(row.externalId) ?? "") ?? null) : null;
    const planned = plannedByPaycheck.get(row.id);
    posted.push({
      id: row.id,
      kind,
      accountId: row.accountId,
      type: row.type as "EXPENSE" | "INCOME",
      date: row.date,
      amount: num(row.amount),
      currency: row.currency,
      // A paycheck whose snapshot is gone falls back to the funding window of
      // the period its own day funds.
      window:
        kind === "paycheck" ? paycheckWindow(planned ?? fundedPeriodFor(row.date)) : settlementWindow(row.date),
      item,
    });
    viewById.set(row.id, {
      id: row.id,
      kind,
      label: item?.name ?? row.note,
      date: toISODate(row.date),
      amount: num(row.amount),
      currency: row.currency,
    });
    if (kind === "recurring" && !(row.externalId && contributionHalves.has(row.externalId))) rewritable.add(row.id);
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
    const differs = primary.currency !== entry.currency || Math.round(primary.amount * 100) !== Math.round(entry.amount * 100);
    result.set(key, {
      kind: primary.kind,
      possible: verdict.possible,
      ambiguous: verdict.ambiguous,
      posted: primary,
      others: verdict.candidateIds.slice(1).map((id) => viewById.get(id) as PostedMatchRow),
      rewrite:
        differs && !verdict.ambiguous && rewritable.has(primary.id)
          ? { amount: entry.amount, currency: entry.currency }
          : null,
    });
  }
  return result;
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
  options: { lookup?: PostedLookup; timeoutMs?: number } = {},
): Promise<Map<string, PostedMatch> | null> {
  const lookup = options.lookup ?? findPostedDuplicates;
  const timeoutMs = options.timeoutMs ?? POSTED_LOOKUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(incoming, rates),
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
 * moved. No other field changes, a paycheck is never touched, and nothing is
 * deleted. Returns whether the posted row changed.
 */
export async function applyPostedMatch(client: Client, match: PostedMatch): Promise<boolean> {
  if (!match.rewrite) return false;
  const updated = await client.transaction.updateMany({
    where: { id: match.posted.id, source: "RECURRING" },
    data: { amount: match.rewrite.amount, currency: match.rewrite.currency },
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
