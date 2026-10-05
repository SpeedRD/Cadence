/**
 * Loads what planSettlements (src/lib/recurring-settlement.ts) needs and runs
 * it: the verdict on every still-unclaimed occurrence of every active item,
 * due on or before `through`. Recurring posting calls it with today, the
 * period commitments (src/lib/data/period-commitments.ts - what the payday
 * check-in and every other reader of a period's items use) with the last
 * day of the periods they cover; the matcher's due-date ordering is what
 * makes the two agree on every occurrence both cover.
 *
 * An occurrence the user already paired with a charge before it fell due
 * ("It's that payment", keepEntryAsUpcoming in
 * src/lib/data/posted-duplicates.ts) has its RecurringSettlement row already:
 * it is settled by that row's charge, never offered to the matcher, and the
 * charge is no candidate for any other occurrence. The matcher's rules are
 * not involved. So does one posting already claimed (settlementClaimed) that
 * a nextDate moved back walks again - but that one is rolled past like a
 * posted one, without counting against an installment plan.
 *
 * Only items posting will post are planned: an item it skips
 * (skipReasonFor - no account, an archived one, no goal) claims no charge,
 * or its look-alike would post the same money. A contribution whose goal is
 * reached is planned too, but only a hand-logged contribution to that goal
 * can pay it (contributionTwinOnly): the pairing is decided first, so the
 * contribution logged by hand in its place - the one that filled the goal -
 * settles the occurrence it was meant to pay rather than leaving it skipped.
 */
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { advanceDate, skipReasonFor } from "@/lib/recurring";
import { addDays, fromISODate } from "@/lib/date";
import {
  SETTLEMENT_LEAD_DAYS,
  itemIdFromOccurrenceKey,
  plannable,
  planSettlements,
  recurringExternalId,
  settlementClaimed,
  settlementSpan,
  type SettlementCharge,
  type SettlementItem,
  type SettlementOccurrence,
} from "@/lib/recurring-settlement";
import { manualContributionIdFromTransaction } from "@/lib/transactions";

import type { RecurringKind } from "@/generated/prisma/enums";

/** Never walk more occurrences of one item than this, however far behind it has fallen. */
const MAX_SETTLEMENT_WALK = 400;

/** A candidate charge as posting needs it to record the settlement and, for a contribution, its GoalContribution. */
export interface PlannedCharge {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  /** What the charge was entered as, when that was another currency than its account's (K7). */
  originalAmount: number | null;
  originalCurrency: string | null;
  accountId: string;
  /** A hand-logged contribution's own expense: its GoalContribution already exists. */
  isContributionTwin: boolean;
  /** The pairing is already a RecurringSettlement row, written before the occurrence fell due; posting keeps it rather than writing one. */
  alreadyRecorded?: boolean;
}

export interface SettlementPlan {
  /** Occurrences whose RECURRING row already exists (a nextDate moved back onto a posted day). */
  posted: Set<string>;
  /**
   * Occurrences posting already claimed with a charge (settlementClaimed)
   * that a nextDate moved back walks again: rolled past without counting, as
   * a posted one is. Also in `settledBy`.
   */
  claimed: Set<string>;
  /** The charge that already paid each settled occurrence, by recurringExternalId. */
  settledBy: Map<string, PlannedCharge>;
  /**
   * The occurrence each charge in `settledBy` pays and its item's kind, by
   * charge id - the pairings posting will record, before it has. Budget
   * spending leaves such a charge out as it does one already recorded
   * (pairedCharges).
   */
  byCharge: Map<string, { key: string; kind: RecurringKind }>;
}

/** Whether a walk rolls past `key` without counting it against an installment plan: its RECURRING row exists, or posting already claimed it. */
export function rolledPast(plan: Pick<SettlementPlan, "posted" | "claimed">, key: string): boolean {
  return plan.posted.has(key) || plan.claimed.has(key);
}

/**
 * A charge not written yet, planned as if it were (the contribution dialog's
 * notice, contributionWouldSettle): it joins the candidates after every
 * stored charge of its day, as a row written now would.
 */
export interface HypotheticalCharge extends SettlementCharge {
  accountId: string;
}

/** The id a hypothetical charge plans under: after every stored id of its day. */
const HYPOTHETICAL_CHARGE_ID = "~unsaved";

