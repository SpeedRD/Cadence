/**
 * Extraordinary-expense classification: is one new expense unusually large
 * for its category? A confirmed one-off (Transaction.isExtraordinary) is left
 * out of the two averages that estimate typical spending - the payday
 * planner's category suggestions (getCategorySuggestions) and Reports'
 * monthly average (getHistoricalMonthlyAverage) - so a single big purchase
 * does not inflate what those suggest for the periods after it.
 *
 * Nothing here decides anything on its own. The threshold only produces a
 * suggestion that the entry point (the transaction form, the CSV review step)
 * puts in front of the user, defaulting to "not extraordinary"; the flag is
 * written only when the user confirms it, or flips it by hand on the
 * Transactions page. Same principle as the CSV importer's possible
 * duplicates: surfaced for review, never auto-applied.
 *
 * Pure - no Prisma - so it can be checked directly from scripts/verify-domain.ts.
 */

/** A candidate above this multiple of the category's median is offered as possibly extraordinary. */
export const EXTRAORDINARY_MULTIPLIER = 3;

/**
 * Fewer prior transactions than this and no classification is offered at all:
 * a median of one or two amounts says nothing about what is typical, so the
 * helper stays honest and returns null, like every other "not enough history"
 * figure in Cadence.
 */
export const EXTRAORDINARY_MIN_HISTORY = 3;

/**
 * How far back a category's "recent" history reaches when the entry points
 * gather the amounts to compare against. Six months, the same span the two
 * averages themselves walk (HISTORY_PERIODS comparable pay periods, MAX_HISTORICAL_MONTHS).
 */
export const EXTRAORDINARY_LOOKBACK_MONTHS = 6;

export interface ExtraordinaryClassification {
  /** The candidate exceeds EXTRAORDINARY_MULTIPLIER x the median of the prior amounts. */
  possiblyExtraordinary: boolean;
  /** The median the candidate was measured against, in the amounts' own unit. */
  median: number;
  /** How many prior amounts the median was taken over. */
  sampleSize: number;
}

/** The middle value of `values` (the mean of the two middle values for an even count). Empty input is 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Measures `candidate` against the category's prior amounts. Every amount must
 * already be in one unit (the caller converts to the display currency). Null
 * when there are fewer than EXTRAORDINARY_MIN_HISTORY prior amounts: no
 * verdict is offered rather than a meaningless one. A median of 0 never
 * flags anything - there is nothing to be a multiple of.
 */
export function classifyExtraordinary(
  priorAmounts: readonly number[],
  candidate: number,
): ExtraordinaryClassification | null {
  if (priorAmounts.length < EXTRAORDINARY_MIN_HISTORY) return null;
  const typical = median(priorAmounts);
  return {
    possiblyExtraordinary: typical > 0 && candidate > typical * EXTRAORDINARY_MULTIPLIER,
    median: typical,
    sampleSize: priorAmounts.length,
  };
}
