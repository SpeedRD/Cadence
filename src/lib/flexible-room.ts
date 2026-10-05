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
 * What a period leaves the next one as carryover (decision 2). With a
 * confirmed plan, the plan's room - its essential budgets and what it left
 * flexible categories, budgeted or not - less its budget spending (K6) and
 * the goal money that left outside the plan (`goalMoneyOutside`, S8), never
 * below 0: an unallocated amount reaches the next period once, and a
 * budget raised later on the Budgets page only moves money between the
 * budgeted and unallocated parts. A budget set above the plan is not money
 * the period had (R7), so it adds nothing. essential + available does not
 * move with the essential budgets either, since available is what the plan
 * left after them. Goal money is outside budget spending (a contribution's
 * own expense is savings), and the plan counts it only as a commitment it
 * settled or within its GOAL rows; what left beyond them - a hand-logged
 * contribution that filled a goal, so the automatic one it was meant to pay
 * no longer posts, or one nobody planned - left the account all the same,
 * so it is not left over. Without a confirmed plan, the period's budget
 * less its spending: a budget holds no goal money either; with neither,
 * there is nothing to measure against.
 */
export function leftoverFrom(
  period: { periodBudget: number; hasBudget: boolean; spent: number },
  room: (Pick<FlexibleRoom, "essential" | "available"> & { goalMoneyOutside?: number }) | null,
): { amount: number; basis: "prior_period_budget" | "no_prior_budget" } {
  if (!period.hasBudget && !room) return { amount: 0, basis: "no_prior_budget" };
  const planned = room ? round2(room.essential + room.available - Math.max(0, room.goalMoneyOutside ?? 0)) : period.periodBudget;
  return { amount: Math.max(0, round2(planned - period.spent)), basis: "prior_period_budget" };
}

/**
 * Goal money that left a period outside its plan (S8), in the display
 * currency: per goal, what its hand-logged contributions' own expenses
 * dated in the period's funding window took out beyond the period's GOAL
 * rows for it. `contributions` holds only the ones no commitment already
 * counts - a contribution's expense that paid an automatic occurrence is
 * that occurrence, settled, and never counted again. Within a goal's GOAL
 * rows it is the plan being carried out, already out of the room.
 */
export function goalMoneyOutsidePlan(
  contributions: readonly { goalKey: string; amount: number }[],
  goalRows: ReadonlyMap<string, number>,
): number {
  const byGoal = new Map<string, number>();
  for (const contribution of contributions) byGoal.set(contribution.goalKey, (byGoal.get(contribution.goalKey) ?? 0) + contribution.amount);
  return round2([...byGoal].reduce((sum, [goalKey, amount]) => sum + Math.max(0, round2(amount - (goalRows.get(goalKey) ?? 0))), 0));
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
 * The CARRYOVER allocation basis of a carryover that moved after it settled
 * (R8): rows dated in the period it comes from, arriving later, changed what
 * that period leaves. Its recommendedAmount keeps the amount it settled at
 * (or was confirmed at, when it was never provisional), its plannedAmount
 * and the check-in's includedCarryover follow the period's leftover.
 */
export const ADJUSTED_CARRYOVER_BASIS = "adjusted";

/**
 * The CARRYOVER allocation basis of a carryover the user included that
 * stands at 0 (S5): it settled at 0, the period it comes from having left
 * nothing, or was included at 0 after that period ended. A declined
 * carryover is plannedAmount 0 under the leftover's own basis; this one is
 * kept in step with the period it comes from like any other the user took
 * (carryoverReconciles), so spending corrected there later still reaches
 * the plan.
 */
export const INCLUDED_AT_ZERO_CARRYOVER_BASIS = "included_at_zero";

/**
 * Whether a CARRYOVER allocation is a carryover the user included rather
 * than declined: one still provisional, one standing above 0, one adjusted
 * since it settled (it may have gone to 0) or one included at 0
 * (INCLUDED_AT_ZERO_CARRYOVER_BASIS).
 */
export function carryoverIncluded(row: { basis: string | null; plannedAmount: number }): boolean {
  return (
    row.plannedAmount > 0 ||
    row.basis === PROVISIONAL_CARRYOVER_BASIS ||
    row.basis === ADJUSTED_CARRYOVER_BASIS ||
    row.basis === INCLUDED_AT_ZERO_CARRYOVER_BASIS
  );
}

/**
 * Whether a settled carryover is still kept in step with what the period it
 * comes from leaves, on `today`: from the day after that period ends (before
 * then it is provisional) through the last day of the period that took it.
 * Once that period is over too, the carryover stays as it last stood.
 */
export function carryoverReconciles(previousEnd: Date, periodEnd: Date, today: Date): boolean {
  return today.getTime() > previousEnd.getTime() && today.getTime() <= periodEnd.getTime();
}

/**
 * How much a carryover moved since it settled, from its CARRYOVER
 * allocation: null unless it was adjusted (ADJUSTED_CARRYOVER_BASIS) and now
 * stands at another amount. Amounts in the allocation's currency.
 */
export function carryoverAdjustmentOf(row: {
  basis: string | null;
  recommendedAmount: number;
  plannedAmount: number;
}): { settled: number; current: number; by: number } | null {
  if (row.basis !== ADJUSTED_CARRYOVER_BASIS) return null;
  const by = round2(row.plannedAmount - row.recommendedAmount);
  if (Math.abs(by) < 0.005) return null;
  return { settled: row.recommendedAmount, current: row.plannedAmount, by };
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

/** The id of the Budgets page's category rows section, the target of {@link categoryBudgetsHref}. */
export const CATEGORY_BUDGETS_SECTION_ID = "category-budgets";

/**
 * The Dashboard hero's "budget it here" link: the Budgets page for a period,
 * scrolled to its category rows, where the money the budgets leave in no
 * budget can be budgeted.
 */
export function categoryBudgetsHref(key: string): string {
  return `/budgets?${new URLSearchParams({ period: key })}#${CATEGORY_BUDGETS_SECTION_ID}`;
}