export async function loadSettlementPlan(
  through: Date,
  options: {
    hypothetical?: Omit<HypotheticalCharge, "id">;
    /** A stored charge the hypothetical one stands in for (the expense of the contribution being edited): left out of the candidates. */
    replacing?: string;
  } = {},
): Promise<SettlementPlan> {
  const plan: SettlementPlan = { posted: new Set(), claimed: new Set(), settledBy: new Map(), byCharge: new Map() };

  const found = await prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lte: through } },
    select: {
      id: true,
      name: true,
      amount: true,
      currency: true,
      categoryId: true,
      kind: true,
      goalId: true,
      frequency: true,
      nextDate: true,
      anchorDay: true,
      secondAnchorDay: true,
      remainingOccurrences: true,
      accountId: true,
      account: { select: { status: true } },
      goal: { select: { achievedAt: true } },
    },
  });
  const rows = found.filter((row) => plannable(skipReasonFor(row)));
  const goalReached = new Set(rows.filter((row) => skipReasonFor(row) === "goal_achieved").map((row) => row.id));
  if (rows.length === 0) return plan;
  const kindById = new Map(rows.map((row) => [row.id, row.kind]));

  // Every unclaimed due date through `through`, before the countdown: an
  // occurrence whose RECURRING row already exists is rolled past without
  // spending an installment (see postOccurrence), so it cannot count against
  // remainingOccurrences here either.
  const walks = rows.map((row) => {
    const dates: Date[] = [];
    let cursor = row.nextDate;
    for (let i = 0; i < MAX_SETTLEMENT_WALK && cursor.getTime() <= through.getTime(); i += 1) {
      dates.push(cursor);
      cursor = advanceDate(cursor, row.frequency, row.anchorDay, row.secondAnchorDay);
    }
    return { row, dates };
  });
  const keys = walks.flatMap(({ row, dates }) => dates.map((due) => recurringExternalId(row.id, due)));
  for (const posted of await prisma.transaction.findMany({
    where: { source: "RECURRING", externalId: { in: keys } },
    select: { externalId: true },
  })) {
    plan.posted.add(posted.externalId as string);
  }
  // Occurrences already paired before they fell due: settled by their row's
  // charge as recorded.
  for (const recorded of await prisma.recurringSettlement.findMany({
    where: { occurrenceKey: { in: keys } },
    select: {
      occurrenceKey: true,
      claimedByPostingAt: true,
      transaction: {
        select: { id: true, date: true, amount: true, currency: true, originalAmount: true, originalCurrency: true, accountId: true, source: true, externalId: true },
      },
    },
  })) {
    const charge = recorded.transaction;
    plan.settledBy.set(recorded.occurrenceKey, {
      id: charge.id,
      date: charge.date,
      amount: num(charge.amount),
      currency: charge.currency,
      originalAmount: charge.originalAmount === null ? null : num(charge.originalAmount),
      originalCurrency: charge.originalCurrency,
      accountId: charge.accountId,
      isContributionTwin: manualContributionIdFromTransaction(charge) !== null,
      alreadyRecorded: true,
    });
    if (settlementClaimed(recorded)) plan.claimed.add(recorded.occurrenceKey);
  }

  const occurrences: SettlementOccurrence[] = [];
  for (const { row, dates } of walks) {
    let left = row.remainingOccurrences ?? Number.POSITIVE_INFINITY;
    for (const due of dates) {
      if (left <= 0) break;
      const key = recurringExternalId(row.id, due);
      if (rolledPast(plan, key)) continue;
      // Already settled: one installment accounted for, nothing to match.
      if (plan.settledBy.has(key)) {
        left -= 1;
        continue;
      }
      occurrences.push({
        itemId: row.id,
        due,
        nextDue: advanceDate(due, row.frequency, row.anchorDay, row.secondAnchorDay),
        ...(goalReached.has(row.id) ? { contributionTwinOnly: true } : {}),
      });
      left -= 1;
    }
  }
  for (const [key, charge] of plan.settledBy) {
    const kind = kindById.get(itemIdFromOccurrenceKey(key) ?? "");
    if (kind) plan.byCharge.set(charge.id, { key, kind });
  }
  const span = settlementSpan(occurrences);
  if (!span) return plan;

  // The look-alike guard is judged over every active item, not only the ones
  // with something due by `through`.
  const guardRows = await prisma.recurringItem.findMany({
    where: { active: true },
    select: { id: true, name: true, amount: true, currency: true, categoryId: true, kind: true, goalId: true },
  });
  const items: SettlementItem[] = guardRows.map((row) => ({
    ...row,
    amount: num(row.amount),
    goalId: row.kind === "CONTRIBUTION" ? row.goalId : null,
  }));

  const chargeRows = await prisma.transaction.findMany({
    where: {
      type: "EXPENSE",
      source: { not: "RECURRING" },
      recurringSettlement: { is: null },
      date: { gte: span.start, lte: span.end },
      ...(options.replacing ? { id: { not: options.replacing } } : {}),
    },
    select: {
      id: true,
      date: true,
      amount: true,
      currency: true,
      originalAmount: true,
      originalCurrency: true,
      categoryId: true,
      note: true,
      accountId: true,
      source: true,
      externalId: true,
    },
  });
  const twinContributionIds = chargeRows
    .map((row) => manualContributionIdFromTransaction(row))
    .filter((id): id is string => id !== null);
  const goalByContributionId = new Map(
    twinContributionIds.length
      ? (
          await prisma.goalContribution.findMany({
            where: { id: { in: twinContributionIds } },
            select: { id: true, goalId: true },
          })
        ).map((contribution) => [contribution.id, contribution.goalId])
      : [],
  );

  const charges: SettlementCharge[] = [];
  const plannedById = new Map<string, PlannedCharge>();
  for (const row of chargeRows) {
    const contributionId = manualContributionIdFromTransaction(row);
    const contributionGoalId = contributionId === null ? null : (goalByContributionId.get(contributionId) ?? null);
    // A contribution's own expense whose contribution is gone belongs to no
    // goal any more; it is nobody's payment of anything.
    if (contributionId !== null && contributionGoalId === null) continue;
    const amount = num(row.amount);
    const originalAmount = row.originalAmount === null ? null : num(row.originalAmount);
    charges.push({
      id: row.id,
      date: row.date,
      amount,
      currency: row.currency,
      originalAmount,
      originalCurrency: row.originalCurrency,
      categoryId: row.categoryId,
      note: row.note,
      contributionGoalId,
    });
    plannedById.set(row.id, {
      id: row.id,
      date: row.date,
      amount,
      currency: row.currency,
      originalAmount,
      originalCurrency: row.originalCurrency,
      accountId: row.accountId,
      isContributionTwin: contributionId !== null,
    });
  }

  if (options.hypothetical) {
    const { accountId, ...charge } = options.hypothetical;
    charges.push({ ...charge, id: HYPOTHETICAL_CHARGE_ID });
    plannedById.set(HYPOTHETICAL_CHARGE_ID, {
      id: HYPOTHETICAL_CHARGE_ID,
      date: charge.date,
      amount: charge.amount,
      currency: charge.currency,
      originalAmount: charge.originalAmount ?? null,
      originalCurrency: charge.originalCurrency ?? null,
      accountId,
      isContributionTwin: charge.contributionGoalId !== null,
    });
  }

  for (const [key, chargeId] of planSettlements({ items, occurrences, charges })) {
    plan.settledBy.set(key, plannedById.get(chargeId) as PlannedCharge);
    const kind = kindById.get(itemIdFromOccurrenceKey(key) ?? "");
    if (kind) plan.byCharge.set(chargeId, { key, kind });
  }
  return plan;
}

