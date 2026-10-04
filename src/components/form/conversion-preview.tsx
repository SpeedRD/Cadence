"use client";

import { chargedInAccount, rateLine, RatesUnavailableError, toAccountMoney, type MoneyRow } from "@/lib/account-money";
import { formatMoney, type RateTable } from "@/lib/currency";
import { getDictionary, type Locale } from "@/lib/i18n";
import { parseAmountInput } from "@/lib/money";

/**
 * What an amount typed in another currency than its account's will be saved
 * as (K7, src/lib/account-money.ts), before it is saved: the figure in the
 * account's currency and the rate, computed by the same function the server
 * stores it with. Nothing when the currencies agree or the amount does not
 * parse. `previous` is the row being edited, as stored: re-entering it keeps
 * its stored rate, and the line says so. With the bank's own figure typed in
 * `charged`, that is what is stored, at the rate it implies. Without a rate
 * fit to be stored for both currencies (`writableCurrencies`, R20) nothing is
 * converted: the
 * line asks for the amount in the account's currency, in `chargedLabel`'s
 * field, which is what the server will ask for too.
 */
export function ConversionPreview({
  amount,
  currency,
  accountCurrency,
  rates,
  previous,
  charged,
  chargedLabel,
  writableCurrencies,
  locale,
}: {
  /** The amount field's text, as typed. */
  amount: string;
  /** The "Amount charged in <account currency>" field's text, when the form has one: the bank's figure, stored as typed. */
  charged?: string;
  currency: string;
  accountCurrency: string | undefined;
  /** The request's rate table (RateTable.rates). */
  rates: RateTable["rates"];
  previous?: { row: MoneyRow; accountCurrency: string } | null;
  /** The label of the field that takes the amount in the account's currency, when the form has one. */
  chargedLabel?: string;
  /** The currencies the request's rates may be stored for (currenciesFitForWriting); absent: all of them. */
  writableCurrencies?: readonly string[];
  locale: Locale;
}) {
  if (!accountCurrency || currency === accountCurrency) return null;
  const parsed = parseAmountInput(amount);
  if (!parsed.ok || parsed.amount <= 0) return null;
  const t = getDictionary(locale).transactions;
  // The server's verdict on these two currencies, carried as a table that is
  // fit for every currency or for none but the base.
  const writable = !writableCurrencies || (writableCurrencies.includes(currency) && writableCurrencies.includes(accountCurrency));
  const table: RateTable = writable
    ? { rates, fetchedAt: null, stale: false, source: "bpd", asOf: new Date() }
    : { rates, fetchedAt: null, stale: true, source: "open-er-api", asOf: null };
  const chargedAmount = charged ? parseAmountInput(charged) : null;
  if (chargedAmount && chargedAmount.ok && chargedAmount.amount > 0) {
    const fixed = chargedInAccount({ amount: parsed.amount, currency }, accountCurrency, chargedAmount.amount);
    if (fixed.rate === null) return null;
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite" data-conversion-preview>
        {t.savedAsCharged(formatMoney(fixed.amount, fixed.currency), rateLine(currency, accountCurrency, fixed.rate))}
      </p>
    );
  }
  let stored;
  try {
    stored = toAccountMoney({ amount: parsed.amount, currency }, accountCurrency, table, previous);
  } catch (error) {
    if (error instanceof RatesUnavailableError && chargedLabel) {
      return (
        <p className="text-xs text-muted-foreground" aria-live="polite" data-conversion-preview data-rates-unavailable>
          {t.ratesUnavailableEnterInAccount(chargedLabel, accountCurrency)}
        </p>
      );
    }
    return null;
  }
  if (stored.rate === null) return null;
  const kept =
    previous?.accountCurrency === accountCurrency && previous.row.rate != null && previous.row.rate === stored.rate;
  const money = formatMoney(stored.amount, stored.currency);
  const rate = rateLine(currency, accountCurrency, stored.rate);
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite" data-conversion-preview>
      {kept ? t.savedAsKeptRate(money, rate) : t.savedAsTodaysRate(money, rate)}
    </p>
  );
}
