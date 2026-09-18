/**
 * Recurring-pattern detection: which organic charges look like a bill or
 * subscription nobody has set up as a RecurringItem yet?
 *
 * The input is the ledger's own spending - MANUAL and CSV expenses only. Rows
 * the posting job wrote (source RECURRING) are the schedule, not evidence of
 * one; a one-off the user confirmed extraordinary (Transaction.isExtraordinary)
 * is by definition not part of a pattern; and the expense a hand-logged goal
 * contribution writes is a contribution, not a bill. Nothing here reads the
 * database or decides anything: the output is a list of candidates the user
 * accepts or dismisses on the Recurring page, one at a time, and no
 * RecurringItem is ever created without that click.
 *
 * The rules, all deterministic and tolerance-based:
 *
 *   - Occurrences group by account, currency and the same merchant key the
 *     CSV review step uses (cleanMerchantKey), so "NETFLIX.COM 866-579-7172"
 *     and "NETFLIX.COM 866-579-7173" are one merchant.
 *   - Within a merchant, the amounts that repeat are the biggest cluster
 *     within a band of +-10% (or +-1.00, whichever is wider, so a cheap bill's
 *     cent-level drift stays in). Other amounts at the same merchant are left
 *     out of the evidence, not counted against it - Prime among Amazon orders.
 *   - At least MIN_OCCURRENCES distinct days, i.e. at least two intervals,
 *     before any cadence is read into them.
 *   - Weekly, biweekly, monthly and yearly come from the gaps between
 *     occurrences: at least half the gaps must fall in the cadence's band.
 *   - Semi-monthly - twice a month on two fixed days - is the one cadence the
 *     gaps alone cannot name, because its gaps (13-17 days) sit right on top
 *     of a biweekly's (14 +- a weekend). It is read from the days of the month
 *     instead: two anchor days about half a month apart that the occurrences
 *     land on, allowing exactly the weekend slop src/lib/period.ts allows a
 *     payday (a Saturday or Sunday anchor paid on the preceding Friday, or the
 *     following Monday). A biweekly charge drifts a day or so per occurrence
 *     across the month, so it can only ever fit two anchors by leaning on
 *     those weekend shifts. The biweekly reading is scored the same way - a
 *     14-day lattice with the same weekend rule - and when both fit, the one
 *     that explains more occurrences without a shift wins; on a dead heat
 *     (a series inside February, where 28 days is both) the mean gap decides,
 *     14 for a biweekly against 15.2 for a semi-monthly, the one signal a
 *     weekend cannot fake. See fitSemiMonthlyAnchors and fitBiweeklyLattice.
 *
 * Pure - no Prisma, no React - so it can be checked directly from
 * scripts/verify-domain.ts and its types are safe to import from the client.
 */
import { addDays, civilDate, daysBetween, daysInMonth, startOfDay } from "@/lib/date";
import { cleanMerchantKey, merchantDisplayName } from "@/lib/import-grouping";
import { advanceDate } from "@/lib/recurring";
import { MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX } from "@/lib/transactions";

/**
 * RecurringFrequency plus SEMI_MONTHLY. The RecurringItem enum has no
 * semi-monthly value (and a single anchorDay), so accepting a SEMI_MONTHLY
 * candidate creates two MONTHLY items, one per anchor day - see
 * acceptRecurringSuggestion in src/lib/data/recurring-suggestions.ts.
 */
export type DetectedCadence = "WEEKLY" | "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY" | "YEARLY";

/** The TransactionSource values that are organic spending - the only evidence detection reads. */
export type OrganicSource = "MANUAL" | "CSV";

/** The Transaction columns detection reads. */
export interface DetectableTransaction {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  type: string;
  source: string;
  accountId: string;
  categoryId: string | null;
  note: string | null;
  externalId: string | null;
  isExtraordinary: boolean;
}

/** A RecurringItem as far as "is this pattern already tracked?" needs it. */
export interface TrackedRecurringItem {
  name: string;
  amount: number;
  currency: string;
  accountId: string | null;
  categoryId: string | null;
  active: boolean;
}

