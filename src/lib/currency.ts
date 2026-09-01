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
 * Convert through USD, so a pair like EUR -> DOP works without a stored
 * EUR -> DOP rate: amount / rate[USD->from] * rate[USD->to].
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
  if (!fromRate || !toRate) return amount;
  return (amount / fromRate) * toRate;
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
