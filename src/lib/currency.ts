/**
 * Currency list and formatting. Adding a currency is a one-line change here -
 * currencies are stored as ISO codes, not as a database enum.
 */
export const CURRENCIES = ["USD", "DOP", "EUR"] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

export const BASE_CURRENCY: CurrencyCode = "USD";

export const CURRENCY_LABELS: Record<string, string> = {
  USD: "US Dollar",
  DOP: "Dominican Peso",
  EUR: "Euro",
};

export function isCurrency(value: unknown): value is CurrencyCode {
  return (
    typeof value === "string" && (CURRENCIES as readonly string[]).includes(value)
  );
}

export function toCurrency(value: unknown, fallback: CurrencyCode = BASE_CURRENCY) {
  return isCurrency(value) ? value : fallback;
}

/** Rates are USD-based: rate[X] = units of X per 1 USD. */
export interface RateTable {
  rates: Record<string, number>;
  fetchedAt: Date | null;
  stale: boolean;
}

export const IDENTITY_RATES: RateTable = {
  rates: Object.fromEntries(CURRENCIES.map((code) => [code, 1])),
  fetchedAt: null,
  stale: true,
};

/**
 * Raised when a rate table carries no usable rate for a currency `convert()`
 * was asked about. `getRateTable()` guarantees a positive rate for every code
 * in CURRENCIES, and every write path validates currency through
 * `z.enum(CURRENCIES)` in `src/lib/validation.ts`, so a table missing a rate
 * for a currency that reached a row is a data-integrity violation, not an
 * expected branch - hence a throw rather than a fallback value.
 */
/** The digest MissingRateError carries across the server/client boundary. */
export const MISSING_RATE_DIGEST = "CADENCE_MISSING_RATE";

export class MissingRateError extends Error {
  readonly currency: string;

  /**
   * Next.js replaces a server error's message with a generic one before handing
   * it to a client error boundary in production, but it forwards a digest the
   * error already carries rather than generating its own (see
   * next/dist/server/app-render/create-error-handler.js - the hash is only
   * computed when `err.digest` is unset). A stable digest is therefore what lets
   * src/app/(app)/error.tsx recognise this in a production build, not only in
   * development where the message survives.
   */
  readonly digest = MISSING_RATE_DIGEST;

  constructor(currency: string) {
    super(`No exchange rate available for ${currency}`);
    this.name = "MissingRateError";
    this.currency = currency;
  }
}

/**
 * Convert through USD, so a pair like EUR -> DOP works without a stored
 * EUR -> DOP rate: amount / rate[USD->from] * rate[USD->to].
 *
 * A missing or unusable rate throws instead of returning `amount` untouched:
 * returning it would let, say, a DOP row be summed into a USD total at face
 * value with nothing shown to the user - a wrong number is worse than a
 * failed render, and `confirmPaydayCheckin` would persist it.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  table: RateTable,
): number {
  if (from === to) return amount;
  const fromRate = table.rates[from];
  const toRate = table.rates[to];
  if (!isUsableRate(fromRate)) throw new MissingRateError(from);
  if (!isUsableRate(toRate)) throw new MissingRateError(to);
  return (amount / fromRate) * toRate;
}

/** A rate is usable only as a finite, strictly positive number. */
function isUsableRate(rate: number | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Whether `amount` in `currency` is the same money, to the cent, as `stored`
 * in `storedCurrency`. Lets a write path tell "the user retyped what was
 * already there, just shown in another currency" apart from a real edit, so
 * re-saving an unchanged field never re-denominates the stored row.
 */
export function isSameMoney(
  amount: number,
  currency: string,
  stored: number,
  storedCurrency: string,
  table: RateTable,
): boolean {
  return Math.abs(convert(stored, storedCurrency, currency, table) - amount) < 0.005;
}

export function formatMoney(
  amount: number,
  currency: string,
  options: { maximumFractionDigits?: number; signDisplay?: "auto" | "never" | "always" } = {},
): string {
  const { maximumFractionDigits = 2, signDisplay = "auto" } = options;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: maximumFractionDigits === 0 ? 0 : 2,
    maximumFractionDigits,
    signDisplay,
  }).format(amount);
}

/** Whole-unit figure for dense UI (headline numbers, chart axes). */
export function formatMoneyCompact(amount: number, currency: string): string {
  return formatMoney(amount, currency, { maximumFractionDigits: 0 });
}

export function formatRate(rate: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(rate);
}