/** One RecurringSuggestionDismissal row: never suggest this merchant on this account again. */
export interface DismissedPattern {
  accountId: string;
  merchantKey: string;
}

export interface RecurringOccurrence {
  id: string;
  date: Date;
  amount: number;
  note: string;
}

export interface RecurringCandidate {
  accountId: string;
  /** cleanMerchantKey of the charges' description - with accountId, the identity a dismissal is keyed by. */
  merchantKey: string;
  /** The merchant key in title case: what the RecurringItem is named. */
  name: string;
  /** The amount as last charged, in `currency`. */
  amount: number;
  currency: string;
  cadence: DetectedCadence;
  /**
   * The day(s) of the month the charge lands on: two for SEMI_MONTHLY, one
   * for MONTHLY and YEARLY, none for WEEKLY and BIWEEKLY (which have no fixed
   * day). A 31 means "the last day of the month" in shorter months, as
   * RecurringItem.anchorDay does.
   */
  anchorDays: number[];
  /**
   * The next due date(s), one per anchor day (a single date for cadences
   * without one): the first occurrence after the last one seen that is on or
   * after today, so accepting never posts a charge the ledger already has or
   * one that was due before today and simply has not been imported yet.
   */
  nextDates: Date[];
  /** The category the charges are most often filed under (uncategorised charges do not vote), or null when none has one. */
  categoryId: string | null;
  /** The source most of the charges came from - RecurringItem.detectedFrom. */
  detectedFrom: OrganicSource;
  /** The most recent charge's raw description, for the item's note. */
  sampleNote: string;
  /** The charges that make the pattern, oldest first. */
  occurrences: RecurringOccurrence[];
}

/** A candidate with what the Recurring page shows beside it. Built by the data layer. */
export interface RecurringSuggestion extends RecurringCandidate {
  accountName: string;
  categoryName: string | null;
  /** `amount` converted to the display currency. */
  displayAmount: number;
}

/** Fewer distinct days than this and no cadence is read into a merchant at all. */
export const MIN_OCCURRENCES = 3;
/** Amounts within this fraction of each other are the same bill... */
export const AMOUNT_TOLERANCE_RATIO = 0.1;
/** ...or within this many currency units, whichever is wider. */
export const AMOUNT_TOLERANCE_FLOOR = 1;
/** At least this share of the gaps between occurrences must fit the cadence's band. */
export const MIN_INTERVAL_MATCH_RATIO = 0.5;
/**
 * A day-of-month fit (semi-monthly anchors, or the biweekly lattice) needs
 * every occurrence on the pattern up to four occurrences, and at least this
 * share from five on, so one charge that slipped past a holiday does not
 * hide an otherwise clear pattern.
 */
export const DAY_FIT_MIN_MATCH_RATIO = 0.8;
/**
 * A pattern whose last charge is older than two of its cadence intervals
 * (plus a few days' slack) has stopped, and is not suggested.
 */
export const MAX_MISSED_INTERVALS = 2;
const STALENESS_SLACK_DAYS = 3;

type IntervalCadence = Exclude<DetectedCadence, "SEMI_MONTHLY">;

/** Days between occurrences that read as each cadence. */
const INTERVAL_BANDS: Record<IntervalCadence, { nominal: number; min: number; max: number }> = {
  WEEKLY: { nominal: 7, min: 6, max: 8 },
  BIWEEKLY: { nominal: 14, min: 12, max: 16 },
  MONTHLY: { nominal: 30, min: 26, max: 35 },
  YEARLY: { nominal: 365, min: 355, max: 376 },
};
const INTERVAL_CADENCES: IntervalCadence[] = ["WEEKLY", "BIWEEKLY", "MONTHLY", "YEARLY"];

