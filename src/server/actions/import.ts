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
import { findCsvDuplicates } from "@/lib/data/import-duplicates";
import { findRecurringSuggestions } from "@/lib/data/recurring-suggestions";

import { done, fail, revalidateApp, type ActionState } from "./utils";

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
          /** The user reviewed this row as a possible duplicate and chose to import it anyway. */
          importAnyway: z.boolean().optional().default(false),
          /** The user reviewed this row as unusually large and marked it a one-off (see src/lib/extraordinary.ts), or the file's One-off column says so. */
          isExtraordinary: z.boolean().optional().default(false),
          /** The file's Your share column, for an EXPENSE (see src/lib/shared-expense.ts). */
          yourShare: z.number().positive("Enter an amount greater than 0").nullable().optional().default(null),
          /** The file's Reimburses column, for an INCOME row: the shared expense it pays back, by reference. */
          reimburses: z.string().max(700).nullable().optional().default(null),
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
      }),
    )
    .max(MAX_ROWS),
});

export interface CsvDuplicateHit {
  /** Index into the rows the client sent. */
  index: number;
  /** The stored row it matches: "YYYY-MM-DD", amount, note. */
  existingDate: string;
  existingAmount: number;
  existingNote: string | null;
}

export type CsvDuplicateCheckResult =
  | { ok: true; duplicates: CsvDuplicateHit[] }
  | { ok: false; error: string };

/**
 * Which of the parsed rows are already in the ledger as CSV imports on this
 * account, so the review step can show them as their own group before
 * anything is written. Same fingerprint the import itself uses.
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
      existingDate: toISODate(first.date),
      existingAmount: first.amount,
      existingNote: first.note,
    });
  }
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

  const result = await importCsvTransactions(parsed.data);
  if (!result.ok) {
    if (result.reason === "account_missing") return fail(t.accountNoLongerExists);
    if (result.reason === "duplicates_need_review") return fail(t.duplicatesNeedReview(result.count));
    if (result.reason === "invalid_date") return fail(t.invalidDateRow);
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
  const message = result.unresolvedReimbursements
    ? `${t.imported(result.count)} · ${t.reimbursementsUnresolved(result.unresolvedReimbursements)}`
    : t.imported(result.count);
  return done(message, { recurringSuggestions });
}
