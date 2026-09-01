import { cache } from "react";

import { getSettings } from "@/lib/auth";
import { toCurrency, type CurrencyCode, type RateTable } from "@/lib/currency";
import { today } from "@/lib/date";
import { isLocale, type Locale } from "@/lib/i18n";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { getRateTable } from "@/lib/rates";
import { advanceDueRecurringItems } from "@/lib/recurring";

export interface AppContext {
  displayCurrency: CurrencyCode;
  language: Locale;
  rates: RateTable;
  today: Date;
  currentPeriod: PeriodInfo;
}

/**
 * Per-request context every page starts from. Rolling overdue recurring items
 * forward happens here so the "committed outflows" figure is always computed
 * against future occurrences.
 */
export const getAppContext = cache(async (): Promise<AppContext> => {
  const now = today();
  await advanceDueRecurringItems(now);
  const [settings, rates] = await Promise.all([getSettings(), getRateTable()]);
  return {
    displayCurrency: toCurrency(settings.displayCurrency),
    language: isLocale(settings.language) ? settings.language : "en",
    rates,
    today: now,
    currentPeriod: periodForDate(now),
  };
});
