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
 * second time. Deposits the ledger already held for the period when the
 * check-in was confirmed are adopted, not recorded again: they count as the
 * rows they are, and the snapshot only for the part of the paycheck beyond
 * them (IncomeSnapshot.adoptedIncome). A paycheck brought in by CSV or typed
 * by hand after the check-in is put to the user when it may be a check-in's
 * paycheck already recorded (planPostedDuplicates), so one paycheck is one
 * row.
 * Income the user marked as one-off and a deposit paying back a shared
 * expense are not pay for a period: they count by the day they arrived.
 *
 *   fact      every deposit. What the period received: the hero, Reports and
 *             the check-in's own history.
 *   estimate  what the next periods can expect: one-off income
 *             (Transaction.isOneOffIncome), deposits paying back a shared
 *             expense (Transaction.reimbursesTransactionId), the one-off
 *             part of a check-in paycheck (PaydayAccountSnapshot.oneOffIncome)
 *             and the part of a deposit earmarked for a recurring payment
 *             (RecurringEarmark, src/lib/earmarks.ts) are left out. Afford,
 *             the subscription-room check, the From Afford tracker and the
 *             goal forecast average it. An earmarked part already lowers what
 *             its occurrence asks of the plan; counted as income as well, the
 *             same money would be counted twice. Only the part that still
 *             lowers one is left out: an occurrence that shrank, or is no
 *             longer due, hands the rest back to the estimate.
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
  /**
   * What of it the user earmarked for recurring payments that still covers an
   * occurrence's cost (K2's effective earmark, loadDepositCover), in
   * `currency` (0 or absent: none).
   */
  earmarked?: number;
}

