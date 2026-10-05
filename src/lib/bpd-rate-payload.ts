/**
 * The database-free half of Banco Popular Dominicano rate handling: the
 * feed URL, the plausibility bounds, the freshness window and the pure
 * parsing of the bank's SharePoint payload. Kept apart from
 * src/lib/bpd-rates.ts (which owns the fetch and the ExchangeRate writes and
 * therefore imports Prisma) so scripts/scrape-bpd-rate.ts - which runs in a
 * GitHub Actions job with a browser but no database - can validate a scraped
 * payload with exactly the same rules the server applies, never a copy.
 */

/**
 * Banco Popular Dominicano's public rates feed. Confirmed by manual
 * investigation (2026-09-16) to return the bank's real daily buy/sell rates
 * as plain JSON - no auth, no CAPTCHA - and (2026-09-18) to sit behind
 * Imperva Incapsula bot protection, which answers every bare HTTP client
 * (curl, Node fetch, any User-Agent) with a 403 challenge page but lets a
 * real browser through once its challenge script has run. Preferred over
 * open.er-api.com for DOP and EUR because it's the bank's own published
 * rate, not a market aggregator's.
 */
export const BPD_RATES_API_URL =
  "https://popularenlinea.com/_api/web/lists/getbytitle('Rates')/items?$filter=ItemID%20eq%20'1'";

/**
 * How many calendar days old a stored or freshly-fetched BPD rate may be and
 * still be preferred over open.er-api.com's. The bank doesn't publish every
 * business day (confirmed 2026-09-16: still showing Sep 15's rate on Sep
 * 17), so "today only" rejected rates that were still far more accurate than
 * the market-mid fallback; this bounds the staleness instead of requiring an
 * exact match, so a silently ancient rate still gets rejected eventually.
 */
export const BPD_RATE_MAX_AGE_DAYS = 7;

export const BPD_SOURCE = "bpd";

/**
 * Banco Popular's published DOP/USD sell rate is historically in this band; a
 * value outside it is treated as a malformed or unpublished payload rather
 * than trusted. Mirrors the DOP: 60 midpoint FALLBACK_RATES already uses in
 * src/lib/rates.ts - there's no narrower existing bound in this codebase to
 * reuse instead.
 */
export const MIN_PLAUSIBLE_DOP_RATE = 55;
export const MAX_PLAUSIBLE_DOP_RATE = 75;

/**
 * The euro sell rate is judged by what it implies against the dollar sell
 * rate, EUR/USD, not by the dollar's band: the euro is dearer than the
 * dollar, so a band in pesos would refuse it first (S12, 75.40 at a dollar
 * of 63.10). The euro has traded inside this band against the dollar since
 * it was introduced.
 */
export const MIN_PLAUSIBLE_EUR_USD = 0.8;
export const MAX_PLAUSIBLE_EUR_USD = 1.6;

export interface BpdRates {
  /** DOP paid per 1 USD sold to a customer ("Vendemos"). */
  dollarSellRate: number;
  /** DOP paid per 1 EUR sold to a customer ("Vendemos"). */
  euroSellRate: number;
  /** The calendar day BPD says these rates are published for. */
  asOf: Date;
}

export function isPlausibleDopRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_DOP_RATE &&
    value <= MAX_PLAUSIBLE_DOP_RATE
  );
}

/**
 * Whether a dollar sell rate and a euro sell rate the bank published are
 * plausible together: the dollar inside its peso band, the euro inside the
 * EUR/USD band against that dollar. Every place that accepts a Banco Popular
 * rate - the payload parser, storeBpdRates, the ingest route - asks this.
 */
export function isPlausibleBpdRates(dollarSellRate: unknown, euroSellRate: unknown): boolean {
  if (!isPlausibleDopRate(dollarSellRate)) return false;
  if (typeof euroSellRate !== "number" || !Number.isFinite(euroSellRate)) return false;
  const eurUsd = euroSellRate / dollarSellRate;
  return eurUsd >= MIN_PLAUSIBLE_EUR_USD && eurUsd <= MAX_PLAUSIBLE_EUR_USD;
}

