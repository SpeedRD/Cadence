"use server";

import { z } from "zod";

import { getSettings, requireAuth } from "@/lib/auth";
import { resolveImportCategoryId } from "@/lib/categorization";
import { CURRENCIES } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { ownShare, yourShareIssue } from "@/lib/shared-expense";
import { firstError } from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import { findExtraordinaryCandidates, type ExtraordinaryCandidate } from "@/lib/data/extraordinary";
import { importCsvTransactions } from "@/lib/data/import";
import { findCsvDuplicates, findCsvPostedDuplicates } from "@/lib/data/import-duplicates";
import { findRecurringSuggestions } from "@/lib/data/recurring-suggestions";

import type { PostedMatch } from "@/lib/data/posted-duplicates";

import { done, fail, refusedWriteMessage, revalidateApp, type ActionState } from "./utils";

const MAX_ROWS = 2000;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Row has an invalid date");

const importPayloadSchema = z.object({
  accountId: z.string().trim().min(1, "Pick an account for these rows"),
  currency: z.enum(CURRENCIES),
  rows: z
    .array(
      z
        .object({
          date: isoDay,
          amount: z.number().positive("Row amount must be greater than 0"),
          type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
          transferDirection: z.enum(["OUT", "IN"]).nullable(),
          note: z.string().max(500).nullable(),
          categoryId: z.string().nullable(),
          /** The user reviewed this row as a possible duplicate and chose to import it anyway ("It's a different charge", for a posted match). */
          importAnyway: z.boolean().optional().default(false),
          /** The user said this row is the posted charge or recorded paycheck it matches (see findCsvPostedDuplicates): it is not written. */
          postedCharge: z.boolean().optional().default(false),
          /** "It's that payment": the upcoming payment's occurrence key this row paid (see importCsvTransactions). */
          settlesOccurrence: z.string().max(200).nullable().optional().default(null),
          /** The user reviewed this row as unusually large and marked it a one-off (see src/lib/extraordinary.ts), or the file's One-off column says so. */
          isExtraordinary: z.boolean().optional().default(false),
          /** The file's One-off income column, for an INCOME row (see Transaction.isOneOffIncome). */
          isOneOffIncome: z.boolean().optional().default(false),
          /** The file's Your share column, for an EXPENSE (see src/lib/shared-expense.ts). */
          yourShare: z.number().positive("Enter an amount greater than 0").nullable().optional().default(null),
          /** The file's Reimburses column, for an INCOME row: the shared expense it pays back, by reference. */
          reimburses: z.string().max(700).nullable().optional().default(null),
        })
        .refine((row) => !(row.settlesOccurrence && (row.postedCharge || row.type !== "EXPENSE")), {
          message: "Only a spending row that is imported can be that payment",
          path: ["settlesOccurrence"],
        })
        .refine((row) => !(row.importAnyway && row.postedCharge), {
          message: "A row is either the posted charge or a different one",
          path: ["postedCharge"],
        })
        .refine((row) => (row.type === "EXTERNAL_TRANSFER") === (row.transferDirection !== null), {
          message: "External transfer rows need a direction",
          path: ["transferDirection"],
        })
        .refine(
          (row) =>
            row.type !== "EXPENSE" || row.yourShare === null || yourShareIssue(row.amount, row.yourShare) === null,
          { message: "Your share cannot be more than the amount", path: ["yourShare"] },
        ),
    )
    .min(1, "Nothing to import")
    .max(MAX_ROWS, `Import at most ${MAX_ROWS} rows at a time`),
});

const duplicateCheckSchema = z.object({
  accountId: z.string().trim().min(1),
  currency: z.enum(CURRENCIES),
  rows: z
    .array(
      z.object({
        date: isoDay,
        amount: z.number().positive(),
        note: z.string().max(500).nullable(),
        /** The row's type and category as the import will send them, for the posted-row match. */
        type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
        categoryId: z.string().nullable(),
      }),
    )
    .max(MAX_ROWS),
});

export type CsvDuplicateHit =
  | {
      /** Index into the rows the client sent. */
      index: number;
      /** A CSV row already imported into this account. */
      kind: "imported";
      /** The stored row it matches: "YYYY-MM-DD", amount, note. */
      existingDate: string;
      existingAmount: number;
      existingNote: string | null;
    }
  | {
      index: number;
      /** A row the app wrote itself: an occurrence recurring posting charged, or a check-in's paycheck. */
      kind: "posted";
      match: PostedMatch;
    };

export type CsvDuplicateCheckResult =
  | { ok: true; duplicates: CsvDuplicateHit[] }
  | { ok: false; error: string };

/**
 * Which of the parsed rows are already in the ledger as CSV imports on this
 * account, so the review step can show them as their own group before
 * anything is written. Same fingerprint the import itself uses. A row that is
 * not a re-import may still be money the ledger holds as a row the app wrote
 * itself (a posted recurring charge, a recorded paycheck) - the same
 * findCsvPostedDuplicates the import re-runs, with the same rates.
 */