/** One account's paycheck on a confirmed check-in. */
export interface IncomeSnapshot {
  accountId: string;
  incomeEntered: number;
  /** The part of it the user said is one-off; null (a snapshot from before the field) reads as 0. */
  oneOffIncome: number | null;
  /**
   * The part of it deposits already in the ledger held when it was confirmed
   * (PaydayAccountSnapshot.adoptedIncome): those rows count themselves, in the
   * same period. Null or absent (a snapshot from before the field) reads as 0.
   */
  adoptedIncome?: number | null;
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

/**
 * What an INCOME row adds on `basis`, in its currency, once it counts
 * (rowCountsAsIncome): all of it as a fact, less its earmarked part as an
 * estimate.
 */
export function rowIncome(row: IncomeRow, basis: IncomeBasis): number {
  if (basis === "fact") return row.amount;
  return Math.max(0, row.amount - Math.max(0, row.earmarked ?? 0));
}

/**
 * What a check-in paycheck adds on `basis`, in the snapshot's currency: the
 * part of it the check-in recorded itself, beyond the deposits it adopted
 * (those count as rows). As an estimate its one-off part is left out too; a
 * one-off part larger than that own part comes out of the adopted deposits,
 * which count in the same period, so the figure can go below 0 by as much as
 * they hold - never more.
 */
export function snapshotIncome(snapshot: IncomeSnapshot, basis: IncomeBasis): number {
  const adopted = Math.max(0, snapshot.adoptedIncome ?? 0);
  const own = snapshot.incomeEntered - adopted;
  if (basis === "fact") return own;
  return Math.max(-adopted, own - (snapshot.oneOffIncome ?? 0));
}

/** A confirmed snapshot's paycheck as paycheckNow reads it, amounts in the account's currency. */
export interface ConfirmedPaycheck {
  incomeEntered: number;
  /** Null or absent reads as 0. */
  adoptedIncome?: number | null;
  /** PaydayAccountSnapshot.adoptedTransactionIds; empty on a snapshot written before it was kept. */
  adoptedTransactionIds?: readonly string[] | null;
}

/**
 * Whether a snapshot adopted deposits without recording which (written
 * before PaydayAccountSnapshot.adoptedTransactionIds): its paycheck cannot
 * follow them, so it stays as confirmed.
 */
export function adoptedWithoutIds(snapshot: ConfirmedPaycheck): boolean {
  return (snapshot.adoptedIncome ?? 0) > 0 && (snapshot.adoptedTransactionIds ?? []).length === 0;
}

/**
 * What a confirmed check-in's paycheck on one account stands at now (S7): the
 * part it recorded as its own row (incomeEntered - adoptedIncome), plus what
 * each deposit it adopted is as pay today - `payNow(id)`, the deposit as
 * Step 2 would list it now (loadLedgerDeposits): its amount less what an
 * earmark still covers, and 0 once it is deleted, marked one-off, fully
 * earmarked or moved out of the period or the account. So an earmark raised
 * or lowered on an adopted deposit, or a payment it covers changed, moves
 * money between the plan's income and its commitments and leaves its room
 * as it was. A deposit that arrived after the confirmation is not in it
 * until the check-in is confirmed again. A snapshot that adopted nothing, or
 * did without recording which deposits (adoptedWithoutIds), is as confirmed.
 */
export function paycheckNow(snapshot: ConfirmedPaycheck, payNow: (transactionId: string) => number): number {
  const ids = snapshot.adoptedTransactionIds ?? [];
  if (ids.length === 0) return snapshot.incomeEntered;
  const own = snapshot.incomeEntered - Math.max(0, snapshot.adoptedIncome ?? 0);
  return Math.round((own + ids.reduce((sum, id) => sum + payNow(id), 0)) * 100) / 100;
}

/**
 * A confirmed check-in's adoption on one account: the income window of the
 * period it planned, on an account whose snapshot adopted deposits the
 * ledger already held (PaydayAccountSnapshot.adoptedIncome > 0) without
 * recording which (adoptedWithoutIds).
 */
export interface AdoptedWindow {
  accountId: string;
  from: Date;
  /** Exclusive. */
  until: Date;
  /**
   * When the check-in was last confirmed (its updatedAt, which settling or
   * adjusting a carryover leaves alone): only a deposit that existed then is
   * in the paycheck it adopted.
   */
  confirmedAt: Date;
}

/**
 * Whether a deposit may be pay a confirmed check-in adopted with its income
 * frozen: an ordinary INCOME row - not a check-in's own paycheck row, not
 * one-off income, not a payback of a shared expense, the rows Step 2 lists -
 * dated in an adoption window on its account (a snapshot that adopted
 * deposits without recording which, adoptedWithoutIds), and already in the
 * ledger when that check-in was last confirmed. That plan's income cannot
 * follow the deposit (paycheckNow), so earmarking it for a recurring payment
 * (src/lib/earmarks.ts) would lower the payment while the plan still counts
 * the money as income - twice. A check-in that recorded its deposits follows
 * them instead: an earmark on one moves the money from the plan's income to
 * the payment, so those are never refused (S18). A deposit that arrived
 * after the confirmation (a family transfer toward an installment) is not in
 * the paycheck the check-in recorded, and can be. `createdAt` null is a
 * deposit not written yet: it arrives after every confirmation.
 */
export function isAdoptedDeposit(
  row: {
    accountId: string;
    date: Date;
    createdAt: Date | null;
    type: string;
    source: string;
    isOneOffIncome: boolean;
    reimbursesTransactionId: string | null;
  },
  windows: readonly AdoptedWindow[],
): boolean {
  if (row.type !== "INCOME" || row.source === "PAYDAY_CHECKIN" || row.isOneOffIncome) return false;
  if (reimbursedExpenseIdFromTransaction(row) !== null || row.createdAt === null) return false;
  const day = row.date.getTime();
  const created = row.createdAt.getTime();
  return windows.some(
    (window) =>
      window.accountId === row.accountId &&
      day >= window.from.getTime() &&
      day < window.until.getTime() &&
      created <= window.confirmedAt.getTime(),
  );
}

/**
 * Why `income` is not acceptable for an account whose deposits in the
 * period's income window already hold `inLedger`, or null when it is: the
 * check-in adopts those deposits, so the paycheck cannot be less than they
 * hold (the difference above them is recorded as the check-in's own row).
 * Cents are forgiven, as the amounts are typed.
 */
export function ledgerDepositsIssue(income: number, inLedger: number): "below_ledger" | null {
  return income + 0.005 < inLedger ? "below_ledger" : null;
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
