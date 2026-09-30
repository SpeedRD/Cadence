/**
 * Loads K4, flexible room for a period (the rule is src/lib/flexible-room.ts).
 *
 * A period with a CONFIRMED check-in reads what was confirmed, not today's
 * data rebuilt into a new draft:
 *
 *   income      the check-in's totalIncome (the paychecks typed, converted
 *               once, when confirmed)
 *   buffer      its protectedBuffer, whatever the buffer setting says now
 *   carryover   its includedCarryover - 0 while provisional (see below)
 *   goal plan   its GOAL rows, every one of them: a goal reached since keeps
 *               the plan it was confirmed with
 *   essential   the period's Budget row for each category confirmed as
 *               essential (the allocation when the row is gone)
 *   cap         what its snapshots say the accounts with income were below
 *               zero before the pay
 *   commitments the period's whole commitments (K2), live: what posted is
 *               counted at the ledger's amount, what is still to come at the
 *               schedule's
 *
 * and beside them the cushion: the snapshots' reported balances (decision
 * 5.1, option D).
 *
 * Carryover timing (decision 3). A check-in confirmed while the period
 * before it is still running - every check-in done on its payday is - takes
 * that period's leftover before it is final. Its CARRYOVER allocation is
 * then written with basis PROVISIONAL_CARRYOVER_BASIS and the plan counts
 * none of it; the first read of the check-in's room once that period has
 * ended settles it: the period's final leftover (periodLeftover) is written
 * to includedCarryover and to the allocation, in one guarded update, so it
 * happens once. From then on it is an ordinary stored carryover.
 */
import { roomFromProjection } from "@/lib/afford";
import { convert } from "@/lib/currency";
import { periodBudgetFrom } from "@/lib/budget-spending";
import {
  carryoverIsProvisional,
  cushionFrom,
  flexibleRoomFrom,
  leftoverFrom,
  PROVISIONAL_CARRYOVER_BASIS,
  unallocatedRoom,
  type FlexibleRoom,
  type FlexibleRoomBasis,
} from "@/lib/flexible-room";
import { num, round2 } from "@/lib/money";
import { periodInfo, previousPeriod, type PeriodInfo, type PeriodRef } from "@/lib/period";
import { byItem, sumOccurrences, whole, wholeAmount, type CommitmentOccurrence } from "@/lib/period-commitments";
import { prisma } from "@/lib/prisma";

import { loadBudgetSpent } from "@/lib/data/budget-spending";
import { loadCommitments } from "@/lib/data/period-commitments";

import type { AppContext } from "@/lib/data/context";
import type { ConfirmPaydayCheckinContext } from "@/lib/data/payday";

/** One account as a confirmed check-in recorded it, amounts in the account's currency. */
export interface ConfirmedAccountRoom {
  accountId: string;
  currency: string;
  /** The income entered for it. */
  income: number;
  /** Its BUFFER row; null when the check-in kept none on it (no income there). */
  buffer: number | null;
  /** Step 1's reported balance. */
  reportedBalance: number;
}

/** K4 for a period whose check-in is confirmed, with what the Dashboard reads beside it. */
export interface ConfirmedRoom extends FlexibleRoom {
  basis: "confirmed";
  period: PeriodInfo;
  checkinId: string;
  accounts: ConfirmedAccountRoom[];
  /** The period's budget as it stands (overall, else the category rows), display currency. */
  periodBudget: number;
  /** The flexible categories' budgets: what the plan allocated to them, as the Budgets page now has it. */
  flexibleBudgeted: number;
  /** What the plan left in no budget (unallocatedRoom): carried to the next period, not budgeted. */
  unallocated: number;
  /** The last day of the period a provisional carryover comes from; null when none is provisional. */
  carryoverSettlesAfter: Date | null;
}

type RoomContext = Pick<AppContext, "displayCurrency" | "rates" | "today">;

/** How far back one read may settle provisional carryovers before it leaves the rest provisional (counted 0, never overstated). */
const MAX_SETTLE_DEPTH = 24;

async function readCheckins(periods: readonly PeriodInfo[]) {
  return prisma.paydayCheckin.findMany({
    where: {
      status: "CONFIRMED",
      OR: periods.map((period) => ({ year: period.year, month: period.month, period: period.period })),
    },
    select: {
      id: true,
      year: true,
      month: true,
      period: true,
      currency: true,
      totalIncome: true,
      includedCarryover: true,
      protectedBuffer: true,
      snapshots: { select: { accountId: true, currency: true, incomeEntered: true, reportedBalance: true } },
      allocations: {
        where: { type: { in: ["GOAL", "BUFFER", "ESSENTIAL_CATEGORY", "FLEXIBLE_CATEGORY", "CARRYOVER"] } },
        select: { id: true, type: true, goalId: true, categoryId: true, accountId: true, plannedAmount: true, currency: true, basis: true },
      },
    },
  });
}

type CheckinRow = Awaited<ReturnType<typeof readCheckins>>[number];

