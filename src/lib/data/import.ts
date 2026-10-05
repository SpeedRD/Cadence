/**
 * The CSV importer's write: reviewed rows into the ledger, in one database
 * transaction. Plain function (no requireAuth()/cookies()) so
 * scripts/verify-domain.ts can drive the export -> import round trip the
 * same way importTransactionsAction does; the action parses, checks the
 * session and turns each outcome into a toast.
 */
import { Prisma } from "@/generated/prisma/client";
import { inAccountCurrency, refuseZeroAmount, shareInAccountCurrency } from "@/lib/account-money";
import { resolveImportCategoryId } from "@/lib/categorization";
import { csvExternalId } from "@/lib/csv-fingerprint";
import { fromISODate, toISODate } from "@/lib/date";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import {
  parseReimbursedExpenseReference,
  type ReimbursedExpenseReference,
} from "@/lib/shared-expense";

import { findCsvDuplicates, findCsvPostedDuplicates } from "@/lib/data/import-duplicates";
import { applyPostedMatch, recordUpcomingPayment, type PostedLookup } from "@/lib/data/posted-duplicates";

import type { RateTable } from "@/lib/currency";

export interface CsvImportRow {
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  type: "EXPENSE" | "INCOME" | "EXTERNAL_TRANSFER";
  transferDirection: "OUT" | "IN" | null;
  note: string | null;
  categoryId: string | null;
  /** The user reviewed this row as a possible duplicate and chose to import it anyway ("It's a different charge", for a posted match). */
  importAnyway: boolean;
  /**
   * The user said this row is the posted charge (or the paycheck already
   * recorded) it matches - see findCsvPostedDuplicates. Nothing is written for
   * it; the posted row takes its amount and currency where they differ.
   */
  postedCharge?: boolean;
  /**
   * "It's that payment": the occurrence key of an upcoming payment in
   * another currency this row matched (findCsvPostedDuplicates, kind
   * "upcoming"). The row is imported as usual and recorded as having paid
   * that occurrence (recordUpcomingPayment), so posting never charges it.
   */
  settlesOccurrence?: string | null;
  /** The user's own verdict - the review step's, or the file's One-off column. */
  isExtraordinary: boolean;
  /** INCOME only: the file's One-off income column says yes (Transaction.isOneOffIncome). */
  isOneOffIncome?: boolean;
  /** EXPENSE only: the user's own part of the amount, from the file's Your share column (src/lib/shared-expense.ts). */
  yourShare: number | null;
  /**
   * INCOME only: the file's Reimburses cell, naming the shared expense this
   * deposit pays back (parseReimbursedExpenseReference). Resolved here
   * against the batch and the ledger; a reference that names no single
   * expense leaves the row ordinary income and is counted in the result.
   */
  reimburses: string | null;
}

export interface CsvImportInput {
  accountId: string;
  currency: string;
  rows: CsvImportRow[];
}

export type CsvImportResult =
  | {
      ok: true;
      count: number;
      unresolvedReimbursements: number;
      /** Rows taken as the posted charge or recorded paycheck they matched, so not written. */
      matchedPosted: number;
      /** Of those, how many changed the posted row's amount or currency. */
      updatedPosted: number;
      /** Rows imported as an upcoming payment ("It's that payment"), which posting will not charge again; absent when none. */
      settledUpcoming?: number;
    }
  | { ok: false; reason: "account_missing" | "account_not_active" | "invalid_date" | "collision" | "posted_match_changed" }
  | { ok: false; reason: "duplicates_need_review"; count: number };

