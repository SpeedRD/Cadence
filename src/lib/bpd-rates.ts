import {
  BPD_RATES_API_URL,
  BPD_SOURCE,
  type BpdRates,
  isPlausibleDopRate,
  isWithinFreshnessWindow,
  parseBpdPayload,
  toRateTableEntries,
} from "@/lib/bpd-rate-payload";
import { BASE_CURRENCY } from "@/lib/currency";
import { prisma } from "@/lib/prisma";

// The pure half (bounds, freshness window, payload parsing) lives in
// src/lib/bpd-rate-payload.ts so a database-free script can share it;
// re-exported here so existing importers keep one entry point.
export {
  BPD_RATE_MAX_AGE_DAYS,
  BPD_SOURCE,
  type BpdRates,
  isSameUtcDay,
  parseBpdPayload,
  toRateTableEntries,
} from "@/lib/bpd-rate-payload";

/**
 * The one property that matters most here: a hung response must never
 * outlast this and stall whatever called getRateTable(). 4s is generous for
 * a same-region JSON API response but short enough that a caller falling
 * back to open.er-api.com (or to stored/stale rates) stays fast even when
 * BPD's endpoint hangs on every single call.
 */
const BPD_FETCH_TIMEOUT_MS = 4000;

/** After a failed fetch, don't retry on every render. */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

let lastFailureAt = 0;

/**
 * Exported so a hard-timeout test can call this directly without depending
 * on ExchangeRate table state. Note that from a server this currently never
 * succeeds - the feed sits behind bot protection that 403s every bare HTTP
 * client (see BPD_RATES_API_URL) - so in practice the rows getBpdRates()
 * reads come from the browser-driven scraper (scripts/scrape-bpd-rate.ts)
 * posting to /api/cron/bpd-rate/ingest. The on-demand path is kept as-is:
 * it costs one bounded, backed-off request and would start working again
 * the day the protection is lifted.
 */
export async function fetchBpdRates(): Promise<BpdRates | null> {
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null;
  try {
    const response = await fetch(BPD_RATES_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/json;odata=verbose" },
      signal: AbortSignal.timeout(BPD_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`bpd rates api responded ${response.status}`);
    const payload: unknown = await response.json();
    const parsed = parseBpdPayload(payload);
    if (!parsed) throw new Error("bpd rates api returned an unexpected payload");
    return parsed;
  } catch {
    lastFailureAt = Date.now();
    return null;
  }
}

export type StoreBpdRatesResult =
  | { ok: true }
  | { ok: false; reason: "out_of_range" | "invalid_as_of" | "outside_freshness_window" };

/**
 * The single place a source="bpd" ExchangeRate row is validated and written.
 * Both the on-demand fetch path (getBpdRates) and the scraper's ingestion
 * endpoint (/api/cron/bpd-rate/ingest) go through here, so the plausibility
 * bounds and the freshness window are enforced once, identically, no matter
 * where the rate came from. It re-checks the bounds itself even though every
 * caller already parsed the payload: a caller that trusted its own input is
 * exactly the drift this function exists to make impossible.
 *
 * Writes nothing unless every check passes - a rejection leaves the table
 * exactly as it was.
 */
export async function storeBpdRates(
  rates: BpdRates,
  now: Date = new Date(),
): Promise<StoreBpdRatesResult> {
  if (!isPlausibleDopRate(rates.dollarSellRate) || !isPlausibleDopRate(rates.euroSellRate)) {
    return { ok: false, reason: "out_of_range" };
  }
  if (!(rates.asOf instanceof Date) || Number.isNaN(rates.asOf.getTime())) {
    return { ok: false, reason: "invalid_as_of" };
  }
  if (!isWithinFreshnessWindow(rates.asOf, now)) {
    return { ok: false, reason: "outside_freshness_window" };
  }

  const entries = toRateTableEntries(rates);
  const fetchedAt = new Date();
  for (const [targetCurrency, rate] of Object.entries(entries)) {
    await prisma.exchangeRate.upsert({
      where: {
        baseCurrency_targetCurrency_source: {
          baseCurrency: BASE_CURRENCY,
          targetCurrency,
          source: BPD_SOURCE,
        },
      },
      update: { rate, fetchedAt, asOf: rates.asOf },
      create: {
        baseCurrency: BASE_CURRENCY,
        targetCurrency,
        source: BPD_SOURCE,
        rate,
        fetchedAt,
        asOf: rates.asOf,
      },
    });
  }
  return { ok: true };
}

/**
 * BPD-sourced DOP/USD and DOP/EUR sell rates, cached in ExchangeRate under
 * source="bpd" alongside (not overwriting) the open.er-api.com rows. The
 * bank republishes roughly once per business day but can go several days
 * without a new one, so a stored row whose `asOf` is within
 * BPD_RATE_MAX_AGE_DAYS of today is reused without a network call; only a
 * missing or out-of-window stored row triggers a fetch.
 *
 * Returns null on any failure - timeout, malformed response, an
 * out-of-range rate, or an asOf outside the freshness window - so
 * `getRateTable()` can fall back to open.er-api.com silently, never
 * throwing.
 */
export async function getBpdRates(): Promise<BpdRates | null> {
  const now = new Date();

  const stored = await prisma.exchangeRate.findMany({
    where: { baseCurrency: BASE_CURRENCY, source: BPD_SOURCE },
  });
  const dopRow = stored.find((row) => row.targetCurrency === "DOP");
  const eurRow = stored.find((row) => row.targetCurrency === "EUR");

  if (
    dopRow?.asOf &&
    eurRow?.asOf &&
    isWithinFreshnessWindow(dopRow.asOf, now) &&
    isWithinFreshnessWindow(eurRow.asOf, now)
  ) {
    const dollarSellRate = Number(dopRow.rate);
    const euroCrossRate = Number(eurRow.rate);
    if (isPlausibleDopRate(dollarSellRate) && euroCrossRate > 0) {
      // eurRow.rate is already the derived EUR-per-USD cross-rate (see
      // toRateTableEntries); euroSellRate is reconstructed only so this
      // returns the same shape fetchBpdRates does.
      return { dollarSellRate, euroSellRate: dollarSellRate / euroCrossRate, asOf: dopRow.asOf };
    }
  }

  const fetched = await fetchBpdRates();
  if (!fetched) return null;
  const persisted = await storeBpdRates(fetched, now);
  if (!persisted.ok) return null;

  return fetched;
}