function provisionalRow(checkin: CheckinRow) {
  return checkin.allocations.find((row) => row.type === "CARRYOVER" && row.basis === PROVISIONAL_CARRYOVER_BASIS) ?? null;
}

/**
 * What `period` leaves the next one as carryover (leftoverFrom): its budget
 * and its plan's unallocated money, less its budget spending (K6). What a
 * check-in for the next period offers, and what settles a provisional one.
 */
export async function periodLeftover(
  period: PeriodRef,
  context: RoomContext,
  depth = 0,
): Promise<{ amount: number; basis: "prior_period_budget" | "no_prior_budget" }> {
  const info = periodInfo(period);
  const [budgets, spent, rooms] = await Promise.all([
    prisma.budget.findMany({
      where: { year: info.year, month: info.month, period: info.period },
      select: { categoryId: true, amount: true, currency: true },
    }),
    loadBudgetSpent([info], context),
    loadConfirmedRooms([info], context, { depth }),
  ]);
  const toDisplay = (amount: number, currency: string) => convert(amount, currency, context.displayCurrency, context.rates);
  const budget = periodBudgetFrom(
    budgets.map((row) => ({ categoryId: row.categoryId, amount: num(row.amount), currency: row.currency })),
    toDisplay,
  );
  return leftoverFrom(
    { periodBudget: budget.periodBudget, hasBudget: budget.hasBudget, spent: spent.get(info.key)?.total ?? 0 },
    rooms.get(info.key) ?? null,
  );
}

/**
 * Settles one check-in's provisional carryover: the period before it has
 * ended, so its leftover is final. The allocation's basis is the guard -
 * only the read that moves it off PROVISIONAL_CARRYOVER_BASIS writes, so two
 * readers at once settle it once.
 */
async function settleCarryover(checkin: CheckinRow, context: RoomContext, depth: number): Promise<void> {
  const row = provisionalRow(checkin);
  if (!row) return;
  const settled = await periodLeftover(previousPeriod(checkin), context, depth + 1);
  const amount = round2(convert(settled.amount, context.displayCurrency, checkin.currency, context.rates));
  await prisma.$transaction(async (tx) => {
    const moved = await tx.paydayPlanAllocation.updateMany({
      where: { id: row.id, basis: PROVISIONAL_CARRYOVER_BASIS },
      data: { basis: settled.basis, recommendedAmount: amount, plannedAmount: amount, currency: checkin.currency },
    });
    if (moved.count === 1) {
      await tx.paydayCheckin.update({ where: { id: checkin.id }, data: { includedCarryover: amount } });
    }
  });
}

/**
 * K4 ("confirmed") for every period in `periods` that has a confirmed
 * check-in, keyed by period key; a period without one is absent.
 * `commitments` is loadCommitments() over the periods when the caller has
 * it already (Afford, whose re-check leaves one item's schedule out).
 */
