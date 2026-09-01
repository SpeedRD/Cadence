"use server";

import { z } from "zod";

import { getSettings, requireAuth } from "@/lib/auth";
import { CURRENCIES } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
import { isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

const MAX_ROWS = 2000;

const importPayloadSchema = z.object({
  accountId: z.string().trim().min(1, "Pick an account for these rows"),
  currency: z.enum(CURRENCIES),
  rows: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Row has an invalid date"),
        amount: z.number().positive("Row amount must be greater than 0"),
        type: z.enum(["EXPENSE", "INCOME"]),
        note: z.string().max(500).nullable(),
        categoryId: z.string().nullable(),
      }),
    )
    .min(1, "Nothing to import")
    .max(MAX_ROWS, `Import at most ${MAX_ROWS} rows at a time`),
});

/**
 * Bulk-insert reviewed CSV rows. Rows arrive already parsed and previewed by the
 * import UI; everything is re-validated here before it reaches the database.
 */
export async function importTransactionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail("Could not read the parsed rows");
  }

  const parsed = importPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const account = await prisma.account.findUnique({
    where: { id: parsed.data.accountId },
    select: { id: true },
  });
  if (!account) return fail("That account no longer exists");

  const categoryIds = [
    ...new Set(
      parsed.data.rows
        .map((row) => row.categoryId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const categories = categoryIds.length
    ? await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true },
      })
    : [];
  const knownCategories = new Set(categories.map((category) => category.id));

  const data = parsed.data.rows.map((row) => ({
    date: fromISODate(row.date) as Date,
    amount: row.amount,
    currency: parsed.data.currency,
    type: row.type,
    accountId: account.id,
    categoryId:
      row.categoryId && knownCategories.has(row.categoryId) ? row.categoryId : null,
    note: row.note,
    source: "CSV" as const,
  }));

  if (data.some((row) => !row.date)) return fail("A row has an invalid date");

  const result = await prisma.transaction.createMany({ data });

  revalidateApp();
  return done(
    `Imported ${result.count} transaction${result.count === 1 ? "" : "s"}`,
  );
}
