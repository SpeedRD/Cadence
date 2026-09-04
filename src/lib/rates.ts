import {
  BASE_CURRENCY,
  CURRENCIES,
  IDENTITY_RATES,
  type RateTable,
} from "@/lib/currency";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

const RATE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_API_URL = "https://open.er-api.com/v6/latest/USD";
const FETCH_TIMEOUT_MS = 6000;
/** After a failed fetch, don't hammer the API on every render. */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

/** Last resort if the API is unreachable and nothing has ever been stored. */
const FALLBACK_RATES: Record<string, number> = { USD: 1, DOP: 60, EUR: 0.92 };

let lastFailureAt = 0;

interface RateApiResponse {
  result?: string;
  rates?: Record<string, number>;
}

/** A rate is usable only as a finite, strictly positive number. */
function isUsableRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/** Whatever we have for `code`, or the hardcoded constant - never 0. */
function usableOrFallback(rate: unknown, code: string): number {
  return isUsableRate(rate) ? rate : FALLBACK_RATES[code] ?? 1;
}

async function fetchUsdRates(): Promise<Record<string, number> | null> {
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null;
  try {
    const response = await fetch(RATE_API_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`rate api responded ${response.status}`);
    const payload = (await response.json()) as RateApiResponse;
    if (payload.result !== "success" || !payload.rates) {
      throw new Error("rate api returned an unexpected payload");
    }
    return payload.rates;
  } catch {
    lastFailureAt = Date.now();
    return null;
  }
}

/**
 * USD-based rates, cached in ExchangeRate for 24 hours. Only the raw USD pairs
 * are stored; cross-currency conversion is derived in `convert()`.
 *
 * Invariant: every path out of this function returns a table holding a finite,
 * strictly positive rate for every code in CURRENCIES. `convert()` throws on a
 * missing rate rather than passing an amount through unconverted, so a partial
 * table here would take pages down; more importantly, a partial table returned
 * as fresh is how one currency's rows end up summed into another currency's
 * total at face value. A payload or a stored set that cannot satisfy the
 * invariant is downgraded (to the stale stored values, then to
 * FALLBACK_RATES), never emitted with a hole in it.
 */
export async function getRateTable(): Promise<RateTable> {
  const stored = await prisma.exchangeRate.findMany({
    where: { baseCurrency: BASE_CURRENCY },
  });
  const byTarget = new Map(stored.map((row) => [row.targetCurrency, row]));
  const now = Date.now();
  const isFresh = CURRENCIES.every((code) => {
    const row = byTarget.get(code);
    return row ? now - row.fetchedAt.getTime() < RATE_TTL_MS : false;
  });

  if (isFresh) {
    // A row can be inside the TTL and still unusable (a 0 or negative rate).
    // Substituting the constant keeps the invariant, but the table then no
    // longer says what the service said, so it is not presented as fresh.
    const rates: Record<string, number> = {};
    let substituted = false;
    for (const code of CURRENCIES) {
      const storedRate = num(byTarget.get(code)?.rate);
      if (!isUsableRate(storedRate)) substituted = true;
      rates[code] = usableOrFallback(storedRate, code);
    }
    return {
      rates,
      fetchedAt: byTarget.get(BASE_CURRENCY)?.fetchedAt ?? null,
      stale: substituted,
    };
  }

  const fetched = await fetchUsdRates();
  if (fetched) {
    const rates: Record<string, number> = {};
    for (const code of CURRENCIES) {
      const rate = code === BASE_CURRENCY ? 1 : fetched[code];
      if (isUsableRate(rate)) rates[code] = rate;
    }
    if (Object.keys(rates).length === CURRENCIES.length) {
      const fetchedAt = new Date();
      for (const code of CURRENCIES) {
        await prisma.exchangeRate.upsert({
          where: {
            baseCurrency_targetCurrency: {
              baseCurrency: BASE_CURRENCY,
              targetCurrency: code,
            },
          },
          update: { rate: rates[code], fetchedAt },
          create: {
            baseCurrency: BASE_CURRENCY,
            targetCurrency: code,
            rate: rates[code],
            fetchedAt,
          },
        });
      }
      return { rates, fetchedAt, stale: false };
    }
    // The payload omitted (or zeroed) a currency we display. Half of it stored
    // and returned as fresh would silently mix denominations, so treat it as a
    // failed fetch: nothing is written, the backoff is set exactly as a thrown
    // fetch sets it, and we fall through to the stored/stale values below.
    lastFailureAt = Date.now();
  }

  // Fetch failed: keep using whatever we have, flagged as stale.
  if (stored.length > 0) {
    const rates = Object.fromEntries(
      CURRENCIES.map((code) => [
        code,
        usableOrFallback(num(byTarget.get(code)?.rate), code),
      ]),
    );
    const newest = stored.reduce(
      (latest, row) => (row.fetchedAt > latest ? row.fetchedAt : latest),
      stored[0].fetchedAt,
    );
    return { rates, fetchedAt: newest, stale: true };
  }

  // Nothing stored and nothing fetched: hardcoded constants, flagged stale so
  // the shell can tell the user every converted figure is an estimate.
  return {
    ...IDENTITY_RATES,
    rates: Object.fromEntries(
      CURRENCIES.map((code) => [code, FALLBACK_RATES[code] ?? 1]),
    ),
  };
}
