import { cache } from "react";

import { getSettings } from "@/lib/auth";
import { toCurrency, type CurrencyCode, type RateTable } from "@/lib/currency";
import { today } from "@/lib/date";
import { isLocale, type Locale } from "@/lib/i18n";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { getRateTable } from "@/lib/rates";
import {
  describeRecurringPosting,
  postDueRecurringItems,
} from "@/lib/recurring-posting";

export interface AppContext {
  displayCurrency: CurrencyCode;
  language: Locale;
  rates: RateTable;
  today: Date;
  currentPeriod: PeriodInfo;
}

/**
 * Per-request context every page starts from. Due recurring items are posted
 * here - the exact function the daily cron runs, never a second code path - so
 * opening the app on a day the cron did not reach still creates everything
 * that is due, and the "committed outflows" figure is always computed against
 * future occurrences. A posting failure is logged rather than taking every
 * page down; the next request (or the cron) simply retries.
 */
export const getAppContext = cache(async (): Promise<AppContext> => {
  const now = today();
  try {
    const posting = await postDueRecurringItems(now);
    if (posting.itemsPosted > 0 || posting.itemsFailed > 0) {
      console.log(describeRecurringPosting(posting));
    }
  } catch (error) {
    console.error("[recurring] catch-up posting failed", error);
  }
  const [settings, rates] = await Promise.all([getSettings(), getRateTable()]);
  return {
    displayCurrency: toCurrency(settings.displayCurrency),
    language: isLocale(settings.language) ? settings.language : "en",
    rates,
    today: now,
    currentPeriod: periodForDate(now),
  };
});
