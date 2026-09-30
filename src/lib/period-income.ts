/**
 * Period income, fact and estimate (QUANTITIES_MAP.md K5): which period a
 * deposit counts in, and which deposits an estimate of future income reads.
 *
 * One attribution. A deposit counts in the period it funds: the period whose
 * income window it falls in (incomeWindow in src/lib/period.ts), which opens
 * before the period's first day - at the earlier of its payday and
 * PAYCHECK_LEAD_DAYS before it - because pay lands on the last business day
 * before a period, and banks often pay a day or two earlier still. The same
 * window bounds a check-in paycheck's duplicate check (paycheckWindow), and
 * the deposit it attributes to a period is what opens that period's goal
 * money (fundingWindow, from the day the pay landed). A check-in's paycheck
 * counts in the period its check-in planned, whatever day it was entered: its
 * snapshot stands for it, and its PAYDAY_CHECKIN row is never counted a
 * second time. A paycheck brought in by CSV or typed by hand is put to the
 * user when it may be a check-in's paycheck already recorded
 * (planPostedDuplicates), so one paycheck is one row.
 * Income the user marked as one-off and a deposit paying back a shared
 * expense are not pay for a period: they count by the day they arrived.
 *
 *   fact      every deposit. What the period received: the hero, Reports and
 *             the check-in's own history.
 *   estimate  what the next periods can expect: one-off income
 *             (Transaction.isOneOffIncome), deposits paying back a shared
 *             expense (Transaction.reimbursesTransactionId) and the one-off
 *             part of a check-in paycheck (PaydayAccountSnapshot.oneOffIncome)
 *             are left out. Afford, the subscription-room check, the From
 *             Afford tracker and the goal forecast average it.
 *
 * The Transactions and account pages read deposits by date instead - a
 * statement of the ledger - and say so on the page.
 *
 * Pure - no Prisma - so scripts/verify-domain.ts can check it directly; the
 * loader is src/lib/data/period-income.ts.
 */
import { fundedPeriodFor, periodForDate, type PeriodInfo } from "@/lib/period";
import { reimbursedExpenseIdFromTransaction } from "@/lib/transactions";

export type IncomeBasis = "fact" | "estimate";

/** An INCOME row as the attribution reads it. */
export interface IncomeRow {
  accountId: string;
  date: Date;
  amount: number;
  currency: string;
  source: string;
  type: string;
  isOneOffIncome: boolean;
  reimbursesTransactionId: string | null;
}

/** One account's paycheck on a confirmed check-in. */
export interface IncomeSnapshot {
  accountId: string;
  incomeEntered: number;
  /** The part of it the user said is one-off; null (a snapshot from before the field) reads as 0. */
  oneOffIncome: number | null;
  currency: string;
}

/**
 * The period an INCOME row counts in: an ordinary deposit, the period it
 * funds (fundedPeriodFor in src/lib/period.ts); one-off income or a payback of a shared expense,
 * the period of its date.
 */
export function incomePeriodFor(row: Pick<IncomeRow, "date" | "type" | "isOneOffIncome" | "reimbursesTransactionId">): PeriodInfo {
  if (row.isOneOffIncome || reimbursedExpenseIdFromTransaction(row) !== null) return periodForDate(row.date);
  return fundedPeriodFor(row.date);
}

/**
 * Whether an INCOME row counts on `basis`. A check-in's paycheck row never
 * does: its snapshot is counted instead (snapshotIncome), in the period the
 * check-in planned.
 */
export function rowCountsAsIncome(row: IncomeRow, basis: IncomeBasis): boolean {
  if (row.source === "PAYDAY_CHECKIN") return false;
  if (basis === "fact") return true;
  return !row.isOneOffIncome && reimbursedExpenseIdFromTransaction(row) === null;
}

/** What a check-in paycheck adds on `basis`, in the snapshot's currency. */
export function snapshotIncome(snapshot: IncomeSnapshot, basis: IncomeBasis): number {
  if (basis === "fact") return snapshot.incomeEntered;
  return Math.max(0, snapshot.incomeEntered - (snapshot.oneOffIncome ?? 0));
}

/**
 * Why a one-off part is not acceptable for a paycheck of `income`, or null
 * when it is: 0 up to the whole paycheck. Messages are the form's validation
 * vocabulary, translated by firstError() in src/lib/validation.ts.
 */
export function oneOffIncomeIssue(income: number, oneOff: number): string | null {
  if (!Number.isFinite(oneOff) || oneOff < 0) return "Enter 0 or more";
  if (oneOff > income) return "The one-off part cannot be more than the income";
  return null;
}
