"use server";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { getSettings, requireAuth } from "@/lib/auth";
import { resolveImportCategoryId } from "@/lib/categorization";
import { CURRENCIES } from "@/lib/currency";
import { csvExternalId } from "@/lib/csv-fingerprint";
import { fromISODate, toISODate } from "@/lib/date";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError } from "@/lib/validation";

import { findCsvDuplicates } from "@/lib/data/import-duplicates";

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
        })
        .refine((row) => (row.type === "EXTERNAL_TRANSFER") === (row.transferDirection !== null), {
          message: "External transfer rows need a direction",
          path: ["transferDirection"],
        }),
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Bulk-insert reviewed CSV rows. Rows arrive already parsed and previewed by
 * the import UI; everything is re-validated here before it reaches the
 * database, including the duplicate check: a row that matches a CSV row
 * already in the ledger is refused unless the client says the user reviewed
 * it and chose to import it anyway. Every row written carries its
 * fingerprint as externalId, so the next overlapping import finds it.
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

  const account = await prisma.account.findUnique({
    where: { id: parsed.data.accountId },
    select: { id: true },
  });
  if (!account) return fail(t.accountNoLongerExists);

  const report = await findCsvDuplicates({
    accountId: account.id,
    currency: parsed.data.currency,
    rows: parsed.data.rows.map((row) => ({ date: row.date, amount: row.amount, note: row.note })),
  });
  const unreviewed = parsed.data.rows.filter((row, index) => report.matches.has(index) && !row.importAnyway);
  if (unreviewed.length > 0) return fail(t.duplicatesNeedReview(unreviewed.length));

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
  const data = parsed.data.rows.map((row, index) => {
    const fingerprint = report.fingerprints[index];
    const ordinal = (ordinalByFingerprint.get(fingerprint) ?? 0) + 1;
    ordinalByFingerprint.set(fingerprint, ordinal);
    return {
      date: fromISODate(row.date) as Date,
      amount: row.amount,
      currency: parsed.data.currency,
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
    };
  });

  if (data.some((row) => !row.date)) return fail(t.invalidDateRow);

  let count: number;
  try {
    count = (await prisma.transaction.createMany({ data })).count;
  } catch (error) {
    // Only another import of the same rows landing in between can collide;
    // the user re-runs the check rather than getting half a statement.
    if (isUniqueViolation(error)) return fail(t.importCollision);
    throw error;
  }

  revalidateApp();
  return done(t.imported(count));
}