/** Median gap in days at which semi-monthly and biweekly are both possible. */
const HALF_MONTH_INTERVAL = { min: 11, max: 19 };
/**
 * A biweekly's gaps average exactly 14 days however the weekends shift them
 * (shifts do not accumulate); a semi-monthly's average 15.2. The mean gap is
 * what tells them apart when the two day-of-month fits are a dead heat.
 */
const BIWEEKLY_MAX_MEAN_INTERVAL = 14.5;
/** How far apart, in days of the month, the two semi-monthly anchors may be. */
const SEMI_MONTHLY_ANCHOR_GAP = { min: 12, max: 19 };

const NOMINAL_INTERVAL: Record<DetectedCadence, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  SEMI_MONTHLY: 15,
  MONTHLY: 30,
  YEARLY: 365,
};

/**
 * Which rows are evidence of a pattern: organic spending with a description
 * to group by. Everything else - posted occurrences, confirmed one-offs,
 * income, transfers, the expense twin of a hand-logged goal contribution -
 * is out before grouping starts.
 */
export function isOrganicExpense(row: DetectableTransaction): boolean {
  if (row.type !== "EXPENSE") return false;
  if (row.source !== "MANUAL" && row.source !== "CSV") return false;
  if (row.isExtraordinary) return false;
  if (row.externalId?.startsWith(MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX)) return false;
  return Boolean(row.note && row.note.trim());
}

