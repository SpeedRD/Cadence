/**
 * Loads what planCommitments (src/lib/period-commitments.ts) needs and runs
 * it: the active items and their schedules, what posting already consumed in
 * the periods' date range (RECURRING rows and RecurringSettlement rows), and
 * posting's own settlement plan (loadSettlementPlan) for the occurrences
 * still ahead - planned through the last period's end, the same call the
 * payday check-in has always made for its plan period. Nothing here decides
 * whether a charge paid an occurrence; posting's matcher does.
 */
import { num } from "@/lib/money";
import {
  planCommitments,
  type CommitmentItem,
  type CommitmentOccurrence,
  type LedgerFact,
  type LedgerItemInfo,
  type OccurrenceCharge,
} from "@/lib/period-commitments";
import { type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { itemIdFromOccurrenceKey } from "@/lib/recurring-settlement";
import { fromISODate } from "@/lib/date";

import { loadSettlementPlan } from "@/lib/data/recurring-settlement";

import type { AppContext } from "@/lib/data/context";

/** The date inside a recurringExternalId ("<itemId>:<YYYY-MM-DD>"), or null for anything not shaped like one. */
function dueDateFromOccurrenceKey(key: string): Date | null {
  const separator = key.lastIndexOf(":");
  return separator > 0 ? fromISODate(key.slice(separator + 1)) : null;
}

/**
 * Every period's occurrences (see planCommitments), keyed by period key.
 * `excludeItemId` leaves one item's schedule out, never its ledger facts.
 */
export async function loadCommitments(
  periods: readonly PeriodInfo[],
  context: Pick<AppContext, "today" | "rates">,
  options: { excludeItemId?: string | null } = {},
): Promise<Map<string, CommitmentOccurrence[]>> {
  if (periods.length === 0) return new Map();
  const start = periods.reduce((earliest, p) => (p.start.getTime() < earliest.getTime() ? p.start : earliest), periods[0].start);
  const end = periods.reduce((latest, p) => (p.end.getTime() > latest.getTime() ? p.end : latest), periods[0].end);
  // A period already over holds only what posting wrote in it: its unpaid
  // occurrences are a backlog of the current period, not its own. With no
  // period still running or ahead there is no schedule to walk.
  const scheduleNeeded = end.getTime() >= context.today.getTime();

  const [itemRows, postedRows, settlementRows, accounts, settlementPlan] = await Promise.all([
    scheduleNeeded
      ? prisma.recurringItem.findMany({
          where: { active: true, nextDate: { lte: end } },
          select: {
            id: true,
            name: true,
            kind: true,
            amount: true,
            currency: true,
            frequency: true,
            nextDate: true,
            anchorDay: true,
            secondAnchorDay: true,
            remainingOccurrences: true,
            accountId: true,
            goalId: true,
            account: { select: { status: true } },
            goal: { select: { achievedAt: true } },
          },
        })
      : [],
    prisma.transaction.findMany({
      where: { source: "RECURRING", type: "EXPENSE", date: { gte: start, lte: end }, externalId: { not: null } },
      select: { externalId: true, date: true, amount: true, currency: true, accountId: true, note: true },
    }),
    prisma.recurringSettlement.findMany({
      where: { dueDate: { gte: start, lte: end } },
      select: {
        occurrenceKey: true,
        recurringItemId: true,
        kind: true,
        dueDate: true,
        transaction: { select: { id: true, date: true, amount: true, currency: true, accountId: true } },
      },
    }),
    prisma.account.findMany({ select: { id: true, currency: true } }),
    scheduleNeeded ? loadSettlementPlan(end) : null,
  ]);

  const facts: LedgerFact[] = [];
  for (const row of postedRows) {
    const key = row.externalId as string;
    const itemId = itemIdFromOccurrenceKey(key);
    if (!itemId) continue;
    facts.push({
      key,
      itemId,
      dueDate: dueDateFromOccurrenceKey(key) ?? row.date,
      status: "posted",
      amount: num(row.amount),
      currency: row.currency,
      accountId: row.accountId,
      settledBy: null,
    });
  }
  for (const row of settlementRows) {
    const charge: OccurrenceCharge = {
      transactionId: row.transaction.id,
      date: row.transaction.date,
      amount: num(row.transaction.amount),
      currency: row.transaction.currency,
      accountId: row.transaction.accountId,
    };
    const itemId = row.recurringItemId ?? itemIdFromOccurrenceKey(row.occurrenceKey);
    if (!itemId) continue;
    facts.push({
      key: row.occurrenceKey,
      itemId,
      dueDate: row.dueDate,
      status: "settled",
      amount: charge.amount,
      currency: charge.currency,
      accountId: charge.accountId,
      settledBy: charge,
    });
  }

  // Name, kind and charge of the items behind facts that are no longer
  // active (paused, finished, deleted): a ledger fact counts whatever the
  // item's state now, so it needs a label and a kind of its own.
  const activeIds = new Set(itemRows.map((row) => row.id));
  const missingIds = [...new Set(facts.map((fact) => fact.itemId).filter((id) => !activeIds.has(id)))];
  const ledgerItems = new Map<string, LedgerItemInfo>();
  if (missingIds.length > 0) {
    const [rows, contributionKeys] = await Promise.all([
      prisma.recurringItem.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true, kind: true, goalId: true, amount: true, currency: true },
      }),
      prisma.goalContribution.findMany({
        where: { recurringExternalId: { in: facts.filter((fact) => missingIds.includes(fact.itemId)).map((fact) => fact.key) } },
        select: { recurringExternalId: true, goalId: true },
      }),
    ]);
    for (const row of rows) {
      ledgerItems.set(row.id, { name: row.name, kind: row.kind, goalId: row.goalId, amount: num(row.amount), currency: row.currency });
    }
    // A deleted item leaves only its rows: the posted row's note is the
    // item's name (postOccurrence writes it), the settlement row keeps the
    // kind, and a contribution's row has a GoalContribution with its key.
    const goalByKey = new Map(contributionKeys.map((row) => [row.recurringExternalId as string, row.goalId]));
    for (const fact of facts) {
      if (activeIds.has(fact.itemId) || ledgerItems.has(fact.itemId)) continue;
      const posted = postedRows.find((row) => row.externalId === fact.key);
      const settled = settlementRows.find((row) => row.occurrenceKey === fact.key);
      const goalId = goalByKey.get(fact.key) ?? null;
      ledgerItems.set(fact.itemId, {
        name: posted?.note ?? "",
        kind: settled?.kind ?? (goalId ? "CONTRIBUTION" : "SUBSCRIPTION"),
        goalId,
        amount: fact.amount,
        currency: fact.currency,
      });
    }
  }

  const items: CommitmentItem[] = itemRows.map((row) => ({ ...row, amount: num(row.amount) }));
  const settledBy = new Map<string, OccurrenceCharge>();
  for (const [key, charge] of settlementPlan?.settledBy ?? []) {
    settledBy.set(key, {
      transactionId: charge.id,
      date: charge.date,
      amount: charge.amount,
      currency: charge.currency,
      accountId: charge.accountId,
    });
  }

  return planCommitments({
    periods,
    today: context.today,
    items,
    facts,
    ledgerItems,
    settlement: { posted: settlementPlan?.posted ?? new Set(), settledBy },
    accountCurrency: new Map(accounts.map((account) => [account.id, account.currency])),
    rates: context.rates,
    excludeItemId: options.excludeItemId,
  });
}

/** One period's occurrences (see planCommitments), in due-date order. */
export async function periodCommitments(
  period: PeriodInfo,
  context: Pick<AppContext, "today" | "rates">,
): Promise<CommitmentOccurrence[]> {
  return (await loadCommitments([period], context)).get(period.key) ?? [];
}