/**
 * Every charge dated on or before `through` that pays a recurring occurrence,
 * by charge id, with the occurrence's key and its item's kind: the pairings
 * the settlement plan makes before posting records them. A charge can pay an
 * occurrence due up to SETTLEMENT_LEAD_DAYS after it, so the plan reaches
 * that far past `through`; its due-date order keeps every earlier pairing
 * what it would be planned through `through` alone. Budget spending (K6)
 * leaves these out exactly as it leaves out a charge whose RecurringSettlement
 * posting already wrote - the period commitments count the occurrence as
 * settled either way.
 */
export async function loadPairedCharges(through: Date): Promise<Map<string, { key: string; kind: RecurringKind }>> {
  return (await loadSettlementPlan(addDays(through, SETTLEMENT_LEAD_DAYS))).byCharge;
}

/**
 * The automatic contribution a hand-logged one would pay, if the settlement
 * plan pairs it: the occurrence's due date and its item's name, else null.
 * `twin` is the contribution's own expense as logManualContribution would
 * write it (in the account's currency, the goal's figure kept beside it).
 * The pairing itself is posting's (B16): a hand-logged contribution of the
 * automatic one's amount, to its goal, inside its window, counts as it.
 * `replacing` is the stored expense of a contribution being edited, which
 * the edited one is judged in place of.
 */
export async function contributionWouldSettle(
  twin: Omit<HypotheticalCharge, "id">,
  options: { replacing?: string } = {},
): Promise<{ dueDate: Date; itemName: string } | null> {
  const plan = await loadSettlementPlan(addDays(twin.date, SETTLEMENT_LEAD_DAYS), { hypothetical: twin, replacing: options.replacing });
  return settledOccurrence(plan.byCharge.get(HYPOTHETICAL_CHARGE_ID)?.key);
}

/** The automatic contribution the stored charge `transactionId` (dated `date`) pays, as contributionWouldSettle reports it. */
export async function contributionSettles(transactionId: string, date: Date): Promise<{ dueDate: Date; itemName: string } | null> {
  const paired = (await loadPairedCharges(date)).get(transactionId);
  return paired?.kind === "CONTRIBUTION" ? settledOccurrence(paired.key) : null;
}

async function settledOccurrence(key: string | undefined): Promise<{ dueDate: Date; itemName: string } | null> {
  if (!key) return null;
  const itemId = itemIdFromOccurrenceKey(key);
  const dueDate = fromISODate(key.slice(key.lastIndexOf(":") + 1));
  if (!itemId || !dueDate) return null;
  const item = await prisma.recurringItem.findUnique({ where: { id: itemId }, select: { name: true } });
  return { dueDate, itemName: item?.name ?? "" };
}