/** Thrown inside the import's transaction to roll it back when an "It's that payment" answer no longer holds. */
class UpcomingPaymentGone extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Bulk-insert reviewed CSV rows. Everything is re-validated against the
 * ledger here, including the duplicate check: a row that matches a CSV row
 * already in the ledger is refused unless the caller says the user reviewed
 * it and chose to import it anyway. Every row written carries its
 * fingerprint as externalId, so the next overlapping import finds it.
 *
 * The same holds for a row matching a row the app wrote itself - an
 * occurrence recurring posting charged, or a paycheck a check-in recorded
 * (findCsvPostedDuplicates, with the same rates the review step used): it
 * needs the user's answer, "a different charge" (importAnyway) or "the posted
 * charge" (postedCharge), except for a possible match (planPostedDuplicates),
 * which is only a warning and imports unless the user says otherwise. A row
 * matching an upcoming payment in another currency (always possible) imports
 * either way; "It's that payment" (settlesOccurrence) also records it as
 * having paid that occurrence, in the same database transaction. A posted-charge
 * row is not written; the posted row takes its amount and currency, in the
 * same database transaction as the rest. A posted-charge answer the ledger no
 * longer supports refuses the whole import rather than guessing. The posted
 * check fails open: when it throws or times out, nothing is refused for it, a
 * row the user already called the posted charge is still left out (their
 * answer stands), and no posted row is changed.
 *
 * A deposit whose Reimburses cell names a shared expense is linked to it
 * after the rows land. The expense is looked for by the cell's own contents
 * (date, description, amount and currency) first among this batch's own
 * expenses - a reference exported beside its expense names that copy, even
 * when the original is still in another account - and, only when the batch
 * has none, among the ledger's shared expenses. Either place must name
 * exactly one; none, or more than one, is an unresolved reference: the
 * deposit stays ordinary income rather than being linked to a guess, and
 * the count comes back so the importer can say so.
 */