/** How far from `amount` another amount may be and still be the same bill. */
export function amountTolerance(amount: number): number {
  return Math.max(Math.abs(amount) * AMOUNT_TOLERANCE_RATIO, AMOUNT_TOLERANCE_FLOOR);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface AmountCluster {
  /** The cluster's median amount. */
  center: number;
  /** Indexes into the input, ascending. */
  members: number[];
}

/**
 * The largest group of amounts that fit one tolerance band. Deterministic:
 * the band is slid up the sorted amounts, the first widest window wins, and
 * membership is then re-read around that window's median so the band is
 * centred on the bill rather than on its cheapest instance.
 */
export function dominantAmountCluster(amounts: readonly number[]): AmountCluster {
  if (amounts.length === 0) return { center: 0, members: [] };
  const order = amounts.map((_, index) => index).sort((a, b) => amounts[a] - amounts[b]);

  let bestStart = 0;
  let bestCount = 0;
  for (let i = 0; i < order.length; i += 1) {
    const start = amounts[order[i]];
    const width = 2 * amountTolerance(start);
    let j = i;
    while (j + 1 < order.length && amounts[order[j + 1]] - start <= width) j += 1;
    const count = j - i + 1;
    if (count > bestCount) {
      bestCount = count;
      bestStart = i;
    }
  }

  const window = order.slice(bestStart, bestStart + bestCount).map((index) => amounts[index]);
  const center = median(window);
  const tolerance = amountTolerance(center);
  const members = amounts
    .map((amount, index) => ({ amount, index }))
    .filter(({ amount }) => Math.abs(amount - center) <= tolerance)
    .map(({ index }) => index);
  return { center, members };
}

// --- day-of-month anchors -------------------------------------------------

type AnchorMatch = "exact" | "shifted";

/**
 * Where anchor day `anchor` falls in the month of `date` (clamped to the
 * month's real length, so 31 is the last day of February too).
 */
function anchorDateIn(year: number, monthIndex: number, anchor: number): Date {
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const fullYear = year + Math.floor(monthIndex / 12);
  return civilDate(fullYear, month, Math.min(anchor, daysInMonth(fullYear, month)));
}

/**
 * Does `date` stand in for the scheduled day `base`? Exact when it is that
 * day; shifted when `base` fell on a weekend and the charge moved to the
 * Friday before (Saturday -1, Sunday -2 - the same rule period.ts applies to
 * a payday) or the Monday after (Saturday +2, Sunday +1, how a bank debit
 * slips). Anything else, including a weekday base a day off, is no match.
 */
function matchScheduledDay(date: Date, base: Date): AnchorMatch | null {
  const distance = daysBetween(base, date);
  if (distance === 0) return "exact";
  const weekday = base.getUTCDay();
  if (weekday === 6 && (distance === -1 || distance === 2)) return "shifted";
  if (weekday === 0 && (distance === -2 || distance === 1)) return "shifted";
  return null;
}

/**
 * Does `date` land on anchor day `anchor`, exactly or by a weekend shift? The
 * anchor's realisation in the previous and next month is checked too, since
 * a 1st pulled back to a Friday lands in the month before.
 */
function matchAnchor(date: Date, anchor: number): { kind: AnchorMatch; base: Date } | null {
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  let shifted: { kind: AnchorMatch; base: Date } | null = null;
  for (const offset of [-1, 0, 1]) {
    const base = anchorDateIn(year, monthIndex + offset, anchor);
    const kind = matchScheduledDay(date, base);
    if (kind === "exact") return { kind, base };
    if (kind === "shifted" && !shifted) shifted = { kind, base };
  }
  return shifted;
}

/** How well a schedule explains the occurrences. */
export interface PatternFit {
  /** Occurrences on the schedule, exactly or via a weekend shift. */
  matched: number;
  exact: number;
  shifted: number;
}

export interface AnchorFit extends PatternFit {
  anchorDays: number[];
}

/**
 * Every occurrence must fit up to four occurrences; from five, at least
 * DAY_FIT_MIN_MATCH_RATIO of them. Shared by the semi-monthly and biweekly
 * fits so neither reading is held to a looser standard than the other.
 */
function requiredMatches(count: number): number {
  return count <= 4 ? count : Math.ceil(count * DAY_FIT_MIN_MATCH_RATIO);
}

function scoreAnchors(dates: readonly Date[], anchors: readonly number[]): AnchorFit & { hitsPerAnchor: number[] } {
  let exact = 0;
  let shifted = 0;
  const hitsPerAnchor = anchors.map(() => 0);
  for (const date of dates) {
    let best: AnchorMatch | null = null;
    let bestAnchor = -1;
    anchors.forEach((anchor, index) => {
      const match = matchAnchor(date, anchor);
      if (!match) return;
      if (best === null || (best === "shifted" && match.kind === "exact")) {
        best = match.kind;
        bestAnchor = index;
      }
    });
    if (best === null) continue;
    hitsPerAnchor[bestAnchor] += 1;
    if (best === "exact") exact += 1;
    else shifted += 1;
  }
  return { anchorDays: [...anchors], matched: exact + shifted, exact, shifted, hitsPerAnchor };
}

function betterFit(a: PatternFit, b: PatternFit | null): boolean {
  if (!b) return true;
  if (a.matched !== b.matched) return a.matched > b.matched;
  return a.exact > b.exact;
}

/**
 * The two anchor days, 12-19 days apart, that the most occurrences land on.
 * Null unless requiredMatches of them land on one of the two and both
 * anchors are used. Ties go to the fit with more exact hits, then to the
 * lower pair, so the result never depends on iteration luck.
 */
export function fitSemiMonthlyAnchors(dates: readonly Date[]): AnchorFit | null {
  const distinct = distinctDays(dates);
  if (distinct.length < MIN_OCCURRENCES) return null;

  let best: (AnchorFit & { hitsPerAnchor: number[] }) | null = null;
  for (let first = 1; first <= 31; first += 1) {
    for (
      let second = first + SEMI_MONTHLY_ANCHOR_GAP.min;
      second <= Math.min(31, first + SEMI_MONTHLY_ANCHOR_GAP.max);
      second += 1
    ) {
      const fit = scoreAnchors(distinct, [first, second]);
      if (fit.hitsPerAnchor.some((hits) => hits === 0)) continue;
      if (betterFit(fit, best)) best = fit;
    }
  }
  if (!best || best.matched < requiredMatches(distinct.length)) return null;
  const { hitsPerAnchor: _hits, ...fit } = best;
  return fit;
}

/**
 * The biweekly reading of the same occurrences: a lattice of dates 14 days
 * apart, each occurrence on a lattice point exactly or by the same weekend
 * shift the anchor fit allows. All fourteen phases of the lattice are tried
 * against the first occurrence; the best (most matched, then most exact,
 * then the earliest phase) is kept. Null unless requiredMatches fit.
 */
export function fitBiweeklyLattice(dates: readonly Date[]): PatternFit | null {
  const distinct = distinctDays(dates);
  if (distinct.length < MIN_OCCURRENCES) return null;
  const step = INTERVAL_BANDS.BIWEEKLY.nominal;
  const origin = distinct[0];

  let best: PatternFit | null = null;
  for (let phase = 0; phase < step; phase += 1) {
    let exact = 0;
    let shifted = 0;
    for (const date of distinct) {
      const offset = daysBetween(origin, date) - phase;
      const base = addDays(origin, phase + Math.round(offset / step) * step);
      const kind = matchScheduledDay(date, base);
      if (kind === "exact") exact += 1;
      else if (kind === "shifted") shifted += 1;
    }
    const fit = { matched: exact + shifted, exact, shifted };
    if (betterFit(fit, best)) best = fit;
  }
  return best && best.matched >= requiredMatches(distinct.length) ? best : null;
}

/** The single anchor day the most occurrences land on (ties to more exact hits, then the lower day). */
function fitMonthlyAnchor(dates: readonly Date[]): number {
  let best: AnchorFit | null = null;
  for (let anchor = 1; anchor <= 31; anchor += 1) {
    const fit = scoreAnchors(dates, [anchor]);
    if (betterFit(fit, best)) best = fit;
  }
  return best?.anchorDays[0] ?? dates[dates.length - 1].getUTCDate();
}

// --- cadence --------------------------------------------------------------

export interface CadenceFit {
  cadence: DetectedCadence;
  /** See RecurringCandidate.anchorDays. */
  anchorDays: number[];
}

function distinctDays(dates: readonly Date[]): Date[] {
  const seen = new Set<number>();
  const days: Date[] = [];
  for (const date of dates) {
    const day = startOfDay(date);
    if (seen.has(day.getTime())) continue;
    seen.add(day.getTime());
    days.push(day);
  }
  return days.sort((a, b) => a.getTime() - b.getTime());
}

function intervalsOf(days: readonly Date[]): number[] {
  const intervals: number[] = [];
  for (let i = 1; i < days.length; i += 1) intervals.push(daysBetween(days[i - 1], days[i]));
  return intervals;
}

function intervalMatchRatio(intervals: readonly number[], cadence: IntervalCadence): number {
  const band = INTERVAL_BANDS[cadence];
  const matched = intervals.filter((gap) => gap >= band.min && gap <= band.max).length;
  return matched / intervals.length;
}

/**
 * The cadence the occurrence dates fit, or null when they fit none. Needs
 * MIN_OCCURRENCES distinct days. When the gaps make semi-monthly possible,
 * the semi-monthly and biweekly readings are both fitted by day (see the
 * module comment) and only a fit earns the cadence: gaps in the biweekly
 * band with no lattice behind them are no cadence at all. Everything else
 * goes by the share of gaps in each cadence's band, the best share winning
 * and the nearest nominal gap breaking ties.
 */
export function inferCadence(dates: readonly Date[]): CadenceFit | null {
  const days = distinctDays(dates);
  if (days.length < MIN_OCCURRENCES) return null;
  const intervals = intervalsOf(days);
  const medianInterval = median(intervals);

  if (medianInterval >= HALF_MONTH_INTERVAL.min && medianInterval <= HALF_MONTH_INTERVAL.max) {
    const semiMonthly = fitSemiMonthlyAnchors(days);
    const biweekly = fitBiweeklyLattice(days);
    if (!semiMonthly && !biweekly) return null;
    const readsBiweekly = (() => {
      if (!semiMonthly) return true;
      if (!biweekly) return false;
      if (biweekly.matched !== semiMonthly.matched) return biweekly.matched > semiMonthly.matched;
      if (biweekly.exact !== semiMonthly.exact) return biweekly.exact > semiMonthly.exact;
      const meanInterval = daysBetween(days[0], days[days.length - 1]) / intervals.length;
      return meanInterval <= BIWEEKLY_MAX_MEAN_INTERVAL;
    })();
    return readsBiweekly
      ? { cadence: "BIWEEKLY", anchorDays: [] }
      : { cadence: "SEMI_MONTHLY", anchorDays: (semiMonthly as AnchorFit).anchorDays };
  }

  let best: { cadence: IntervalCadence; ratio: number; distance: number } | null = null;
  for (const cadence of INTERVAL_CADENCES) {
    const ratio = intervalMatchRatio(intervals, cadence);
    if (ratio < MIN_INTERVAL_MATCH_RATIO) continue;
    const distance = Math.abs(medianInterval - INTERVAL_BANDS[cadence].nominal);
    if (!best || ratio > best.ratio || (ratio === best.ratio && distance < best.distance)) {
      best = { cadence, ratio, distance };
    }
  }
  if (!best) return null;
  const anchorDays =
    best.cadence === "MONTHLY" || best.cadence === "YEARLY" ? [fitMonthlyAnchor(days)] : [];
  return { cadence: best.cadence, anchorDays };
}

// --- next dates -----------------------------------------------------------

/** The first date strictly after `after` and on or after `today`, stepping by `step`. */
function firstDueDate(after: Date, today: Date, step: (date: Date) => Date): Date {
  let next = step(after);
  // Bounded: a pattern is never more than a few intervals stale (see
  // MAX_MISSED_INTERVALS), so this walks a handful of steps at most.
  for (let i = 0; i < 1000 && next.getTime() < today.getTime(); i += 1) next = step(next);
  return next;
}

/**
 * The anchor date the most recent occurrence stood in for (Jul 31 for an
 * anchor of 1 is Aug 1's charge), so stepping from it never re-issues the
 * occurrence the ledger already has under a shifted date.
 */
function lastAnchorBase(days: readonly Date[], anchor: number): Date {
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const match = matchAnchor(days[i], anchor);
    if (match) return match.base;
  }
  return days[days.length - 1];
}

