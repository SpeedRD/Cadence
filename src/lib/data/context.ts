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
  type RecurringPostingSummary,
} from "@/lib/recurring-posting";

/** Why a whole posting run threw, as the Inbox states it. */
export interface RecurringPostingFailure {
  reason: string;
}

/**
 * The reason an error is shown with: the last non-empty line of its message
 * (Prisma puts the cause there, after the invocation and a code excerpt),
 * capped so one row stays a row.
 */
export function postingFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? message).slice(0, 300);
}

export interface AppContext {
  displayCurrency: CurrencyCode;
  language: Locale;
  rates: RateTable;
  today: Date;
  currentPeriod: PeriodInfo;
  /**
   * What this request's catch-up posting did, so a page can show the items
   * that are not posting rather than leaving them to the server log. Skipped
   * and failed items are never advanced, so every later request re-reports
   * them until the user fixes the item. Optional: callers that build a context
   * by hand (scripts) have no posting run behind them.
   */
  recurringPosting?: RecurringPostingSummary | null;
  /**
   * Set when the whole catch-up run threw (in which case recurringPosting is
   * null): nothing was posted this request, and the Inbox says so. Null or
   * absent when the run completed, whatever its per-item results. Additive:
   * nothing that read the context before reads this.
   */
  recurringPostingFailure?: RecurringPostingFailure | null;
  /**
   * Settings.incomeHistoryStartDate - "count income history from". A
   * comparable pay period that ended before it is left out of Afford's income
   * projection and the payday planner's category averages. Optional, like
   * recurringPosting, so a context built by hand (scripts) is unbounded; null
   * or absent means no boundary.
   */
  incomeHistoryStartDate?: Date | null;
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

  const runRecurringPosting = async (): Promise<{
    summary: RecurringPostingSummary | null;
    failure: RecurringPostingFailure | null;
  }> => {
    try {
      const summary = await postDueRecurringItems(now);
      if (summary.itemsPosted > 0 || summary.itemsFailed > 0) {
        console.log(describeRecurringPosting(summary));
      }
      return { summary, failure: null };
    } catch (error) {
      console.error("[recurring] catch-up posting failed", error);
      return { summary: null, failure: { reason: postingFailureReason(error) } };
    }
  };

  const [{ summary: recurringPosting, failure: recurringPostingFailure }, settings, rates] = await Promise.all([
    runRecurringPosting(),
    getSettings(),
    getRateTable(),
  ]);
  return {
    displayCurrency: toCurrency(settings.displayCurrency),
    language: isLocale(settings.language) ? settings.language : "en",
    rates,
    today: now,
    currentPeriod: periodForDate(now),
    recurringPosting,
    recurringPostingFailure,
    incomeHistoryStartDate: settings.incomeHistoryStartDate,
  };
});
