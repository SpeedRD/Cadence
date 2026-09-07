/**
 * Pure calculation logic for the Afford calculator: can a purchase paid in
 * installments be carried by the pay periods its installments fall in?
 *
 * No I/O here. src/lib/data/afford.ts assembles the per-period projections
 * from history and calls evaluateAffordability(); the "I bought this" action
 * runs the very same evaluation server-side before it writes anything, so the
 * verdict the user acknowledged is the one that gates the write.
 *
 * Two checks per affected period, both against *projected* figures - there is
 * no confirmed payday check-in for a period that has not happened yet:
 *
 *   account buffer   the chosen account's projected income, less what its
 *                    recurring items owe in the period, less this purchase's
 *                    installment(s) due in the period, must stay at or above
 *                    that account's own protected buffer (the same
 *                    defaultProtectedBuffer() the check-in applies per account).
 *   flexible room    the period's projected available-for-flexible - income
 *                    across every active account, less every recurring item
 *                    due in the period and every account's buffer, the app's
 *                    own definition in
 *                    availableForFlexibleCategories() - less the installment(s),
 *                    must stay non-negative.
 *
 * Installments landing in the same period are summed before either check runs;
 * a period is never judged one installment at a time.
 */
import { convert, type RateTable } from "@/lib/currency";
import { startOfDay } from "@/lib/date";
import { round2 } from "@/lib/money";
import { availableForFlexibleCategories } from "@/lib/payday";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { advanceDate } from "@/lib/recurring";

import type { RecurringFrequency } from "@/generated/prisma/enums";

/** The most installments one purchase can be split into (ten years of monthly payments). */
export const MAX_INSTALLMENTS = 120;

/**
 * The one amount every installment is: `total` divided into `count` equal
 * parts, rounded to the cent. Every row of the schedule, every figure the
 * checks subtract and the amount the RecurringItem posts are this same number,
 * so nothing the calculator evaluated can differ from what later posts.
 * Rounding can leave the parts a few cents off the entered price
 * (100 / 3 -> 33.33 x 3 = 99.99); the schedule shows that difference rather
 * than hiding it in a larger last installment, which a single-amount
 * recurring item could never post. 0 when there is nothing to split.
 */
export function equalInstallmentAmount(total: number, count: number): number {
  if (count <= 0 || !Number.isFinite(total) || total <= 0) return 0;
  return round2(total / count);
}

/**
 * The due date of each installment: `firstDate`, then advanceDate() applied
 * with the first date's own day as the anchor - exactly the walk posting will
 * take once the plan is a RecurringItem, so the calculator and the ledger
 * agree on every date (Jan 31 -> Feb 28 -> Mar 31, never Mar 28).
 */
export function installmentDates(
  firstDate: Date,
  frequency: RecurringFrequency,
  count: number,
): Date[] {
  const anchorDay = firstDate.getUTCDate();
  const dates: Date[] = [];
  let cursor = startOfDay(firstDate);
  for (let i = 0; i < count; i += 1) {
    dates.push(cursor);
    cursor = advanceDate(cursor, frequency, anchorDay);
  }
  return dates;
}

export interface Installment {
  /** 1-based position in the plan. */
  index: number;
  date: Date;
  /** In the purchase's currency. */
  amount: number;
  /** periodForDate(date).key - which pay period carries this installment. */
  periodKey: string;
}

/** One installment per date, each for the same `amount`, tagged with the pay period it lands in. */
export function buildInstallments(dates: Date[], amount: number): Installment[] {
  return dates.map((date, i) => ({
    index: i + 1,
    date,
    amount: round2(amount),
    periodKey: periodForDate(date).key,
  }));
}

/** Everything a period's two checks need, as projected by src/lib/data/afford.ts. */
export interface PeriodProjection {
  period: PeriodInfo;
  /** The chosen account's own figures, in its own currency. */
  account: {
    accountId: string;
    name: string;
    currency: string;
    /** Comparable-period average of what this account received. */
    income: number;
    /** What the active recurring items charged to this account owe in the period, enumerated from their schedules - exact, never an average. */
    committed: number;
    /** defaultProtectedBuffer() over `income`. */
    buffer: number;
    /** "none" when no comparable period had any income for this account - the projection is then a floor, not an average. */
    basis: "average" | "none";
  };
  /** The whole period across every active account, in the display currency. */
  flexible: {
    currency: string;
    income: number;
    /** Every active recurring item's occurrences due in the period, whichever account (or none) funds it. */
    committed: number;
    /** Every income-receiving account's buffer, summed - the check-in's plannedBuffer. */
    buffer: number;
  };
  /** How many comparable periods were averaged (the newest has the most weight only in that it is guaranteed to be included). */
  historyPeriods: number;
}

