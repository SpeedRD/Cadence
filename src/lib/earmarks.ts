/**
 * Income earmarked for a recurring payment: part of a deposit the user set
 * aside for one occurrence of a recurring item ("This money is for an
 * upcoming payment") - a family member's transfer toward an installment,
 * money moved in from outside Cadence for it. Stored as RecurringEarmark
 * rows (prisma/schema.prisma), the same shape as RecurringSettlement (a row
 * <-> an occurrence key), but many-to-many: one deposit may be split over
 * several occurrences, and one occurrence may take several deposits.
 *
 * The effect is one subtraction, in the period commitments
 * (src/lib/period-commitments.ts): an occurrence's cost to the plan is its
 * amount less what is earmarked for it (outstandingAmount, wholeAmount),
 * whether it is still to come or already posted, so every reader of that
 * cost - Step 3, the confirmed card, "Recommended", Afford, the tracker and
 * the room check - sees the reduced figure. The posted row keeps the full
 * bank amount; the earmark stays as the record of what covered it. The other
 * half keeps the money from being counted twice: the earmarked part of a
 * deposit is left out of the income estimate (src/lib/period-income.ts), and
 * no plan counts it as income otherwise - a check-in's income is the
 * paychecks typed into it, and a check-in's paycheck cannot be earmarked.
 *
 * The bounds, applied when an earmark is written (earmarkIssue) and again
 * whenever one is read, because the deposit or the occurrence can change
 * after the fact (an edited amount, a foreign item re-converted at today's
 * rate):
 *
 *   - a deposit never covers more than it holds: its earmarks are taken in
 *     due-date order and the ones past its amount shrink (boundByDeposit);
 *   - an occurrence never takes more than it costs: its earmarks are taken
 *     in the order the deposits arrived and the rest is left unused
 *     (coverOccurrence).
 *
 * Pure - no Prisma - so the transaction dialog and scripts/verify-domain.ts
 * share it with the loaders in src/lib/data/earmarks.ts.
 */
import { convert, type RateTable } from "@/lib/currency";
import { round2 } from "@/lib/money";

/** Amounts within this much of a bound are inside it (a cent, as the matchers use). */
export const EARMARK_TOLERANCE = 0.005;

/** The rows a deposit can be: what came in from somewhere else, not a paycheck a check-in planned or a row Cadence wrote. */
export interface EarmarkableRow {
  type: string;
  source: string;
  transferDirection: string | null;
}

/**
 * Whether a row can be earmarked: ordinary income (manual, imported, from a
 * receipt) or an incoming external transfer. A check-in's paycheck is
 * already the plan's income - the money that pays every commitment - so
 * earmarking it would count it twice; an opening balance is not a deposit,
 * and a RECURRING row is posting's own.
 */
export function canBeEarmarked(row: EarmarkableRow): boolean {
  if (row.source === "PAYDAY_CHECKIN" || row.source === "OPENING_BALANCE" || row.source === "RECURRING") return false;
  return row.type === "INCOME" || (row.type === "EXTERNAL_TRANSFER" && row.transferDirection === "IN");
}

/** One stored earmark with the deposit it comes from. */
export interface EarmarkFact {
  transactionId: string;
  occurrenceKey: string;
  dueDate: Date;
  amount: number;
  currency: string;
  /** The deposit as it is stored now. */
  deposit: { date: Date; amount: number; currency: string; label: string | null };
}

/** What covers an occurrence: one deposit's part, in the occurrence's currency once applied. */
export interface OccurrenceEarmark {
  transactionId: string;
  amount: number;
  currency: string;
  depositDate: Date;
  /** The deposit's note, else null - the screens fall back to its date. */
  depositLabel: string | null;
}

/**
 * Each deposit's earmarks bounded by the deposit: taken in due-date order
 * (occurrence key breaking ties), each in its own currency, the ones past
 * the deposit's amount shrunk to what is left, or dropped. Keyed by
 * occurrence key.
 */
export function boundByDeposit(facts: readonly EarmarkFact[], rates: RateTable): Map<string, OccurrenceEarmark[]> {
  const byDeposit = new Map<string, EarmarkFact[]>();
  for (const fact of facts) {
    const list = byDeposit.get(fact.transactionId);
    if (list) list.push(fact);
    else byDeposit.set(fact.transactionId, [fact]);
  }
  const result = new Map<string, OccurrenceEarmark[]>();
  for (const list of byDeposit.values()) {
    list.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.occurrenceKey.localeCompare(b.occurrenceKey));
    let left = Math.max(0, list[0].deposit.amount);
    for (const fact of list) {
      const inDeposit = convert(fact.amount, fact.currency, fact.deposit.currency, rates);
      const taken = Math.min(Math.max(0, inDeposit), left);
      left = round2(left - taken);
      if (taken <= 0) continue;
      const amount =
        taken >= inDeposit - EARMARK_TOLERANCE ? fact.amount : round2(convert(taken, fact.deposit.currency, fact.currency, rates));
      if (amount <= 0) continue;
      const entry: OccurrenceEarmark = {
        transactionId: fact.transactionId,
        amount,
        currency: fact.currency,
        depositDate: fact.deposit.date,
        depositLabel: fact.deposit.label,
      };
      const forKey = result.get(fact.occurrenceKey);
      if (forKey) forKey.push(entry);
      else result.set(fact.occurrenceKey, [entry]);
    }
  }
  return result;
}

