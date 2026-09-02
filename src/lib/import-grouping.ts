/**
 * Grouped-pattern detection for the CSV import review step.
 *
 * Pure and dependency-free (no Prisma, no React) so it can run in the browser
 * and be unit tested directly. It builds on top of the existing deterministic
 * categorization rules (src/lib/categorization-rules.ts) rather than
 * replacing them - this module only decides how to *group* rows and which of
 * them look like a subscription or a transfer; it never itself decides a
 * transaction's final category, and it never creates a RecurringItem or a
 * transfer.
 */
import { addDays, addMonths, addYears } from "@/lib/date";
import { suggestCategoryName } from "@/lib/categorization-rules";

export type ImportRowType = "EXPENSE" | "INCOME";
export type RecurringFrequencyGuess = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "YEARLY";
export type DetectedGroupKind = "transfer" | "subscription" | "category" | "unknown";

export interface GroupableRow {
  /** Position of this row in the caller's row list - preserved so a decision
   *  made on a group can be mapped back to the exact original rows. */
  index: number;
  date: Date;
  amount: number;
  note: string;
  type: ImportRowType;
}

export interface DetectedGroup {
  /** Stable, unique key for this group (React key / decision map key). */
  id: string;
  kind: DetectedGroupKind;
  displayName: string;
  /** One representative original description, for review context. */
  sampleNote: string;
  rowIndexes: number[];
  count: number;
  totalAmount: number;
  /** Deterministic suggestion from the existing categorization engine, if any. */
  suggestedCategoryName: string | null;
  /** Repeated, same-amount, evenly-spaced charges - or a known Subscriptions
   *  merchant repeated - so a "create recurring item" review action applies. */
  possibleSubscription: boolean;
  /** Best-guess cadence for prefilling a RecurringItem's frequency/nextDate. */
  inferredFrequency: RecurringFrequencyGuess;
  /** Suggested next due date for a RecurringItem, one cadence after the
   *  latest occurrence in the group. */
  inferredNextDate: Date;
}

export interface GroupingResult {
  groups: DetectedGroup[];
  /** Rows that matched no repeated pattern and have no automatic category
   *  suggestion - the "Unknown merchants" bucket, for optional individual review. */
  unknownRowIndexes: number[];
}

