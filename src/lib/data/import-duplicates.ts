import { resolveImportCategoryId } from "@/lib/categorization";
import {
  csvFingerprint,
  fingerprintFromCsvExternalId,
} from "@/lib/csv-fingerprint";
import { fromISODate, toISODate } from "@/lib/date";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import { lookUpPostedDuplicates, type PostedLookup, type PostedMatch } from "@/lib/data/posted-duplicates";

import type { RateTable } from "@/lib/currency";

export interface CsvCandidateRow {
  /** "YYYY-MM-DD" */
  date: string;
  amount: number;
  note: string | null;
}

export interface ExistingCsvMatch {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  note: string | null;
}

export interface CsvDuplicateReport {
  /** Fingerprint of each candidate row, by row index. */
  fingerprints: string[];
  /** Row index -> the CSV rows already in the ledger with the same fingerprint. */
  matches: Map<number, ExistingCsvMatch[]>;
  /** How many stored CSV rows already carry each fingerprint - the next ordinal starts after these. */
  existingCountByFingerprint: Map<string, number>;
}

/**
 * Which candidate rows are already in the ledger as CSV imports. Only rows
 * on the same account inside the batch's date span can match (the
 * fingerprint includes both), so that is all that is read. Stored rows from
 * before fingerprints existed have no externalId; theirs is recomputed from
 * the same fields, so an old import is recognised too.
 */
export async function findCsvDuplicates(input: {
  accountId: string;
  currency: string;
  rows: CsvCandidateRow[];
}): Promise<CsvDuplicateReport> {
  const fingerprints = input.rows.map((row) =>
    csvFingerprint({
      accountId: input.accountId,
      date: row.date,
      amount: row.amount,
      currency: input.currency,
      note: row.note,
    }),
  );
  const matches = new Map<number, ExistingCsvMatch[]>();
  const existingCountByFingerprint = new Map<string, number>();
  if (input.rows.length === 0) return { fingerprints, matches, existingCountByFingerprint };

  const dates = input.rows.map((row) => row.date).sort();
  const existing = await prisma.transaction.findMany({
    where: {
      source: "CSV",
      accountId: input.accountId,
      date: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T00:00:00Z`) },
    },
    select: { id: true, date: true, amount: true, currency: true, note: true, externalId: true },
  });

  const existingByFingerprint = new Map<string, ExistingCsvMatch[]>();
  for (const row of existing) {
    const fingerprint =
      fingerprintFromCsvExternalId(row.externalId) ??
      csvFingerprint({
        accountId: input.accountId,
        date: toISODate(row.date),
        amount: num(row.amount),
        currency: row.currency,
        note: row.note,
      });
    const list = existingByFingerprint.get(fingerprint) ?? [];
    list.push({ id: row.id, date: row.date, amount: num(row.amount), currency: row.currency, note: row.note });
    existingByFingerprint.set(fingerprint, list);
  }
  for (const [fingerprint, list] of existingByFingerprint) {
    existingCountByFingerprint.set(fingerprint, list.length);
  }
  fingerprints.forEach((fingerprint, index) => {
    const list = existingByFingerprint.get(fingerprint);
    if (list && list.length > 0) matches.set(index, list);
  });
  return { fingerprints, matches, existingCountByFingerprint };
}

export interface CsvPostedCandidateRow extends CsvCandidateRow {
  type: "EXPENSE" | "INCOME" | "EXTERNAL_TRANSFER";
  /** The row's category as the importer sends it (an id, EXPLICIT_NO_CATEGORY, or null); resolved here exactly as the import resolves it. */
  categoryId: string | null;
}

/**
 * Which candidate rows are money the ledger already holds as a row the app
 * wrote itself: an occurrence recurring posting charged (a spending row), or
 * a paycheck a check-in recorded (a deposit) - see findPostedDuplicates. The
 * batch is the file: a posted row pairs with at most one row of it. Rows in
 * `skip` (already flagged as CSV re-imports) and external transfers are not
 * judged. Each row's category is the one it will land in, since the
 * look-alike guard reads it. Fails open (lookUpPostedDuplicates): null when
 * the lookup threw or timed out, and the caller imports as if nothing matched.
 */
export async function findCsvPostedDuplicates(input: {
  accountId: string;
  currency: string;
  rows: CsvPostedCandidateRow[];
  skip: ReadonlySet<number>;
  rates: RateTable;
  lookup?: PostedLookup;
  timeoutMs?: number;
}): Promise<Map<number, PostedMatch> | null> {
  const categories = await prisma.category.findMany({ select: { id: true, name: true } });
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const categoryIdByName = new Map(categories.map((category) => [category.name.toLowerCase(), category.id]));

  const incoming = input.rows.flatMap((row, index) => {
    if (input.skip.has(index) || row.type === "EXTERNAL_TRANSFER") return [];
    const date = fromISODate(row.date);
    if (!date) return [];
    return [
      {
        key: String(index),
        accountId: input.accountId,
        type: row.type,
        date,
        amount: row.amount,
        currency: input.currency,
        note: row.note,
        categoryId: resolveImportCategoryId({
          explicitCategoryId: row.categoryId,
          note: row.note,
          type: row.type,
          knownCategoryIds,
          categoryIdByName,
        }),
      },
    ];
  });
  const found = await lookUpPostedDuplicates(incoming, input.rates, { lookup: input.lookup, timeoutMs: input.timeoutMs });
  return found && new Map([...found].map(([key, match]) => [Number(key), match]));
}