export async function loadConfirmedRooms(
  periods: readonly PeriodRef[],
  context: RoomContext,
  options: { commitments?: Map<string, CommitmentOccurrence[]>; depth?: number } = {},
): Promise<Map<string, ConfirmedRoom>> {
  const result = new Map<string, ConfirmedRoom>();
  const infos = periods.map(periodInfo);
  if (infos.length === 0) return result;
  const depth = options.depth ?? 0;

  let checkins = await readCheckins(infos);
  if (checkins.length === 0) return result;
  const endedProvisional = checkins.filter(
    (checkin) =>
      provisionalRow(checkin) !== null &&
      !carryoverIsProvisional(periodInfo(previousPeriod(checkin)).end, context.today),
  );
  if (endedProvisional.length > 0 && depth < MAX_SETTLE_DEPTH) {
    for (const checkin of endedProvisional) await settleCarryover(checkin, context, depth);
    checkins = await readCheckins(infos);
  }

  const confirmed = infos.filter((info) => checkins.some((checkin) => periodInfo(checkin).key === info.key));
  const [budgets, commitments] = await Promise.all([
    prisma.budget.findMany({
      where: { OR: confirmed.map((info) => ({ year: info.year, month: info.month, period: info.period })) },
      select: { year: true, month: true, period: true, categoryId: true, amount: true, currency: true },
    }),
    options.commitments ?? loadCommitments(confirmed, context),
  ]);
  const toDisplay = (amount: number, currency: string) => convert(amount, currency, context.displayCurrency, context.rates);

  for (const checkin of checkins) {
    const period = periodInfo(checkin);
    const provisional = provisionalRow(checkin);
    const previous = periodInfo(previousPeriod(checkin));

    // The commitments, grouped and rounded per item as the wizard's rows are,
    // so a confirmed period and its re-opened draft agree to the cent.
    const occurrences = whole(commitments.get(period.key) ?? []);
    const commitmentTotal = (kind: CommitmentOccurrence["kind"]) =>
      round2(
        byItem(occurrences.filter((occurrence) => occurrence.kind === kind)).reduce(
          (sum, group) => sum + round2(sumOccurrences(group, context.displayCurrency, context.rates, wholeAmount)),
          0,
        ),
      );

    // Every GOAL row, one goal at a time (a deleted goal's rows stay counted).
    const goalTotals = new Map<string, number>();
    for (const row of checkin.allocations.filter((allocation) => allocation.type === "GOAL")) {
      const key = row.goalId ?? `row:${row.id}`;
      goalTotals.set(key, (goalTotals.get(key) ?? 0) + toDisplay(num(row.plannedAmount), row.currency));
    }
    const goalPlan = round2([...goalTotals.values()].reduce((sum, value) => sum + round2(value), 0));

    const periodBudgets = budgets.filter((budget) => periodInfo(budget).key === period.key);
    const budget = periodBudgetFrom(
      periodBudgets.map((row) => ({ categoryId: row.categoryId, amount: num(row.amount), currency: row.currency })),
      toDisplay,
    );
    // A category's figure: its Budget row as it stands, else what was confirmed.
    const categoryTotal = (type: "ESSENTIAL_CATEGORY" | "FLEXIBLE_CATEGORY") =>
      round2(
        checkin.allocations
          .filter((allocation) => allocation.type === type && allocation.categoryId)
          .reduce(
            (sum, allocation) =>
              sum +
              (budget.byCategory.get(allocation.categoryId as string) ??
                round2(toDisplay(num(allocation.plannedAmount), allocation.currency))),
            0,
          ),
      );

    // Accounts with income that were below zero before it landed: the cap
    // confirm scaled the flexible budgets by (AccountBufferPlan.reportedGap).
    const cap = round2(
      checkin.snapshots
        .filter((snapshot) => num(snapshot.incomeEntered) > 0)
        .reduce((sum, snapshot) => sum + toDisplay(Math.max(0, -num(snapshot.reportedBalance)), snapshot.currency), 0),
    );
    const provisionalCarryover =
      provisional && depth < MAX_SETTLE_DEPTH ? (await periodLeftover(previous, context, depth + 1)).amount : 0;

    const room = flexibleRoomFrom("confirmed", {
      income: round2(toDisplay(num(checkin.totalIncome), checkin.currency)),
      carryover: provisional ? 0 : round2(toDisplay(num(checkin.includedCarryover), checkin.currency)),
      provisionalCarryover,
      subscriptions: commitmentTotal("SUBSCRIPTION"),
      contributions: commitmentTotal("CONTRIBUTION"),
      goalPlan,
      essential: categoryTotal("ESSENTIAL_CATEGORY"),
      buffer: round2(toDisplay(num(checkin.protectedBuffer), checkin.currency)),
      cap,
      cushion: cushionFrom(
        checkin.snapshots.map((snapshot) => toDisplay(num(snapshot.reportedBalance), snapshot.currency)),
        cap,
      ),
    });
    const bufferByAccount = new Map(
      checkin.allocations
        .filter((allocation) => allocation.type === "BUFFER" && allocation.accountId)
        .map((allocation) => [allocation.accountId as string, num(allocation.plannedAmount)]),
    );
    result.set(period.key, {
      ...room,
      basis: "confirmed",
      period,
      checkinId: checkin.id,
      accounts: checkin.snapshots.map((snapshot) => ({
        accountId: snapshot.accountId,
        currency: snapshot.currency,
        income: num(snapshot.incomeEntered),
        buffer: bufferByAccount.get(snapshot.accountId) ?? null,
        reportedBalance: num(snapshot.reportedBalance),
      })),
      periodBudget: budget.periodBudget,
      flexibleBudgeted: categoryTotal("FLEXIBLE_CATEGORY"),
      unallocated: unallocatedRoom(room, budget.periodBudget),
      carryoverSettlesAfter: provisional ? previous.end : null,
    });
  }
  return result;
}

/**
 * K4: flexibleRoom(period, inputs). "confirmed" reads the period's confirmed
 * check-in (null when it has none); "projected" reads projections - income
 * estimated from comparable history (K5), the period's commitments (K2), the
 * goals' period plans (K3), suggested essentials and the buffer on that
 * income - exactly what Afford judges a period with no check-in by, whether
 * or not this one has one. The wizard's Step 3 is the third reader: while a
 * check-in is drafted its figures are the typed ones (draftFlexibleRoom in
 * src/lib/payday.ts).
 */
export async function flexibleRoom(
  period: PeriodRef,
  basis: FlexibleRoomBasis,
  context: ConfirmPaydayCheckinContext,
): Promise<FlexibleRoom | null> {
  const info = periodInfo(period);
  if (basis === "confirmed") return (await loadConfirmedRooms([info], context)).get(info.key) ?? null;
  // Afford reads this module, so its projection is imported here on demand.
  const { projectPeriods } = await import("@/lib/data/afford");
  const accounts = await prisma.account.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, currency: true },
  });
  if (accounts.length === 0) return null;
  const projection = (await projectPeriods([info], accounts[0], accounts, context, { ignoreCheckins: true })).get(info.key);
  return projection ? roomFromProjection(projection) : null;
}
