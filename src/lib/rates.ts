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
    return {
      rates: Object.fromEntries(
        CURRENCIES.map((code) => [code, num(byTarget.get(code)?.rate)]),
      ),
      fetchedAt: byTarget.get(BASE_CURRENCY)?.fetchedAt ?? null,
      stale: false,
    };
  }

  const fetched = await fetchUsdRates();
  if (fetched) {
    const fetchedAt = new Date();
    const rates: Record<string, number> = {};
    for (const code of CURRENCIES) {
      const rate = code === BASE_CURRENCY ? 1 : fetched[code];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
      rates[code] = rate;
      await prisma.exchangeRate.upsert({
        where: {
          baseCurrency_targetCurrency: {
            baseCurrency: BASE_CURRENCY,
            targetCurrency: code,
          },
        },
        update: { rate, fetchedAt },
        create: {
          baseCurrency: BASE_CURRENCY,
          targetCurrency: code,
          rate,
          fetchedAt,
        },
      });
    }
    if (Object.keys(rates).length > 0) {
      return { rates, fetchedAt, stale: false };
    }
  }

  // Fetch failed: keep using whatever we have, flagged as stale.
  if (stored.length > 0) {
    const rates = Object.fromEntries(
      CURRENCIES.map((code) => [
        code,
        num(byTarget.get(code)?.rate) || FALLBACK_RATES[code] || 1,
      ]),
    );
    const newest = stored.reduce(
      (latest, row) => (row.fetchedAt > latest ? row.fetchedAt : latest),
      stored[0].fetchedAt,
    );
    return { rates, fetchedAt: newest, stale: true };
  }

  return { ...IDENTITY_RATES, rates: { ...FALLBACK_RATES } };
}