const NOISE_WORDS = new Set([
  "POS",
  "DEBIT",
  "CREDIT",
  "PURCHASE",
  "PAYMENT",
  "PMT",
  "REF",
  "AUTH",
  "TRACE",
  "ONLINE",
  "WEB",
  "CARD",
  "THE",
  "INC",
  "LLC",
  "CO",
  "LTD",
]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalizes a description down to its merchant-identifying words: strips
 * digits (order numbers, store numbers, confirmation codes vary per
 * transaction from the same merchant) and a short list of generic banking
 * noise words, keeping the rest. Two descriptions only group together when
 * this key matches exactly - deliberately not a fuzzy/similarity match, so
 * two merely-similar merchants never get merged.
 */
export function cleanMerchantKey(note: string): string {
  const words = stripDiacritics(note)
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((word) => word.length > 1 && !NOISE_WORDS.has(word));
  const key = words.join(" ");
  return key || stripDiacritics(note).trim().toUpperCase();
}

/**
 * "Transfer" and the Spanish "Transferencia" both contain this substring, so
 * a single check catches "Debito Por Transferencia", "Por Transferencia ACH",
 * "Transferencia Recibida...", and English "Wire Transfer" / "ACH Transfer"
 * alike. Deliberately broad: a false positive here only means an ordinary row
 * gets an extra "review" option, never an automatic transfer.
 */
export function isTransferShapedDescription(note: string): boolean {
  return stripDiacritics(note).toUpperCase().includes("TRANSFER");
}

function toTitleCase(key: string): string {
  return key
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function dayGaps(dates: Date[]): number[] {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push(Math.round((sorted[i].getTime() - sorted[i - 1].getTime()) / 86_400_000));
  }
  return gaps;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hasConsistentAmounts(amounts: number[]): boolean {
  if (amounts.length === 0) return false;
  return amounts.every((amount) => Math.abs(amount - amounts[0]) < 0.005);
}

function isPeriodicPattern(dates: Date[]): boolean {
  const gaps = dayGaps(dates);
  // A single gap is never enough evidence of a cadence - anything would trivially
  // "match" it. Regularity only means something once there's a second gap to
  // compare against, so a 2-occurrence group can only be flagged as a possible
  // subscription via a known Subscriptions-category match, not this heuristic.
  if (gaps.length < 2 || gaps.some((gap) => gap <= 0)) return false;
  const gapMedian = median(gaps);
  if (gapMedian < 5 || gapMedian > 380) return false;
  const tolerance = Math.max(4, Math.round(gapMedian * 0.2));
  return gaps.every((gap) => Math.abs(gap - gapMedian) <= tolerance);
}

/**
 * A repeated pattern "appears periodic enough to plausibly be a subscription"
 * when every occurrence charges the same amount on a roughly even cadence
 * (weekly through yearly, ±20%). This is a heuristic for surfacing a review
 * action, never a basis for creating anything automatically.
 */
export function looksLikeSubscription(dates: Date[], amounts: number[]): boolean {
  return dates.length >= 2 && hasConsistentAmounts(amounts) && isPeriodicPattern(dates);
}

export function inferFrequency(dates: Date[]): RecurringFrequencyGuess {
  const gaps = dayGaps(dates);
  const gapMedian = gaps.length ? median(gaps) : 30;
  if (gapMedian <= 10) return "WEEKLY";
  if (gapMedian <= 20) return "BIWEEKLY";
  if (gapMedian <= 45) return "MONTHLY";
  return "YEARLY";
}

function advanceByFrequency(date: Date, frequency: RecurringFrequencyGuess): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDays(date, 7);
    case "BIWEEKLY":
      return addDays(date, 14);
    case "YEARLY":
      return addYears(date, 1);
    case "MONTHLY":
    default:
      return addMonths(date, 1);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildGroup(
  key: string,
  bucket: "transfer" | "expense",
  rows: GroupableRow[],
  kind: DetectedGroupKind,
  suggestedCategoryName: string | null,
  possibleSubscription: boolean,
): DetectedGroup {
  const dates = rows.map((row) => row.date);
  const latestDate = dates.reduce((latest, date) => (date > latest ? date : latest), dates[0]);
  const inferredFrequency = inferFrequency(dates);
  return {
    id: `${bucket}:${key}`,
    kind,
    displayName: toTitleCase(key),
    sampleNote: rows[0].note,
    rowIndexes: rows.map((row) => row.index),
    count: rows.length,
    totalAmount: round2(rows.reduce((sum, row) => sum + row.amount, 0)),
    suggestedCategoryName,
    possibleSubscription,
    inferredFrequency,
    inferredNextDate: advanceByFrequency(latestDate, inferredFrequency),
  };
}

/**
 * Groups CSV rows into review-worthy patterns. Only ever reads rows - never
 * mutates them - grouping is purely a review mechanism, the original rows
 * always continue on to import unchanged (see CsvImporter).
 *
 * - Transfer-shaped rows (any type - a transfer can be a debit or a credit)
 *   always get their own group, even a single occurrence, since flagging
 *   them for review matters regardless of frequency.
 * - Ordinary merchant/category grouping only ever considers EXPENSE rows -
 *   income never forms a merchant group.
 * - A repeated (2+) merchant always gets its own card, whether or not the
 *   deterministic engine recognizes it, so the user can still bulk-categorize
 *   or bulk-ignore it.
 * - A merchant seen once with an existing automatic suggestion needs no
 *   review at all (unchanged behavior); seen once with no suggestion, it
 *   lands in the "unknown merchants" bucket for optional individual review.
 */
export function detectImportGroups(rows: GroupableRow[]): GroupingResult {
  const transferBuckets = new Map<string, GroupableRow[]>();
  const expenseBuckets = new Map<string, GroupableRow[]>();

  for (const row of rows) {
    if (isTransferShapedDescription(row.note)) {
      const key = cleanMerchantKey(row.note);
      const bucket = transferBuckets.get(key) ?? [];
      bucket.push(row);
      transferBuckets.set(key, bucket);
      continue;
    }
    if (row.type !== "EXPENSE") continue;
    const key = cleanMerchantKey(row.note);
    const bucket = expenseBuckets.get(key) ?? [];
    bucket.push(row);
    expenseBuckets.set(key, bucket);
  }

  const groups: DetectedGroup[] = [];
  const unknownRowIndexes: number[] = [];

  for (const [key, bucketRows] of transferBuckets) {
    groups.push(buildGroup(key, "transfer", bucketRows, "transfer", null, false));
  }

  for (const [key, bucketRows] of expenseBuckets) {
    const suggestion = suggestCategoryName(bucketRows[0].note, "EXPENSE");

    if (bucketRows.length < 2) {
      if (!suggestion) unknownRowIndexes.push(bucketRows[0].index);
      continue;
    }

    const dates = bucketRows.map((row) => row.date);
    const amounts = bucketRows.map((row) => row.amount);
    const possibleSubscription =
      suggestion === "Subscriptions" || looksLikeSubscription(dates, amounts);
    const kind: DetectedGroupKind = possibleSubscription
      ? "subscription"
      : suggestion
        ? "category"
        : "unknown";

    groups.push(buildGroup(key, "expense", bucketRows, kind, suggestion, possibleSubscription));
  }

  groups.sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));
  unknownRowIndexes.sort((a, b) => a - b);

  return { groups, unknownRowIndexes };
}

/** One review decision: apply `categoryId` (a real category id, or the
 *  EXPLICIT_NO_CATEGORY sentinel from categorization-rules.ts) to every row
 *  in `rowIndexes`. Used for both a detected group's decision (its whole
 *  rowIndexes list) and a manually selected set of "unknown merchant" rows -
 *  the two are otherwise identical fan-out operations. */
export interface RowCategoryDecision {
  rowIndexes: number[];
  categoryId: string;
}

/**
 * Flattens a list of decisions into a single index -> categoryId map, later
 * ones winning on overlap. Pure fan-out, no grouping/detection logic of its
 * own - kept separate from detectImportGroups so it can be reused (and
 * tested) for arbitrary manually-selected rows too.
 */
export function buildRowCategoryOverrides(
  decisions: RowCategoryDecision[],
): Map<number, string> {
  const overrides = new Map<number, string>();
  for (const decision of decisions) {
    for (const index of decision.rowIndexes) overrides.set(index, decision.categoryId);
  }
  return overrides;
}
