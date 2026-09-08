import {
  csvFingerprint,
  fingerprintFromCsvExternalId,
} from "@/lib/csv-fingerprint";
import { toISODate } from "@/lib/date";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

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
