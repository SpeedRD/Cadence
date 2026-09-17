import { formatCsv } from "@/lib/csv";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { balanceSign } from "@/lib/transactions";
import { createZip } from "@/lib/zip";

/**
 * The Settings "Export all" download: one CSV per data type, zipped. Reads
 * only - nothing here writes to the database.
 *
 * transactions.csv is laid out for the CSV importer (src/components/import/
 * csv-importer.tsx): a header row, then Date / Amount / Description as the
 * first three columns, ISO dates, plain "-12.50" amounts with spending
 * negative - exactly the importer's defaults (header on, YYYY-MM-DD, "signed"
 * convention), so it reads the file with no remapping. Account and Category
 * columns follow so the importer's optional column pickers can restore those
 * too. The other six files have no import path; they are complete, readable
 * backups, so every column the row carries is included and foreign keys are
 * shown by name (with the internal id kept at the end for auditing).
 */

export interface ExportFile {
  name: string;
  text: string;
}

export const EXPORT_FILE_NAMES = [
  "transactions.csv",
  "goals.csv",
  "goal_contributions.csv",
  "recurring_items.csv",
  "budgets.csv",
  "accounts.csv",
  "categories.csv",
] as const;

/** Money as the importer's parseAmount and any spreadsheet read it: "1234.50", no grouping. */
function money(value: { toString(): string }): string {
  return num(value).toFixed(2);
}

function timestamp(value: Date | null): string {
  return value ? value.toISOString() : "";
}

function day(value: Date | null): string {
  return value ? toISODate(value) : "";
}

function text(value: string | null | undefined): string {
  return value ?? "";
}

function optionalNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export async function buildExportFiles(locale: Locale): Promise<ExportFile[]> {
  const t = getDictionary(locale);
  const h = t.dataExport.headers;
  const common = t.common;
  const yesNo = (value: boolean) => (value ? t.dataExport.yes : t.dataExport.no);
  const label = (map: Record<string, string>, key: string | null) =>
    key === null ? "" : (map[key] ?? key);

  const [transactions, goals, contributions, recurringItems, budgets, accounts, categories] =
    await Promise.all([
      prisma.transaction.findMany({
        include: { account: { select: { name: true } }, category: { select: { name: true } } },
        orderBy: [{ account: { name: "asc" } }, { date: "asc" }, { createdAt: "asc" }],
      }),
      prisma.goal.findMany({ orderBy: [{ createdAt: "asc" }] }),
      prisma.goalContribution.findMany({
        include: {
          goal: { select: { name: true } },
          account: { select: { name: true } },
          recurringItem: { select: { name: true } },
        },
        orderBy: [{ goal: { name: "asc" } }, { date: "asc" }, { createdAt: "asc" }],
      }),
      prisma.recurringItem.findMany({
        include: {
          category: { select: { name: true } },
          account: { select: { name: true } },
          goal: { select: { name: true } },
        },
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      }),
      prisma.budget.findMany({
        include: { category: { select: { name: true } } },
        orderBy: [{ year: "asc" }, { month: "asc" }, { period: "asc" }, { createdAt: "asc" }],
      }),
      prisma.account.findMany({ orderBy: [{ name: "asc" }] }),
      prisma.category.findMany({ orderBy: [{ name: "asc" }] }),
    ]);

  const transactionRows = [
    [
      h.date,
      h.amount,
      h.description,
      h.account,
      h.currency,
      h.category,
      h.type,
      h.source,
      h.transferDirection,
      h.transferGroup,
      h.externalId,
      h.createdAt,
      h.id,
    ],
    ...transactions.map((row) => [
      day(row.date),
      // Signed the way the importer's "signed" convention reads it: money
      // leaving the account negative, money arriving positive - the same sign
      // the ledger balance applies (balanceSign).
      (balanceSign(row.type, row.transferDirection) * num(row.amount)).toFixed(2),
      text(row.note),
      row.account.name,
      row.currency,
      text(row.category?.name),
      label(common.transactionTypeLabels, row.type),
      label(common.sourceLabels, row.source),
      label(t.dataExport.transferDirectionLabels, row.transferDirection),
      text(row.transferId),
      text(row.externalId),
      timestamp(row.createdAt),
      row.id,
    ]),
  ];

  const goalRows = [
    [h.name, h.targetAmount, h.savedAmount, h.currency, h.targetDate, h.achievedAt, h.createdAt, h.id],
    ...goals.map((row) => [
      row.name,
      money(row.targetAmount),
      money(row.savedAmount),
      row.currency,
      day(row.targetDate),
      timestamp(row.achievedAt),
      timestamp(row.createdAt),
      row.id,
    ]),
  ];

  const contributionRows = [
    [
      h.goal,
      h.date,
      h.amount,
      h.currency,
      h.account,
      h.note,
      h.recurringItem,
      h.recurringExternalId,
      h.createdAt,
      h.id,
    ],
    ...contributions.map((row) => [
      row.goal.name,
      day(row.date),
      money(row.amount),
      row.currency,
      text(row.account?.name),
      text(row.note),
      text(row.recurringItem?.name),
      text(row.recurringExternalId),
      timestamp(row.createdAt),
      row.id,
    ]),
  ];

  const recurringRows = [
    [
      h.name,
      h.kind,
      h.amount,
      h.currency,
      h.frequency,
      h.nextDate,
      h.anchorDay,
      h.active,
      h.remainingOccurrences,
      h.fromAfford,
      h.category,
      h.account,
      h.goal,
      h.note,
      h.detectedFrom,
      h.createdAt,
      h.updatedAt,
      h.id,
    ],
    ...recurringItems.map((row) => [
      row.name,
      label(common.recurringKindLabels, row.kind),
      money(row.amount),
      row.currency,
      label(common.frequencyLabels, row.frequency),
      day(row.nextDate),
      optionalNumber(row.anchorDay),
      yesNo(row.active),
      optionalNumber(row.remainingOccurrences),
      yesNo(row.fromAfford),
      text(row.category?.name),
      text(row.account?.name),
      text(row.goal?.name),
      text(row.note),
      label(common.sourceLabels, row.detectedFrom),
      timestamp(row.createdAt),
      timestamp(row.updatedAt),
      row.id,
    ]),
  ];

  const budgetRows = [
    [h.year, h.month, h.period, h.category, h.amount, h.currency, h.createdAt, h.updatedAt, h.id],
    ...budgets.map((row) => [
      String(row.year),
      String(row.month),
      label(t.dataExport.payPeriodLabels, row.period),
      text(row.category?.name),
      money(row.amount),
      row.currency,
      timestamp(row.createdAt),
      timestamp(row.updatedAt),
      row.id,
    ]),
  ];

  const accountRows = [
    [h.name, h.type, h.currency, h.status, h.archivedAt, h.createdAt, h.id],
    ...accounts.map((row) => [
      row.name,
      label(common.accountTypeLabels, row.type),
      row.currency,
      label(t.dataExport.accountStatusLabels, row.status),
      timestamp(row.archivedAt),
      timestamp(row.createdAt),
      row.id,
    ]),
  ];

  const categoryRows = [
    [
      h.name,
      h.kind,
      h.color,
      h.icon,
      h.isSubscriptionDefault,
      h.isSavingsDefault,
      h.isEssentialFixed,
      h.createdAt,
      h.id,
    ],
    ...categories.map((row) => [
      row.name,
      label(common.categoryKindLabels, row.kind),
      row.color,
      text(row.icon),
      yesNo(row.isSubscriptionDefault),
      yesNo(row.isSavingsDefault),
      yesNo(row.isEssentialFixed),
      timestamp(row.createdAt),
      row.id,
    ]),
  ];

  const tables = [
    transactionRows,
    goalRows,
    contributionRows,
    recurringRows,
    budgetRows,
    accountRows,
    categoryRows,
  ];
  return EXPORT_FILE_NAMES.map((name, index) => ({ name, text: formatCsv(tables[index]) }));
}

/** The download's file name, stamped with the civil day it was taken. */
export function exportArchiveName(day: Date): string {
  return `cadence-export-${toISODate(day)}.zip`;
}

export async function buildExportArchive(locale: Locale): Promise<Buffer> {
  const files = await buildExportFiles(locale);
  const modifiedAt = new Date();
  return createZip(files.map((file) => ({ name: file.name, data: file.text, modifiedAt })));
}