/** Same calendar day in UTC - BuySellRatesAsOf and "today" are both compared this way throughout this module. */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Whole UTC calendar days between `asOf` and `now` (0 = same UTC day). */
function utcDaysBetween(asOf: Date, now: Date): number {
  const asOfUtcMidnight = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const nowUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((nowUtcMidnight - asOfUtcMidnight) / (24 * 60 * 60 * 1000));
}

/**
 * `asOf` is today or up to BPD_RATE_MAX_AGE_DAYS calendar days in the past -
 * never in the future, and never older than the bounded window.
 */
export function isWithinFreshnessWindow(asOf: Date, now: Date): boolean {
  const ageDays = utcDaysBetween(asOf, now);
  return ageDays >= 0 && ageDays <= BPD_RATE_MAX_AGE_DAYS;
}

/**
 * Validates and extracts the fields this app uses from BPD's SharePoint list
 * response. Pure and network-free so it can be exercised directly against a
 * fabricated payload; the network fetch itself lives in `fetchBpdRates`, and
 * the browser-driven capture in scripts/scrape-bpd-rate.ts.
 */
export function parseBpdPayload(payload: unknown): BpdRates | null {
  if (typeof payload !== "object" || payload === null) return null;
  const d = (payload as { d?: unknown }).d;
  if (typeof d !== "object" || d === null) return null;
  const results = (d as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const item = results[0] as Record<string, unknown>;

  const dollarSellRate = item.DollarSellRate;
  const euroSellRate = item.EuroSellRate;
  const asOfRaw = item.BuySellRatesAsOf;
  if (!isPlausibleBpdRates(dollarSellRate, euroSellRate)) {
    return null;
  }
  if (typeof asOfRaw !== "string") return null;
  const asOf = new Date(asOfRaw);
  if (Number.isNaN(asOf.getTime())) return null;

  return { dollarSellRate: dollarSellRate as number, euroSellRate: euroSellRate as number, asOf };
}

/**
 * The two USD-based RateTable entries BPD's rates translate to: DOP is the
 * published USD sell rate directly; EUR is a derived cross-rate, since BPD
 * publishes it as DOP-per-EUR rather than EUR-per-USD (RateTable's unit).
 */
export function toRateTableEntries(rates: BpdRates): { DOP: number; EUR: number } {
  return {
    DOP: rates.dollarSellRate,
    EUR: rates.dollarSellRate / rates.euroSellRate,
  };
}

/**
 * The euro sell rate behind a stored EUR row. The row keeps the cross-rate
 * toRateTableEntries derives (dollar sell / euro sell) at ExchangeRate.rate's
 * ten decimals, so dividing back gives the quote only to within about 5e-9 -
 * and 163.71 EUR at a sell rate of 68.50 then converts at 68.4999999973, a
 * cent low (S20). The bank quotes to a few decimals, so a division that lands
 * that close to a six-decimal figure is that quote; anything else is kept as
 * divided.
 */
export function euroSellFromStored(dollarSellRate: number, storedEuroCrossRate: number): number {
  const divided = dollarSellRate / storedEuroCrossRate;
  const quoted = Number(divided.toFixed(6));
  return Math.abs(divided - quoted) < 1e-7 ? quoted : divided;
}

/**
 * The Banco Popular rates the stored source="bpd" rows hold, when both rows
 * are inside the freshness window and the dollar sell rate is plausible -
 * the rates getRateTable prefers - or null. The one reading of those rows,
 * shared by getBpdRates and scripts/backfill-account-currency.ts.
 */
export function bpdRatesFromStored(
  rows: readonly { targetCurrency: string; rate: number; asOf: Date | null }[],
  now: Date,
): BpdRates | null {
  const dop = rows.find((row) => row.targetCurrency === "DOP");
  const eur = rows.find((row) => row.targetCurrency === "EUR");
  if (!dop?.asOf || !eur?.asOf || !isWithinFreshnessWindow(dop.asOf, now) || !isWithinFreshnessWindow(eur.asOf, now)) return null;
  const dollarSellRate = dop.rate;
  const euroCrossRate = eur.rate;
  if (!isPlausibleDopRate(dollarSellRate) || !(euroCrossRate > 0)) return null;
  return { dollarSellRate, euroSellRate: euroSellFromStored(dollarSellRate, euroCrossRate), asOf: dop.asOf };
}