export async function importCsvTransactions(
  input: CsvImportInput,
  rates: RateTable,
  options: { lookup?: PostedLookup; timeoutMs?: number } = {},
): Promise<CsvImportResult> {
  const account = await prisma.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, status: true, currency: true },
  });
  if (!account) return { ok: false, reason: "account_missing" };
  if (account.status !== "ACTIVE") return { ok: false, reason: "account_not_active" };

  const report = await findCsvDuplicates({
    accountId: account.id,
    currency: input.currency,
    rows: input.rows.map((row) => ({ date: row.date, amount: row.amount, note: row.note })),
  });
  const posted = await findCsvPostedDuplicates({
    accountId: account.id,
    currency: input.currency,
    rows: input.rows,
    skip: new Set(report.matches.keys()),
    rates,
    ...options,
  });
  if (posted && input.rows.some((row, index) => row.postedCharge && !posted.has(index))) {
    return { ok: false, reason: "posted_match_changed" };
  }
  // "It's that payment" must still name the upcoming payment the row matches;
  // with the check failed open the answer stands, and the write below checks
  // the occurrence is still ahead of posting.
  const settles = input.rows.flatMap((row, index) => (row.settlesOccurrence ? [{ index, key: row.settlesOccurrence }] : []));
  if (
    settles.some(({ index, key }) => {
      const row = input.rows[index];
      if (row.type !== "EXPENSE" || row.postedCharge) return true;
      if (!posted) return false;
      const match = posted.get(index);
      return !match || match.kind !== "upcoming" || match.posted.id !== key;
    })
  ) {
    return { ok: false, reason: "posted_match_changed" };
  }
  const unreviewed = input.rows.filter((row, index) => {
    if (row.importAnyway || row.postedCharge) return false;
    if (report.matches.has(index)) return true;
    const match = posted?.get(index);
    return match !== undefined && !match.possible;
  });
  if (unreviewed.length > 0) return { ok: false, reason: "duplicates_need_review", count: unreviewed.length };
  const postedMatches = input.rows.flatMap((row, index) => {
    const match = posted?.get(index);
    return row.postedCharge && match ? [match] : [];
  });
  const keptAsPosted = input.rows.filter((row) => row.postedCharge).length;

  const categories = await prisma.category.findMany({ select: { id: true, name: true } });
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const categoryIdByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category.id]),
  );

  // The ordinal continues after the rows already stored with the same
  // fingerprint, and after earlier rows in this batch that share it, so two
  // identical lines in one statement (or a deliberate re-import) each get
  // their own externalId under the (source, externalId) unique index.
  const ordinalByFingerprint = new Map(report.existingCountByFingerprint);
  const data = input.rows.flatMap((row, index) => {
    if (row.postedCharge) return [];
    const fingerprint = report.fingerprints[index];
    const ordinal = (ordinalByFingerprint.get(fingerprint) ?? 0) + 1;
    ordinalByFingerprint.set(fingerprint, ordinal);
    // Stored in the account's currency (K7): a file in another currency is
    // converted once, at the rate the review step used, and each row keeps
    // the file's own figure. The fingerprint stays the file's figure, so the
    // same statement imported again is still recognised.
    // A row that comes to 0.00 in the account's currency refuses the whole
    // import (RoundsToZeroError, R29/S19), as it would refuse a manual entry.
    const entered = { amount: row.amount, currency: input.currency };
    const stored = refuseZeroAmount(entered, inAccountCurrency(entered, account.currency, rates));
    return [{
      rowIndex: index,
      date: fromISODate(row.date) as Date,
      ...stored,
      type: row.type,
      transferDirection: row.transferDirection,
      accountId: account.id,
      categoryId:
        row.type === "EXTERNAL_TRANSFER"
          ? null
          : resolveImportCategoryId({
              explicitCategoryId: row.categoryId,
              note: row.note,
              type: row.type,
              knownCategoryIds,
              categoryIdByName,
            }),
      note: row.note,
      source: "CSV" as const,
      externalId: csvExternalId(fingerprint, ordinal),
      // Only the user's own verdict ever sets this, and only on spending:
      // the flag means nothing on income or a transfer.
      isExtraordinary: row.type === "EXPENSE" && row.isExtraordinary,
      // The one-off income flag is income's own, on the same terms. A row that
      // also names a shared expense it pays back is left ordinary here, as
      // the dialog does (canBeOneOffIncome): the link already excludes it.
      isOneOffIncome: row.type === "INCOME" && row.isOneOffIncome === true && row.reimburses === null,
      // A share belongs to an expense only, on the same terms, converted with its amount.
      yourShare: row.type === "EXPENSE" ? shareInAccountCurrency(row.yourShare, stored) : null,
    }];
  });
  const dataIndexByRow = new Map(data.map((row, dataIndex) => [row.rowIndex, dataIndex]));

  if (data.some((row) => !row.date)) return { ok: false, reason: "invalid_date" };

  // Each deposit's reference, parsed once; the batch's own shared expenses
  // are the first place it may point at.
  const references: { index: number; reference: ReimbursedExpenseReference | null }[] =
    input.rows.flatMap((row, index) => {
      const dataIndex = dataIndexByRow.get(index);
      if (dataIndex === undefined || row.type !== "INCOME" || row.reimburses === null) return [];
      return [{ index: dataIndex, reference: parseReimbursedExpenseReference(row.reimburses) }];
    });
  // A reference names an expense by the figure it was written with: the
  // file's own, or - exported from Cadence - the stored one. Both are keys.
  const batchSharedByKey = new Map<string, string[]>();
  data.forEach((row) => {
    if (row.type !== "EXPENSE" || row.yourShare === null) return;
    const date = input.rows[row.rowIndex].date;
    const keys = new Set([
      referenceKey(date, row.note, row.amount, row.currency),
      referenceKey(date, row.note, input.rows[row.rowIndex].amount, input.currency),
    ]);
    for (const key of keys) batchSharedByKey.set(key, [...(batchSharedByKey.get(key) ?? []), row.externalId]);
  });

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      let updatedPosted = 0;
      for (const match of postedMatches) {
        if (await applyPostedMatch(tx, match)) updatedPosted += 1;
      }
      const count = (await tx.transaction.createMany({ data: data.map(({ rowIndex: _rowIndex, ...row }) => row) })).count;
      if (settles.length > 0) {
        const externalIdByRow = new Map(data.map((row) => [row.rowIndex, row.externalId]));
        const written = await tx.transaction.findMany({
          where: { source: "CSV", externalId: { in: settles.map(({ index }) => externalIdByRow.get(index) as string) } },
          select: { id: true, externalId: true },
        });
        const idByExternalId = new Map(written.map((row) => [row.externalId as string, row.id]));
        for (const { index, key } of settles) {
          const id = idByExternalId.get(externalIdByRow.get(index) as string);
          // A payment posted or settled since the review: the whole import
          // is refused rather than half-recorded.
          if (!id || (await recordUpcomingPayment(tx, id, key)) === "match_gone") throw new UpcomingPaymentGone();
        }
      }
      if (references.length === 0) return { count, unresolved: 0, updatedPosted };

      const parsed = references.filter(
        (item): item is { index: number; reference: ReimbursedExpenseReference } =>
          item.reference !== null,
      );
      const inLedger = parsed.length
        ? await tx.transaction.findMany({
            where: {
              type: "EXPENSE",
              yourShare: { not: null },
              OR: parsed.flatMap(({ reference }) => [
                {
                  date: fromISODate(reference.date) as Date,
                  note: reference.note,
                  amount: reference.amount,
                  currency: reference.currency,
                },
                {
                  date: fromISODate(reference.date) as Date,
                  note: reference.note,
                  originalAmount: reference.amount,
                  originalCurrency: reference.currency,
                },
              ]),
            },
            select: {
              id: true,
              date: true,
              note: true,
              amount: true,
              currency: true,
              originalAmount: true,
              originalCurrency: true,
              externalId: true,
              source: true,
            },
          })
        : [];
      const batchExternalIds = new Set(data.map((row) => row.externalId));
      const ledgerByKey = new Map<string, string[]>();
      for (const expense of inLedger) {
        // The batch's own rows are in the ledger now too; they are counted
        // once, as batch rows, not again here.
        if (expense.source === "CSV" && expense.externalId && batchExternalIds.has(expense.externalId)) continue;
        const keys = new Set([referenceKey(toISODate(expense.date), expense.note, num(expense.amount), expense.currency)]);
        if (expense.originalCurrency !== null && expense.originalAmount !== null) {
          keys.add(referenceKey(toISODate(expense.date), expense.note, num(expense.originalAmount), expense.originalCurrency));
        }
        for (const key of keys) ledgerByKey.set(key, [...(ledgerByKey.get(key) ?? []), expense.id]);
      }
      const batchIdByExternalId = new Map(
        (
          await tx.transaction.findMany({
            where: { source: "CSV", externalId: { in: [...batchExternalIds] } },
            select: { id: true, externalId: true },
          })
        ).map((row) => [row.externalId as string, row.id]),
      );

      let unresolved = references.length - parsed.length;
      for (const { index, reference } of parsed) {
        const key = referenceKey(reference.date, reference.note, reference.amount, reference.currency);
        const inBatch = (batchSharedByKey.get(key) ?? [])
          .map((externalId) => batchIdByExternalId.get(externalId))
          .filter((id): id is string => Boolean(id));
        const candidates = inBatch.length > 0 ? inBatch : (ledgerByKey.get(key) ?? []);
        if (candidates.length !== 1) {
          unresolved += 1;
          continue;
        }
        await tx.transaction.update({
          where: { id: batchIdByExternalId.get(data[index].externalId) as string },
          data: { reimbursesTransactionId: candidates[0] },
        });
      }
      return { count, unresolved, updatedPosted };
    });
    return {
      ok: true,
      count: outcome.count,
      unresolvedReimbursements: outcome.unresolved,
      matchedPosted: keptAsPosted,
      updatedPosted: outcome.updatedPosted,
      ...(settles.length > 0 ? { settledUpcoming: settles.length } : {}),
    };
  } catch (error) {
    // Only another import of the same rows landing in between can collide;
    // the user re-runs the check rather than getting half a statement.
    if (isUniqueViolation(error)) return { ok: false, reason: "collision" };
    if (error instanceof UpcomingPaymentGone) return { ok: false, reason: "posted_match_changed" };
    throw error;
  }
}

/** The identity a Reimburses cell carries, as one comparable string. */
function referenceKey(date: string, note: string | null, amount: number, currency: string): string {
  return [date, note ?? "", amount.toFixed(2), currency].join("\u0000");
}