function nextDatesFor(fit: CadenceFit, days: readonly Date[], today: Date): Date[] {
  const last = days[days.length - 1];
  switch (fit.cadence) {
    case "WEEKLY":
    case "BIWEEKLY":
      return [firstDueDate(last, today, (date) => advanceDate(date, fit.cadence as "WEEKLY" | "BIWEEKLY"))];
    case "SEMI_MONTHLY":
      return fit.anchorDays.map((anchor) =>
        firstDueDate(lastAnchorBase(days, anchor), today, (date) => advanceDate(date, "MONTHLY", anchor)),
      );
    case "YEARLY":
    case "MONTHLY":
    default: {
      const anchor = fit.anchorDays[0];
      return [firstDueDate(lastAnchorBase(days, anchor), today, (date) => advanceDate(date, fit.cadence as "MONTHLY" | "YEARLY", anchor))];
    }
  }
}

// --- candidates -----------------------------------------------------------

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The same recognition rule the monthly pace uses for "this charge is that
 * item's" (matchRecurringToTransactions in src/lib/data/monthly.ts), split
 * across two paths. A strong merchant-name match (the item's name and the
 * merchant contain one another) is sufficient on its own: a cross-currency
 * subscription's real charges are legitimately recorded in the account's
 * local currency, and a subscription's real price can legitimately drift
 * without becoming a different subscription. Absent a name match, the item
 * must sit on the same account and category, with currency equal and amount
 * within the band - shapeMatches has no name signal to fall back on, so it
 * needs both. Only an active item counts - a paused one is not tracking
 * anything, and the pattern is worth pointing out again.
 */