export interface AccountCheck {
  accountId: string;
  name: string;
  currency: string;
  income: number;
  committed: number;
  buffer: number;
  basis: "average" | "none";
  /** income - committed - buffer: the room above the buffer before this purchase. */
  headroomBefore: number;
  /** This purchase's installment(s) due in the period, in the account's currency. */
  installment: number;
  headroomAfter: number;
  passes: boolean;
  /** How far below its buffer the account would land - 0 when it stays above. */
  shortfall: number;
}

export interface FlexibleCheck {
  currency: string;
  income: number;
  committed: number;
  buffer: number;
  availableBefore: number;
  /** In the display currency. */
  installment: number;
  availableAfter: number;
  passes: boolean;
  shortfall: number;
}

export interface PeriodVerdict {
  key: string;
  period: PeriodInfo;
  /** Every installment of this purchase that lands in the period, in plan order. */
  installments: Installment[];
  /** Their sum, in the purchase's currency - what both checks subtract. */
  installmentTotal: number;
  account: AccountCheck;
  flexible: FlexibleCheck;
  passes: boolean;
}

export interface AffordVerdict {
  viable: boolean;
  /** The purchase's currency, which every installment amount is in. */
  currency: string;
  installments: Installment[];
  /** One per affected period, earliest first. */
  periods: PeriodVerdict[];
  /** The periods that fail either check, earliest first. */
  failing: PeriodVerdict[];
}

/** Sum of each period's installments, keyed by period; a period with none is absent. */
export function installmentTotalsByPeriod(installments: Installment[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const installment of installments) {
    totals.set(installment.periodKey, round2((totals.get(installment.periodKey) ?? 0) + installment.amount));
  }
  return totals;
}

/**
 * Judges every affected period and the purchase as a whole. `projections`
 * must hold an entry for each period key the installments touch; a missing
 * one is a programming error rather than a shortfall, so it throws.
 */
export function evaluateAffordability(input: {
  installments: Installment[];
  currency: string;
  projections: Map<string, PeriodProjection>;
  rates: RateTable;
}): AffordVerdict {
  const { installments, currency, projections, rates } = input;
  const totals = installmentTotalsByPeriod(installments);
  const keys = [...totals.keys()].sort();

  const periods: PeriodVerdict[] = keys.map((key) => {
    const projection = projections.get(key);
    if (!projection) throw new Error(`No projection for period ${key}`);
    const installmentTotal = totals.get(key) ?? 0;
    const own = installments.filter((installment) => installment.periodKey === key);

    const accountInstallment = round2(
      convert(installmentTotal, currency, projection.account.currency, rates),
    );
    const headroomBefore = round2(
      projection.account.income - projection.account.committed - projection.account.buffer,
    );
    const headroomAfter = round2(headroomBefore - accountInstallment);
    const account: AccountCheck = {
      accountId: projection.account.accountId,
      name: projection.account.name,
      currency: projection.account.currency,
      income: projection.account.income,
      committed: projection.account.committed,
      buffer: projection.account.buffer,
      basis: projection.account.basis,
      headroomBefore,
      installment: accountInstallment,
      headroomAfter,
      passes: headroomAfter >= 0,
      shortfall: headroomAfter < 0 ? round2(-headroomAfter) : 0,
    };

    // The check-in's own formula. Carryover, goal plans and essential
    // categories are chosen at check-in time and are not commitments the
    // period already carries, so they enter as zero; what history can
    // predict - income, scheduled charges, the buffer - is what is projected.
    const availableBefore = availableForFlexibleCategories({
      income: projection.flexible.income,
      includedCarryover: 0,
      subscriptions: projection.flexible.committed,
      recurringContributions: 0,
      goalPlan: 0,
      essentialFixed: 0,
      buffer: projection.flexible.buffer,
    });
    const flexibleInstallment = round2(
      convert(installmentTotal, currency, projection.flexible.currency, rates),
    );
    const availableAfter = round2(availableBefore - flexibleInstallment);
    const flexible: FlexibleCheck = {
      currency: projection.flexible.currency,
      income: projection.flexible.income,
      committed: projection.flexible.committed,
      buffer: projection.flexible.buffer,
      availableBefore,
      installment: flexibleInstallment,
      availableAfter,
      passes: availableAfter >= 0,
      shortfall: availableAfter < 0 ? round2(-availableAfter) : 0,
    };

    return {
      key,
      period: projection.period,
      installments: own,
      installmentTotal,
      account,
      flexible,
      passes: account.passes && flexible.passes,
    };
  });

  const failing = periods.filter((period) => !period.passes);
  return {
    viable: failing.length === 0,
    currency,
    installments,
    periods,
    failing,
  };
}

