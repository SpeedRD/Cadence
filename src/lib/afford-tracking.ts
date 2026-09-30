/**
 * Pure helpers for the "still viable?" tracker over plans the Afford
 * calculator recorded (RecurringItem.fromAfford). No I/O: src/lib/data/afford.ts
 * re-runs Afford's two checks for each such plan and hands the verdict here,
 * where it is reduced to the one-line badge the Recurring page, the Dashboard
 * alert and the nav count all show. Kept free of Prisma so client components
 * can import the shapes.
 */
import { type AffordVerdict, type Installment } from "@/lib/afford";
import { round2 } from "@/lib/money";
import { scheduleDates } from "@/lib/period-commitments";
import { type ScheduledItem } from "@/lib/recurring";

/** The From Afford card's id on the Recurring page; the Dashboard alert and the nav badge link straight to it. */
export const FROM_AFFORD_SECTION_ID = "from-afford";
export const FROM_AFFORD_HREF = `/recurring#${FROM_AFFORD_SECTION_ID}`;

/**
 * The dates an installment plan still owes, one row per remaining occurrence:
 * the period commitments' own schedule walk (scheduleDates in
 * src/lib/period-commitments.ts), so the stored anchor day keeps a monthly
 * plan on the 31st through a short February, a row written outside the app
 * (no anchor) falls back to the date's own day, and an occurrence already
 * past `today` is owed now and filed under the current period - every one of
 * them, exactly as the commitments the re-check is judged against count them.
 * Each row carries the item's amount - the one figure it will post.
 */
export function remainingInstallments(
  item: ScheduledItem,
  amount: number,
  today: Date,
  currentPeriodKey: string,
): Installment[] {
  if (!item.remainingOccurrences || item.remainingOccurrences <= 0) return [];
  return scheduleDates(item, today, { currentPeriodKey }).map((date, index) => ({
    index: index + 1,
    date: date.dueDate,
    amount: round2(amount),
    periodKey: date.periodKey,
  }));
}

/**
 * What the badge says. "short" names the first period that fails and how far
 * short it falls there: the account's own shortfall in the account's currency
 * when its buffer check fails (the more specific of the two, and the one
 * Afford's shortfall list puts first), otherwise the period-wide shortfall in
 * the display currency.
 */
export type AffordViability =
  | { status: "on_track" }
  | {
      status: "short";
      periodKey: string;
      periodLabel: string;
      shortfall: number;
      currency: string;
      check: "account" | "flexible";
    };

export function summarizeAffordViability(verdict: AffordVerdict): AffordViability {
  const first = verdict.failing[0];
  if (!first) return { status: "on_track" };
  return first.account.passes
    ? {
        status: "short",
        periodKey: first.key,
        periodLabel: first.period.label,
        shortfall: first.flexible.shortfall,
        currency: first.flexible.currency,
        check: "flexible",
      }
    : {
        status: "short",
        periodKey: first.key,
        periodLabel: first.period.label,
        shortfall: first.account.shortfall,
        currency: first.account.currency,
        check: "account",
      };
}

/** One tracked plan: an active fromAfford item with payments left, re-checked. */
export interface AffordTrackedItem {
  itemId: string;
  name: string;
  verdict: AffordVerdict;
}

/** The tracked plans that no longer pass every remaining period - what the Dashboard alert lists and the nav badge counts. Order preserved. */
export function notViableAffordItems<T extends { verdict: AffordVerdict }>(items: T[]): T[] {
  return items.filter((item) => !item.verdict.viable);
}
