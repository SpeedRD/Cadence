import { BASE_CURRENCY } from "@/lib/currency";
import { prisma } from "@/lib/prisma";

/**
 * Banco Popular Dominicano's public rates feed, confirmed by manual
 * investigation (2026-09-16) to return the bank's real daily buy/sell rates
 * as plain JSON - no auth, no CAPTCHA - but only when hit with a browser-like
 * fetch; a bare HTTP client can have its request go unanswered indefinitely
 * after a completed TLS handshake. Preferred over open.er-api.com for DOP and
 * EUR because it's the bank's own published rate, not a market aggregator's.
 */
const BPD_RATES_API_URL =
  "https://popularenlinea.com/_api/web/lists/getbytitle('Rates')/items?$filter=ItemID%20eq%20'1'";

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

export const BPD_SOURCE = "bpd";

/**
 * Banco Popular's published DOP/USD and DOP/EUR sell rates are both
 * historically in this band; a value outside it is treated as a malformed or
 * unpublished payload rather than trusted. Mirrors the DOP: 60 midpoint
 * FALLBACK_RATES already uses in src/lib/rates.ts - there's no narrower
 * existing bound in this codebase to reuse instead.
 */
const MIN_PLAUSIBLE_DOP_RATE = 55;
const MAX_PLAUSIBLE_DOP_RATE = 75;

let lastFailureAt = 0;

export interface BpdRates {
  /** DOP paid per 1 USD sold to a customer ("Vendemos"). */
  dollarSellRate: number;
  /** DOP paid per 1 EUR sold to a customer ("Vendemos"). */
  euroSellRate: number;
  /** The calendar day BPD says these rates are published for. */
  asOf: Date;
}

function isPlausibleDopRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_DOP_RATE &&
    value <= MAX_PLAUSIBLE_DOP_RATE
  );
}

/** Same calendar day in UTC - BuySellRatesAsOf and "today" are both compared this way throughout this module. */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Validates and extracts the fields this app uses from BPD's SharePoint list
 * response. Pure and network-free so it can be exercised directly against a
 * fabricated payload; the network fetch itself lives in `fetchBpdRates`.
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
  if (!isPlausibleDopRate(dollarSellRate) || !isPlausibleDopRate(euroSellRate)) {
    return null;
  }
  if (typeof asOfRaw !== "string") return null;
  const asOf = new Date(asOfRaw);
  if (Number.isNaN(asOf.getTime())) return null;

  return { dollarSellRate, euroSellRate, asOf };
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

/** Exported so a hard-timeout test can call this directly without depending on ExchangeRate table state. */
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

/**
 * Same-day BPD-sourced DOP/USD and DOP/EUR sell rates, cached in
 * ExchangeRate under source="bpd" alongside (not overwriting) the
 * open.er-api.com rows. The bank republishes once per business day, so a
 * stored row whose `asOf` is today is reused without a network call; only a
 * missing or stale stored row triggers a fetch.
 *
 * Returns null on any failure - timeout, malformed response, an
 * out-of-range rate, or an asOf that isn't today - so `getRateTable()` can
 * fall back to open.er-api.com silently, never throwing.
 */
export async function getBpdRates(): Promise<BpdRates | null> {
  const now = new Date();

  const stored = await prisma.exchangeRate.findMany({
    where: { baseCurrency: BASE_CURRENCY, source: BPD_SOURCE },
  });
  const dopRow = stored.find((row) => row.targetCurrency === "DOP");
  const eurRow = stored.find((row) => row.targetCurrency === "EUR");

  if (dopRow?.asOf && eurRow?.asOf && isSameUtcDay(dopRow.asOf, now) && isSameUtcDay(eurRow.asOf, now)) {
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
  if (!isSameUtcDay(fetched.asOf, now)) return null;

  const entries = toRateTableEntries(fetched);
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
      update: { rate, fetchedAt, asOf: fetched.asOf },
      create: {
        baseCurrency: BASE_CURRENCY,
        targetCurrency,
        source: BPD_SOURCE,
        rate,
        fetchedAt,
        asOf: fetched.asOf,
      },
    });
  }

  return fetched;
}
