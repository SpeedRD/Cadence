/**
 * Loads what planCommitments (src/lib/period-commitments.ts) needs and runs
 * it: the active items and their schedules, what posting already consumed
 * for occurrences due in the periods' date range (RECURRING rows and
 * RecurringSettlement rows - each by its occurrence's due date, never by the
 * date a row was later edited to), and
 * posting's own settlement plan (loadSettlementPlan) for the occurrences
 * still ahead - planned through the last period's end, the same call the
 * payday check-in has always made for its plan period - and the deposits
 * the user earmarked for the occurrences planned (src/lib/data/earmarks.ts),
 * which lower what each asks. Nothing here decides whether a charge paid an
 * occurrence; posting's matcher does. For the contributions it also reads when
 * each period's pay landed (loadPayLanded), which files them by funding
 * window, and their goals' contributions, which cap them at what each goal
 * still needs.
 */
import { addDays, toISODate } from "@/lib/date";
import { num, type DecimalLike } from "@/lib/money";
import {
  applyEarmarks,
  planCommitments,
  type CommitmentGoal,
  type CommitmentItem,
  type CommitmentOccurrence,
  type LedgerFact,
  type LedgerItemInfo,
  type OccurrenceCharge,
} from "@/lib/period-commitments";
import { convert } from "@/lib/currency";
import { nextPeriod, periodForDate, periodInfo, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { dueDateFromOccurrenceKey, itemIdFromOccurrenceKey, SETTLEMENT_LEAD_DAYS } from "@/lib/recurring-settlement";

import { loadOccurrenceEarmarks } from "@/lib/data/earmarks";
import { loadPayLanded } from "@/lib/data/pay-landed";
import { loadSettlementPlan } from "@/lib/data/recurring-settlement";

/**
 * How far past the periods' own days the ledger is read: a contribution is
 * filed by the funding window of the day its money moved, which opens up to
 * a week before its period's first day, and a charge may pay an occurrence
 * due anywhere in its own period or a few days around it. Anything read that
 * belongs to no period asked about is simply not filed.
 */
const LEDGER_MARGIN_DAYS = 21;

import type { AppContext } from "@/lib/data/context";

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
  // The schedule is walked a few days past the last period: a contribution
  // due then that a charge inside the last period already paid is filed there.
  const walkEnd = addDays(end, SETTLEMENT_LEAD_DAYS);
  const ledgerStart = addDays(start, -LEDGER_MARGIN_DAYS);
  const ledgerEnd = addDays(end, LEDGER_MARGIN_DAYS);
  // When pay landed, for every period a filed day can fall in or open the
  // window of.
  const fundingPeriods: PeriodInfo[] = [];
  for (let cursor = periodForDate(ledgerStart); cursor.start.getTime() <= ledgerEnd.getTime(); cursor = periodInfo(nextPeriod(cursor))) {
    fundingPeriods.push(cursor);
  }

  const [itemRows, postedRows, settlementRows, accounts, settlementPlan, payLanded] = await Promise.all([
    scheduleNeeded
      ? prisma.recurringItem.findMany({
          where: { active: true, nextDate: { lte: walkEnd } },
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
    // By the due date in the occurrence's key, as the settlements below are
    // read by theirs: a posted row whose date was edited into another period
    // still stands for the occurrence it was posted for, in that one's period.
    prisma.$queryRaw<{ externalId: string; date: Date; amount: DecimalLike; currency: string; accountId: string; note: string | null }[]>`
      SELECT "externalId", "date", "amount", "currency", "accountId", "note" FROM "Transaction"
      WHERE "source" = 'RECURRING' AND "type" = 'EXPENSE' AND "externalId" IS NOT NULL
        AND right("externalId", 10) BETWEEN ${toISODate(ledgerStart)} AND ${toISODate(ledgerEnd)}`,
    prisma.recurringSettlement.findMany({
      where: { dueDate: { gte: ledgerStart, lte: ledgerEnd } },
      select: {
        occurrenceKey: true,
        recurringItemId: true,
        kind: true,
        dueDate: true,
        transaction: { select: { id: true, date: true, amount: true, currency: true, accountId: true } },
      },
    }),
    prisma.account.findMany({ select: { id: true, currency: true } }),
    scheduleNeeded ? loadSettlementPlan(walkEnd) : null,
    loadPayLanded(fundingPeriods, context),
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
      contributionTwin: charge.isContributionTwin,
    });
  }
  // The goals the contributions pay into, as posting judges whether each
  // still needs one.
  const goalIds = [...new Set(items.filter((item) => item.kind === "CONTRIBUTION" && item.goalId).map((item) => item.goalId as string))];
  const goals = new Map<string, CommitmentGoal>(
    (goalIds.length > 0
      ? await prisma.goal.findMany({
          where: { id: { in: goalIds } },
          select: { id: true, targetAmount: true, currency: true, contributions: { select: { amount: true, currency: true, date: true } } },
        })
      : []
    ).map((goal) => [
      goal.id,
      {
        target: num(goal.targetAmount),
        currency: goal.currency,
        contributions: goal.contributions.map((row) => ({ amount: num(row.amount), currency: row.currency, date: row.date })),
      },
    ]),
  );

  const planned = planCommitments({
    periods,
    today: context.today,
    items,
    facts,
    ledgerItems,
    settlement: { posted: settlementPlan?.posted ?? new Set(), claimed: settlementPlan?.claimed ?? new Set(), settledBy },
    accountCurrency: new Map(accounts.map((account) => [account.id, account.currency])),
    rates: context.rates,
    excludeItemId: options.excludeItemId,
    payLanded,
    goals,
  });
  // The occurrences are known only once planned; what covers them is read
  // for exactly their keys.
  const keys = [...planned.values()].flat().map((occurrence) => occurrence.key);
  applyEarmarks(planned, await loadOccurrenceEarmarks(keys, context.rates), context.rates);
  return planned;
}

/** One period's occurrences (see planCommitments), in due-date order. */
export async function periodCommitments(
  period: PeriodInfo,
  context: Pick<AppContext, "today" | "rates">,
): Promise<CommitmentOccurrence[]> {
  return (await loadCommitments([period], context)).get(period.key) ?? [];
}

/**
 * What of each deposit's earmarks still covers an occurrence's cost, by
 * deposit id, in `currencyOf(depositId)`: the effective earmark K2 applies -
 * each earmark bounded by its deposit and by what its occurrence costs now
 * (applyEarmarks) - summed per deposit. An earmark whose occurrence shrank
 * covers only what it still costs; one whose occurrence no longer exists
 * (the item paused or deleted before it fell due) or will not post covers
 * nothing. The income estimate leaves out only this part (K5).
 */
export async function loadDepositCover(
  depositIds: readonly string[],
  currencyOf: (depositId: string) => string,
  context: Pick<AppContext, "today" | "rates">,
): Promise<Map<string, number>> {
  const cover = new Map<string, number>();
  if (depositIds.length === 0) return cover;
  const wanted = new Set(depositIds);
  const rows = await prisma.recurringEarmark.findMany({
    where: { transactionId: { in: [...wanted] } },
    select: { dueDate: true },
  });
  if (rows.length === 0) return cover;
  // Each occurrence's own period, and the current one, which holds an
  // unpaid occurrence due before today.
  const periods = new Map<string, PeriodInfo>();
  for (const day of [context.today, ...rows.map((row) => row.dueDate)]) {
    const period = periodForDate(day);
    periods.set(period.key, period);
  }
  for (const occurrences of (await loadCommitments([...periods.values()], context)).values()) {
    for (const occurrence of occurrences) {
      for (const earmark of occurrence.earmarks) {
        if (!wanted.has(earmark.transactionId)) continue;
        const amount = convert(earmark.amount, occurrence.currency, currencyOf(earmark.transactionId), context.rates);
        cover.set(earmark.transactionId, (cover.get(earmark.transactionId) ?? 0) + amount);
      }
    }
  }
  return cover;
}