/**
 * What covers an occurrence costing `cost` in `currency`: its earmarks taken
 * in the order the deposits arrived (deposit id breaking ties), each
 * converted into `currency` and shrunk to what the occurrence still costs,
 * so the total never exceeds it. `earmarked` is that total.
 */
export function coverOccurrence(
  cost: number,
  currency: string,
  earmarks: readonly OccurrenceEarmark[],
  rates: RateTable,
): { earmarked: number; earmarks: OccurrenceEarmark[] } {
  const ordered = [...earmarks].sort(
    (a, b) => a.depositDate.getTime() - b.depositDate.getTime() || a.transactionId.localeCompare(b.transactionId),
  );
  let left = Math.max(0, cost);
  const applied: OccurrenceEarmark[] = [];
  for (const earmark of ordered) {
    const amount = round2(Math.min(convert(earmark.amount, earmark.currency, currency, rates), left));
    if (amount <= 0) continue;
    left = round2(left - amount);
    applied.push({ ...earmark, amount, currency });
  }
  return { earmarked: round2(applied.reduce((sum, earmark) => sum + earmark.amount, 0)), earmarks: applied };
}

/** One occurrence a deposit can be earmarked for, as the transaction form lists it (listEarmarkOptions in src/lib/data/earmark-targets.ts). */
export interface EarmarkOption {
  occurrenceKey: string;
  itemId: string;
  name: string;
  dueDate: Date;
  /** The account it is charged to; only a deposit on this account can cover it. */
  accountId: string;
  /** The account's currency: every amount below is in it. */
  currency: string;
  /** The charge itself: the posted row's amount, or the schedule's converted into the account's currency. */
  charge: number;
  /** What it still asks once every deposit's earmark is taken off. */
  stillAsked: number;
  /** The parts deposits already cover, by deposit - a deposit being edited adds its own part back (stillAskedOf). */
  coveredBy: { transactionId: string; amount: number }[];
  /** One charge as the item schedules it, in its own currency. */
  itemAmount: number;
  itemCurrency: string;
  /**
   * Set on an occurrence outside the periods the form offers (before the
   * current one, or past the horizon) that deposits are already set aside
   * for: offered only to those deposits, so editing one keeps its line -
   * never as a new target for another. Absent: offered to every deposit on
   * its account.
   */
  onlyFor?: string[];
}

/** Whether `option` is offered to the deposit `depositId` (null: one not written yet). */
export function offeredTo(option: Pick<EarmarkOption, "onlyFor">, depositId: string | null | undefined): boolean {
  return !option.onlyFor || (Boolean(depositId) && option.onlyFor.includes(depositId as string));
}

/** What `option` still asks of one deposit: what is left, plus what that deposit already covers of it. */
export function stillAskedOf(option: EarmarkOption, depositId: string | null | undefined): number {
  const own = depositId
    ? option.coveredBy.filter((part) => part.transactionId === depositId).reduce((sum, part) => sum + part.amount, 0)
    : 0;
  return round2(option.stillAsked + own);
}

/** One line of the form: an occurrence and the part of the deposit set aside for it, in the deposit's account's currency. */
export interface EarmarkRequest {
  occurrenceKey: string;
  amount: number;
}

/** An occurrence the deposit may be earmarked for, and what it still asks, in the deposit's account's currency. */
export interface EarmarkTarget {
  occurrenceKey: string;
  stillAsked: number;
}

export type EarmarkIssue = "amount" | "duplicate" | "target" | "over_deposit" | "over_occurrence";

/**
 * Why a set of earmarks for one deposit cannot be written, or null when it
 * can: every amount above 0, each occurrence once, each one among `targets`
 * (an occurrence of a subscription on the deposit's account, not one posting
 * will skip) and at most what it still asks, and all of them together - with
 * `kept`, what the deposit's other earmarks, left as they are, already set
 * aside - at most the deposit. `deposit` and every amount are in the
 * deposit's account's currency.
 */
export function earmarkIssue(
  deposit: number,
  requests: readonly EarmarkRequest[],
  targets: readonly EarmarkTarget[],
  kept = 0,
): EarmarkIssue | null {
  const byKey = new Map(targets.map((target) => [target.occurrenceKey, target]));
  const seen = new Set<string>();
  let total = 0;
  for (const request of requests) {
    if (!Number.isFinite(request.amount) || request.amount <= 0) return "amount";
    if (seen.has(request.occurrenceKey)) return "duplicate";
    seen.add(request.occurrenceKey);
    const target = byKey.get(request.occurrenceKey);
    if (!target) return "target";
    if (request.amount > target.stillAsked + EARMARK_TOLERANCE) return "over_occurrence";
    total += request.amount;
  }
  if (total + kept > deposit + EARMARK_TOLERANCE) return "over_deposit";
  return null;
}

/** The amount a new earmark line starts at: the smaller of what the deposit has left and what the occurrence still asks. */
export function defaultEarmarkAmount(depositLeft: number, stillAsked: number): number {
  return round2(Math.max(0, Math.min(depositLeft, stillAsked)));
}
