/**
 * K4, flexible room for a period (QUANTITIES_MAP.md): what a pay period
 * leaves for flexible categories, one formula over one set of inputs.
 *
 *   available = income + carryover - subscriptions - contributions
 *               - goal plan - essential - buffer - cap
 *
 * Every screen that says "Available for flexible categories" reads it from
 * here: Step 3 while a check-in is drafted (the draft's figures, "projected"),
 * the confirmed card, the Dashboard's "Recommended" and Afford for a period
 * whose check-in is confirmed (what was confirmed, "confirmed"), and Afford
 * and the room check for a period nobody has checked in for yet (history,
 * "projected"). src/lib/data/flexible-room.ts assembles the inputs.
 *
 * No I/O and no Prisma: the wizard (a client component) runs the same
 * functions as the server.
 */
import { round2 } from "@/lib/money";

export type FlexibleRoomBasis = "confirmed" | "projected";

export interface FlexibleInput {
  income: number;
  includedCarryover: number;
  subscriptions: number;
  recurringContributions: number;
  goalPlan: number;
  essentialFixed: number;
  buffer: number;
  /**
   * AccountBufferBreakdown.reconciliationGap: how much less the accounts
   * really support than their income projects (see AccountBufferPlan
   * .reportedGap), in the display currency. A ceiling applied after the
   * seven-input formula - it only ever lowers the result, and 0 or absent
   * leaves it exactly as the formula had it.
   */
  reconciliationGap?: number;
}

/**
 * availableForFlexibleCategories = income + carryover - subscriptions -
 * recurringContributions - goalPlan - essentialFixed - buffer, then capped by
 * the reconciliation gap when there is one. Can be negative - callers must
 * show that as a deficit, never clamp it to zero.
 */
export function availableForFlexibleCategories(input: FlexibleInput): number {
  const projected = round2(
    input.income +
      input.includedCarryover -
      input.subscriptions -
      input.recurringContributions -
      input.goalPlan -
      input.essentialFixed -
      input.buffer,
  );
  return round2(projected - Math.max(0, input.reconciliationGap ?? 0));
}

/** K4's inputs, every one in the display currency. */
export interface FlexibleRoomInputs {
  income: number;
  /** The carryover the plan counts. A provisional one counts 0 until it settles (see provisionalCarryover). */
  carryover: number;
  subscriptions: number;
  contributions: number;
  goalPlan: number;
  essential: number;
  buffer: number;
  /** The reconciliation cap: what accounts with income this period were below zero before it landed. */
  cap: number;
  /**
   * Decision 5.1, option D: what the accounts already held before this
   * period's pay (Step 1's reported balances, for a confirmed period the
   * snapshots'), shown beside `available` and never added to it. See
   * cushionFrom.
   */
  cushion: number;
  /**
   * A carryover the user included while the period it comes from was still
   * running: shown, counted in nothing, until that period ends and its final
   * amount is settled (decision 3). 0 when there is none.
   */
  provisionalCarryover: number;
}

export interface FlexibleRoom extends FlexibleRoomInputs {
  basis: FlexibleRoomBasis;
  /** subscriptions + contributions: the period's whole commitments (K2). */
  commitments: number;
  /** availableForFlexibleCategories over the inputs. Can be negative. */
  available: number;
}

/** K4 over one set of inputs. */
export function flexibleRoomFrom(basis: FlexibleRoomBasis, inputs: FlexibleRoomInputs): FlexibleRoom {
  return {
    ...inputs,
    basis,
    commitments: round2(inputs.subscriptions + inputs.contributions),
    available: availableForFlexibleCategories({
      income: inputs.income,
      includedCarryover: inputs.carryover,
      subscriptions: inputs.subscriptions,
      recurringContributions: inputs.contributions,
      goalPlan: inputs.goalPlan,
      essentialFixed: inputs.essential,
      buffer: inputs.buffer,
      reconciliationGap: inputs.cap,
    }),
  };
}

/**
 * The cushion beside "Available": every account's reported balance before
 * the pay, summed, with the cap added back - an account with income that was
 * below zero is already covered from that income by the cap, so its hole is
 * not taken out of the other accounts' cushion a second time. An account
 * without income this period that is below zero does eat into it. Never
 * below 0.
 */
export function cushionFrom(reportedInDisplay: readonly number[], cap: number): number {
  return Math.max(0, round2(reportedInDisplay.reduce((sum, value) => sum + value, 0) + Math.max(0, cap)));
}

/**
 * What the period's plan leaves in no budget (decision 2): the room the
 * check-in gave flexible categories, plus its essential budgets, beyond what
 * the period's budget holds. With category budgets only, that is `available`
 * less the flexible budgets; with an overall budget, whatever of the plan it
 * does not cover. 0 when the budgets hold all of it or more.
 */
export function unallocatedRoom(room: Pick<FlexibleRoom, "essential" | "available">, periodBudget: number): number {
  return Math.max(0, round2(room.essential + room.available - periodBudget));
}

/**
 * What a period leaves the next one as carryover (decision 2): its budget
 * and the money its plan left in no budget, less its budget spending (K6),
 * never below 0. So an unallocated amount reaches the next period once, and
 * a budget raised later on the Budgets page moves money from the unallocated
 * part to the budgeted part without counting it twice. A period with neither
 * a budget nor a confirmed plan has nothing to measure against.
 */
export function leftoverFrom(
  period: { periodBudget: number; hasBudget: boolean; spent: number },
  room: Pick<FlexibleRoom, "essential" | "available"> | null,
): { amount: number; basis: "prior_period_budget" | "no_prior_budget" } {
  if (!period.hasBudget && !room) return { amount: 0, basis: "no_prior_budget" };
  const planned = room ? Math.max(period.periodBudget, round2(room.essential + room.available)) : period.periodBudget;
  return { amount: Math.max(0, round2(planned - period.spent)), basis: "prior_period_budget" };
}

/** The CARRYOVER allocation basis of a carryover included before the period it comes from ended. */
export const PROVISIONAL_CARRYOVER_BASIS = "provisional";

/**
 * Whether a carryover taken into `plan` from the period before it is still
 * provisional on `today`: that period has not ended (its last day is today
 * or later), so what it leaves can still shrink. Every check-in done on its
 * payday is, since the payday falls in the period before.
 */
export function carryoverIsProvisional(previousEnd: Date, today: Date): boolean {
  return previousEnd.getTime() >= today.getTime();
}

/**
 * The Dashboard's "Recommended" for the period the hero shows (D24): the
 * room its confirmed check-in leaves flexible categories, shown while no
 * overall budget is set and either nothing is budgeted yet or the budgets
 * leave part of the room in no budget - money that otherwise carries to the
 * next period. Null when there is no confirmed plan, an overall budget is
 * set, or the budgets hold all of the room.
 */
export function recommendationFor(
  summary: { overallBudget: number | null; hasBudget: boolean },
  room: { available: number; unallocated: number } | null,
): { available: number; unallocated: number } | null {
  if (!room || summary.overallBudget !== null) return null;
  if (summary.hasBudget && room.unallocated <= 0) return null;
  return { available: room.available, unallocated: room.unallocated };
}