export async function detectCsvDuplicatesAction(payload: unknown): Promise<CsvDuplicateCheckResult> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;

  const parsed = duplicateCheckSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: t.couldNotReadRows };

  const report = await findCsvDuplicates(parsed.data);
  const duplicates: CsvDuplicateHit[] = [];
  for (const [index, existing] of report.matches) {
    const first = existing[0];
    duplicates.push({
      index,
      kind: "imported",
      existingDate: toISODate(first.date),
      existingAmount: first.amount,
      existingNote: first.note,
    });
  }
  const posted = await findCsvPostedDuplicates({
    ...parsed.data,
    skip: new Set(report.matches.keys()),
    rates: (await getAppContext()).rates,
  });
  for (const [index, match] of posted ?? []) duplicates.push({ index, kind: "posted", match });
  duplicates.sort((a, b) => a.index - b.index);
  return { ok: true, duplicates };
}

const extraordinaryCheckSchema = z.object({
  currency: z.enum(CURRENCIES),
  rows: z
    .array(
      z.object({
        /** Index into the rows the client holds, so a hit can be shown on its row. */
        index: z.number().int().nonnegative(),
        amount: z.number().positive(),
        type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
        note: z.string().max(500).nullable(),
        categoryId: z.string().nullable(),
        /** The file's Your share column: a shared row is measured at the share, as the transaction form measures one. */
        yourShare: z.number().positive().nullable().optional().default(null),
      }),
    )
    .max(MAX_ROWS),
});

export interface CsvExtraordinaryHit {
  /** Index into the rows the client sent. */
  index: number;
  categoryName: string;
  /** The category's typical amount, in `medianCurrency` (the display currency). */
  median: number;
  medianCurrency: string;
}

export type CsvExtraordinaryCheckResult =
  | { ok: true; hits: CsvExtraordinaryHit[] }
  | { ok: false; error: string };

/**
 * Which of the rows about to be imported are unusually large for their
 * category, so the review step can show them as their own group before
 * anything is written - the same shape as detectCsvDuplicatesAction. Each
 * row's category is resolved exactly as the import will resolve it
 * (resolveImportCategoryId), so the verdict is against the category the row
 * will actually land in. Only EXPENSE rows with a category can be measured.
 * Nothing is decided here: a hit is a suggestion the user accepts or leaves.
 */
export async function detectCsvExtraordinaryAction(payload: unknown): Promise<CsvExtraordinaryCheckResult> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;

  const parsed = extraordinaryCheckSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: t.couldNotReadRows };

  const categories = await prisma.category.findMany({ select: { id: true, name: true } });
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const categoryIdByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category.id]),
  );

  const candidates: ExtraordinaryCandidate<number>[] = [];
  for (const row of parsed.data.rows) {
    if (row.type !== "EXPENSE") continue;
    const categoryId = resolveImportCategoryId({
      explicitCategoryId: row.categoryId,
      note: row.note,
      type: row.type,
      knownCategoryIds,
      categoryIdByName,
    });
    if (!categoryId) continue;
    candidates.push({
      key: row.index,
      categoryId,
      amount: ownShare({ amount: row.amount, yourShare: row.yourShare }),
      currency: parsed.data.currency,
    });
  }

  const found = await findExtraordinaryCandidates(candidates, await getAppContext());
  const hits: CsvExtraordinaryHit[] = [...found.entries()]
    .map(([index, hit]) => ({
      index,
      categoryName: hit.categoryName,
      median: hit.median,
      medianCurrency: hit.currency,
    }))
    .sort((a, b) => a.index - b.index);
  return { ok: true, hits };
}

/**
 * Bulk-insert reviewed CSV rows. Rows arrive already parsed and previewed by
 * the import UI; everything is re-validated before it reaches the database
 * (importCsvTransactions in src/lib/data/import.ts owns the write and the
 * duplicate check). A Reimburses cell that names no single shared expense
 * leaves its deposit as ordinary income, and the toast says how many did.
 */
export async function importTransactionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).transactions;

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail(t.couldNotReadRows);
  }

  const parsed = importPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  let result;
  try {
    result = await importCsvTransactions(parsed.data, (await getAppContext()).rates);
  } catch (error) {
    // Rows in another currency with no current rate to convert them: nothing
    // was imported (R20).
    const message = refusedWriteMessage(error, locale);
    if (message) return fail(message);
    throw error;
  }
  if (!result.ok) {
    if (result.reason === "account_missing") return fail(t.accountNoLongerExists);
    if (result.reason === "account_not_active") return fail(t.accountNoLongerActive);
    if (result.reason === "duplicates_need_review") return fail(t.duplicatesNeedReview(result.count));
    if (result.reason === "invalid_date") return fail(t.invalidDateRow);
    if (result.reason === "posted_match_changed") return fail(t.postedMatchChanged);
    return fail(t.importCollision);
  }

  // The rows are in, so the import has succeeded whatever happens next. The
  // scan only counts what the Recurring page will show; a failure here is
  // logged and the import reported as it is, not turned into an error.
  let recurringSuggestions = 0;
  try {
    recurringSuggestions = (await findRecurringSuggestions(await getAppContext())).length;
  } catch (error) {
    console.error("[recurring] pattern scan after import failed", error);
  }

  revalidateApp();
  const message = [
    t.imported(result.count),
    result.matchedPosted ? t.postedChargesKept(result.matchedPosted, result.updatedPosted) : null,
    result.settledUpcoming ? t.upcomingPaymentsKept(result.settledUpcoming) : null,
    result.unresolvedReimbursements ? t.reimbursementsUnresolved(result.unresolvedReimbursements) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return done(message, { recurringSuggestions });
}