function isTracked(
  candidate: { accountId: string; merchantKey: string; amount: number; currency: string; categoryId: string | null },
  items: readonly TrackedRecurringItem[],
): boolean {
  const key = normalizeForMatch(candidate.merchantKey);
  const tolerance = amountTolerance(candidate.amount);
  return items.some((item) => {
    if (!item.active) return false;
    const name = normalizeForMatch(item.name);
    const nameMatches =
      name.length >= 3 && key.length >= 3 && (name.includes(key) || key.includes(name));
    if (nameMatches) return true;
    if (item.currency !== candidate.currency) return false;
    if (Math.abs(item.amount - candidate.amount) > tolerance) return false;
    const shapeMatches =
      item.accountId === candidate.accountId &&
      item.categoryId !== null &&
      item.categoryId === candidate.categoryId;
    return shapeMatches;
  });
}

/** The most common value, ties to the one on the most recent row (rows are oldest first). */
function mode<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const value of values) {
    const count = counts.get(value) ?? 0;
    if (count >= bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export interface DetectionInput {
  transactions: readonly DetectableTransaction[];
  /** Every RecurringItem, any kind; inactive ones are ignored (see isTracked). */
  trackedItems: readonly TrackedRecurringItem[];
  dismissed: readonly DismissedPattern[];
  today: Date;
}

/**
 * Every pattern worth suggesting, most charges first, then by name. Reads
 * only what it is given and writes nothing.
 */
export function detectRecurringPatterns(input: DetectionInput): RecurringCandidate[] {
  const today = startOfDay(input.today);
  const dismissed = new Set(input.dismissed.map((row) => `${row.accountId} ${row.merchantKey}`));

  const groups = new Map<string, DetectableTransaction[]>();
  for (const row of input.transactions) {
    if (!isOrganicExpense(row)) continue;
    const merchantKey = cleanMerchantKey(row.note as string);
    const groupKey = `${row.accountId} ${row.currency} ${merchantKey}`;
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  const candidates: RecurringCandidate[] = [];
  for (const rows of groups.values()) {
    const merchantKey = cleanMerchantKey(rows[0].note as string);
    const { accountId, currency } = rows[0];
    if (dismissed.has(`${accountId} ${merchantKey}`)) continue;

    const cluster = dominantAmountCluster(rows.map((row) => row.amount));
    const evidence = cluster.members
      .map((index) => rows[index])
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
    const days = distinctDays(evidence.map((row) => row.date));
    if (days.length < MIN_OCCURRENCES) continue;

    const fit = inferCadence(days);
    if (!fit) continue;

    const last = days[days.length - 1];
    const staleAfter = MAX_MISSED_INTERVALS * NOMINAL_INTERVAL[fit.cadence] + STALENESS_SLACK_DAYS;
    if (daysBetween(last, today) > staleAfter) continue;

    const latest = evidence[evidence.length - 1];
    const amount = round2(latest.amount);
    const categoryId = mode(evidence.map((row) => row.categoryId).filter((id): id is string => id !== null));
    if (isTracked({ accountId, merchantKey, amount, currency, categoryId }, input.trackedItems)) continue;

    candidates.push({
      accountId,
      merchantKey,
      name: merchantDisplayName(latest.note as string),
      amount,
      currency,
      cadence: fit.cadence,
      anchorDays: fit.anchorDays,
      nextDates: nextDatesFor(fit, days, today),
      categoryId,
      // isOrganicExpense admitted only MANUAL and CSV rows to `evidence`.
      detectedFrom: (mode(evidence.map((row) => row.source)) ?? latest.source) as OrganicSource,
      sampleNote: (latest.note as string).trim(),
      occurrences: evidence.map((row) => ({
        id: row.id,
        date: row.date,
        amount: row.amount,
        note: (row.note as string).trim(),
      })),
    });
  }

  return candidates.sort(
    (a, b) =>
      b.occurrences.length - a.occurrences.length ||
      a.name.localeCompare(b.name) ||
      a.accountId.localeCompare(b.accountId),
  );
}
