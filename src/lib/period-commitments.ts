/**
 * A pay period's commitments, one occurrence at a time - the one definition
 * of "what the recurring items ask of this period" that the period summary,
 * the payday check-in, Afford, the room check, the From Afford tracker, the
 * monthly pace and Next 7 days all read. Pure and database-free: the loader
 * is src/lib/data/period-commitments.ts.
 *
 * The rules:
 *
 *   - A subscription's occurrence belongs to the period its due date falls
 *     in. A contribution's belongs to the period whose funding window
 *     (fundingPeriodFor in src/lib/period.ts) holds the day its money moves -
 *     its due date, or the day of the charge that paid it - the attribution
 *     the goal plan counts contributed money by (K3): one due on a payday is
 *     the next period's, paid from the pay that landed that day.
 *   - A backlog - an occurrence due before today and not yet paid - is owed
 *     now, so it is filed in the current period. Every backlog occurrence
 *     counts, up to the item's countdown, because posting will charge each
 *     of them; a period after the current one never holds an occurrence due
 *     before it starts.
 *   - What posting already did is read from the ledger, at the ledger's
 *     amount: a RECURRING row is "posted", a RecurringSettlement (a charge
 *     the user entered that paid the occurrence) is "settled". Both carry the
 *     occurrence's key (recurringExternalId), so nothing is counted twice.
 *   - An occurrence still ahead on the schedule is "settled" when posting's
 *     settlement plan (planSettlements in src/lib/recurring-settlement.ts)
 *     already pairs a charge with it, "posted" when its RECURRING row already
 *     exists (a nextDate moved back onto a posted day), otherwise
 *     "outstanding".
 *   - An item posting will skip (skipReasonFor: no account, no goal, an
 *     archived account, a goal already reached) is "wont_post", with its
 *     reason. It is left out of every total and listed where items are
 *     listed, so a charge that will never leave is neither counted nor
 *     hidden. So is a contribution posting will find its goal already
 *     funded for (goal_achieved): a goal's outstanding contributions are
 *     taken in due order, each while what the goal holds by its day - its
 *     contributions dated by then and the earlier ones counted here - is
 *     still short of the target, as posting judges it.
 *
 * whole() is what the period costs: posted + settled + outstanding. A plan
 * for the period subtracts it from the period's whole income. outstanding()
 * is what is still to leave: the "Committed" figure. Each occurrence's
 * cost is taken through wholeAmount() and outstandingAmount(), the one place
 * what an occurrence asks is reduced: by the deposits the user earmarked for
 * it (src/lib/earmarks.ts), whether it is still to come or already posted.
 * The occurrence's `amount` stays what the charge is - the posted row's bank
 * amount, or the schedule's.
 */
import { convert, type RateTable } from "@/lib/currency";
import { coverOccurrence, type OccurrenceEarmark } from "@/lib/earmarks";
import { addDays } from "@/lib/date";
import { round2 } from "@/lib/money";
import { fundingPeriodFor, periodForDate, type PayLanded, type PeriodInfo } from "@/lib/period";
import {
  advanceDate,
  skipReasonFor,
  type PostingLinks,
  type RecurringSkipReason,
  type ScheduledItem,
} from "@/lib/recurring";
import { recurringExternalId, SETTLEMENT_LEAD_DAYS } from "@/lib/recurring-settlement";

import type { RecurringKind } from "@/generated/prisma/enums";

export type OccurrenceStatus = "posted" | "settled" | "outstanding" | "wont_post";

/** The charge the user entered that paid an occurrence. */
export interface OccurrenceCharge {
  transactionId: string;
  date: Date;
  amount: number;
  currency: string;
  accountId: string | null;
  /** A hand-logged contribution's own expense: its money is already among the goal's contributions. */
  contributionTwin?: boolean;
}

export interface CommitmentOccurrence {
  /** recurringExternalId(itemId, dueDate): the RECURRING row's externalId, the settlement's occurrenceKey. */
  key: string;
  itemId: string;
  name: string;
  kind: RecurringKind;
  /** CONTRIBUTION only: the goal it pays into. */
  goalId: string | null;
  dueDate: Date;
  /** The period it is filed in: its due date's (a contribution's: the funding period of the day its money moves), or the current period for a backlog occurrence. */
  periodKey: string;
  /** Due before today and still unpaid, so filed in the current period. */
  backlog: boolean;
  status: OccurrenceStatus;
  /** Set on a wont_post occurrence: why posting skips the item. */
  wontPostReason: RecurringSkipReason | null;
  /**
   * "ledger": read from what posting already wrote (a RECURRING row or a
   * RecurringSettlement); the item's schedule has moved past it. "schedule":
   * walked from the item's nextDate.
   */
  source: "ledger" | "schedule";
  /** The account the money leaves: the ledger row's or charge's, else the item's. Null when none is set. */
  accountId: string | null;
  /** What the occurrence costs, in `currency` - the funding account's currency, or the item's own when it has no account. */
  amount: number;
  currency: string;
  /** The same as recorded: the ledger row or charge in its own currency for a posted or settled one, the item's charge otherwise. */
  sourceAmount: number;
  sourceCurrency: string;
  /** One charge of the item as scheduled, in the item's currency. */
  itemAmount: number;
  itemCurrency: string;
  /** Set on a settled occurrence: the charge that paid it. */
  settledBy: OccurrenceCharge | null;
  /**
   * What deposits the user earmarked for it cover, in `currency`: never more
   * than `amount`, and 0 for one posting will skip. wholeAmount and
   * outstandingAmount subtract it.
   */
  earmarked: number;
  /** The deposits behind `earmarked`, each part in `currency`, in the order they arrived. */
  earmarks: OccurrenceEarmark[];
}

/** An active item with what the walk and the skip rule need. */
export interface CommitmentItem extends ScheduledItem, PostingLinks {
  id: string;
  name: string;
  amount: number;
  currency: string;
}

/** An occurrence posting already consumed: its RECURRING row, or the settlement it persisted. */
export interface LedgerFact {
  key: string;
  itemId: string;
  dueDate: Date;
  status: "posted" | "settled";
  amount: number;
  currency: string;
  accountId: string | null;
  settledBy: OccurrenceCharge | null;
}

/** Name, kind and schedule charge of an item a ledger fact belongs to, when it is not among the active items (paused, finished or deleted since). */
export interface LedgerItemInfo {
  name: string;
  kind: RecurringKind;
  goalId: string | null;
  amount: number;
  currency: string;
}

/** posting's settlement plan (loadSettlementPlan), in the shape the planner reads. */
export interface CommitmentSettlementPlan {
  posted: ReadonlySet<string>;
  /** Settled occurrences posting already claimed: walked past without counting, as posted ones are. */
  claimed?: ReadonlySet<string>;
  settledBy: ReadonlyMap<string, OccurrenceCharge>;
}

/** Never walk more occurrences of one item than this, however far behind it has fallen. */
const MAX_SCHEDULE_WALK = 400;

/** One date an item's schedule still owes, and the period it is filed in. */
export interface ScheduledDate {
  dueDate: Date;
  periodKey: string;
  /** Due before today, so filed in the current period. */
  backlog: boolean;
}

/**
 * The dates `item` still owes, walked from its nextDate exactly as posting
 * walks them (advanceDate: the stored anchor, SEMI_MONTHLY's two anchors,
 * month-end clamping), each filed in its period - a date before today in the
 * current period. A finite item stops at its countdown, spent the way posting
 * spends it: a date `alreadyPosted` names (its RECURRING row exists, or
 * posting already settled it) is rolled past without spending an installment. `through` bounds the walk; without
 * it, only the countdown (or the walk cap) does.
 */
export function scheduleDates(
  item: ScheduledItem,
  today: Date,
  options: { through?: Date; currentPeriodKey?: string; alreadyPosted?: (due: Date) => boolean } = {},
): ScheduledDate[] {
  const currentKey = options.currentPeriodKey ?? periodForDate(today).key;
  let left = item.remainingOccurrences ?? Number.POSITIVE_INFINITY;
  const dates: ScheduledDate[] = [];
  let cursor = item.nextDate;
  for (let i = 0; i < MAX_SCHEDULE_WALK && left > 0; i += 1) {
    if (options.through && cursor.getTime() > options.through.getTime()) break;
    const posted = options.alreadyPosted?.(cursor) ?? false;
    const backlog = !posted && cursor.getTime() < today.getTime();
    dates.push({ dueDate: cursor, periodKey: backlog ? currentKey : periodForDate(cursor).key, backlog });
    if (!posted) left -= 1;
    cursor = advanceDate(cursor, item.frequency, item.anchorDay, item.secondAnchorDay);
  }
  return dates;
}

export interface PlanCommitmentsInput {
  periods: readonly PeriodInfo[];
  today: Date;
  /** Every active item with anything due by the last period's end. */
  items: readonly CommitmentItem[];
  /** What posting already consumed in the periods' date range. */
  facts: readonly LedgerFact[];
  /** Items the facts belong to that are not in `items`, by id. */
  ledgerItems: ReadonlyMap<string, LedgerItemInfo>;
  settlement: CommitmentSettlementPlan;
  /** Every account's currency, archived ones included. */
  accountCurrency: ReadonlyMap<string, string>;
  rates: RateTable;
  /** Leaves one item's schedule out (never its ledger facts): the tracker's re-check of a plan judges the plan's own installments. */
  excludeItemId?: string | null;
  /** The deposits earmarked for each occurrence, by occurrence key, already bounded by each deposit (boundByDeposit). */
  earmarks?: ReadonlyMap<string, readonly OccurrenceEarmark[]>;
  /** When each period's pay landed (loadPayLanded), which opens the funding window a contribution is filed by; absent: every window opens on its payday. */
  payLanded?: PayLanded;
  /** The goals the active contributions pay into, by id, for the goal_achieved cap; absent: no cap. */
  goals?: ReadonlyMap<string, CommitmentGoal>;
}

/** A goal as posting judges whether it still needs a contribution (postOccurrence): its target and every contribution, in its own currency. */
export interface CommitmentGoal {
  target: number;
  currency: string;
  contributions: readonly { amount: number; currency: string; date: Date }[];
}

/** What `goal` holds on `day`: its contributions dated then or before, summed into its currency as rebuildGoalSaved sums them. */
function goalSavedOn(goal: CommitmentGoal, day: Date, rates: RateTable): number {
  return round2(
    goal.contributions.reduce(
      (total, contribution) =>
        contribution.date.getTime() > day.getTime()
          ? total
          : total +
            (contribution.currency === goal.currency
              ? contribution.amount
              : convert(contribution.amount, contribution.currency, goal.currency, rates)),
      0,
    ),
  );
}

/**
 * Every period's occurrences, keyed by period key, in due-date order. A
 * period in `periods` with nothing owed has an empty list.
 */
export function planCommitments(input: PlanCommitmentsInput): Map<string, CommitmentOccurrence[]> {
  const result = new Map<string, CommitmentOccurrence[]>(input.periods.map((period) => [period.key, []]));
  if (input.periods.length === 0) return result;
  const through = input.periods.reduce(
    (latest, period) => (period.end.getTime() > latest.getTime() ? period.end : latest),
    input.periods[0].end,
  );
  const currentKey = periodForDate(input.today).key;
  const payLanded: PayLanded = input.payLanded ?? (() => null);
  // Where an occurrence is filed when it is not a backlog: a subscription's
  // by its due date, a contribution's by the funding window of the day its
  // money moves.
  const filedKey = (kind: RecurringKind, dueDate: Date, movedOn: Date) =>
    kind === "CONTRIBUTION" ? fundingPeriodFor(movedOn, payLanded).key : periodForDate(dueDate).key;
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const inAccountCurrency = (amount: number, currency: string, accountId: string | null) => {
    const accountCurrency = accountId ? input.accountCurrency.get(accountId) : undefined;
    return accountCurrency
      ? { amount: convert(amount, currency, accountCurrency, input.rates), currency: accountCurrency }
      : { amount, currency };
  };

  const counted = new Set<string>();
  for (const fact of input.facts) {
    if (counted.has(fact.key)) continue;
    const item = itemById.get(fact.itemId);
    const info = item
      ? { name: item.name, kind: item.kind, goalId: item.goalId, amount: item.amount, currency: item.currency }
      : input.ledgerItems.get(fact.itemId);
    const kind = info?.kind ?? "SUBSCRIPTION";
    const periodKey = filedKey(kind, fact.dueDate, fact.settledBy?.date ?? fact.dueDate);
    const bucket = result.get(periodKey);
    if (!bucket) continue;
    counted.add(fact.key);
    bucket.push({
      key: fact.key,
      itemId: fact.itemId,
      name: info?.name ?? "",
      kind,
      goalId: info?.kind === "CONTRIBUTION" ? (info.goalId ?? null) : null,
      dueDate: fact.dueDate,
      periodKey,
      backlog: false,
      status: fact.status,
      wontPostReason: null,
      source: "ledger",
      accountId: fact.accountId,
      ...inAccountCurrency(fact.amount, fact.currency, fact.accountId),
      sourceAmount: fact.amount,
      sourceCurrency: fact.currency,
      itemAmount: info?.amount ?? fact.amount,
      itemCurrency: info?.currency ?? fact.currency,
      settledBy: fact.settledBy,
      earmarked: 0,
      earmarks: [],
    });
  }

  // Every date the schedules still owe, through the last period's end - and
  // a few days past it, since a contribution due then may already have been
  // paid by a charge dated inside the last period.
  const entries: {
    item: CommitmentItem;
    date: ScheduledDate;
    key: string;
    status: OccurrenceStatus;
    reason: RecurringSkipReason | null;
    settledBy: OccurrenceCharge | undefined;
  }[] = [];
  for (const item of input.items) {
    if (item.id === input.excludeItemId) continue;
    const reason = skipReasonFor(item);
    const dates = scheduleDates(item, input.today, {
      through: addDays(through, SETTLEMENT_LEAD_DAYS),
      currentPeriodKey: currentKey,
      alreadyPosted: (due) => {
        const key = recurringExternalId(item.id, due);
        return input.settlement.posted.has(key) || (input.settlement.claimed?.has(key) ?? false);
      },
    });
    for (const date of dates) {
      const key = recurringExternalId(item.id, date.dueDate);
      if (counted.has(key)) continue;
      const settledBy = reason ? undefined : input.settlement.settledBy.get(key);
      const status: OccurrenceStatus = reason
        ? "wont_post"
        : input.settlement.posted.has(key)
          ? "posted"
          : settledBy
            ? "settled"
            : "outstanding";
      entries.push({ item, date, key, status, reason, settledBy });
    }
  }
  if (input.goals) capContributions(entries, input.goals, input.today, input.rates);

  for (const { item, date, key, status, reason, settledBy } of entries) {
    // Paid is paid: a settled or posted occurrence stays in its own period
    // whatever today is; only an unpaid one due before today is a backlog.
    const paid = status === "posted" || status === "settled";
    const periodKey =
      paid || !date.backlog ? filedKey(item.kind, date.dueDate, settledBy?.date ?? date.dueDate) : date.periodKey;
    const bucket = result.get(periodKey);
    if (!bucket) continue;
    counted.add(key);
    const accountId = settledBy ? settledBy.accountId : item.accountId;
    const sourceAmount = settledBy ? settledBy.amount : item.amount;
    const sourceCurrency = settledBy ? settledBy.currency : item.currency;
    bucket.push({
      key,
      itemId: item.id,
      name: item.name,
      kind: item.kind,
      goalId: item.kind === "CONTRIBUTION" ? item.goalId : null,
      dueDate: date.dueDate,
      periodKey,
      backlog: !paid && date.backlog,
      status,
      wontPostReason: reason,
      source: "schedule",
      accountId,
      ...inAccountCurrency(sourceAmount, sourceCurrency, accountId),
      sourceAmount,
      sourceCurrency,
      itemAmount: item.amount,
      itemCurrency: item.currency,
      settledBy: settledBy ?? null,
      earmarked: 0,
      earmarks: [],
    });
  }

  if (input.earmarks) applyEarmarks(result, input.earmarks, input.rates);

  for (const bucket of result.values()) {
    bucket.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.itemId.localeCompare(b.itemId));
  }
  return result;
}

/**
 * Marks the contributions posting will skip because their goal is funded by
 * then (goal_achieved), the way postOccurrence decides it: each goal's
 * outstanding occurrences in due order, every one posting while what the goal
 * holds on its day - the contributions dated by then (by today for one
 * already overdue), plus the earlier ones counted here and the ones a
 * charge other than a hand-logged contribution pays - is short of the
 * target. A contribution is posted whole, so the one that reaches the target
 * counts in full; every one after it is skipped.
 */
function capContributions(
  entries: { item: CommitmentItem; date: ScheduledDate; status: OccurrenceStatus; reason: RecurringSkipReason | null; settledBy: OccurrenceCharge | undefined }[],
  goals: ReadonlyMap<string, CommitmentGoal>,
  today: Date,
  rates: RateTable,
): void {
  const ordered = entries
    .filter((entry) => entry.item.kind === "CONTRIBUTION" && entry.item.goalId && goals.has(entry.item.goalId))
    .sort((a, b) => a.date.dueDate.getTime() - b.date.dueDate.getTime() || a.item.id.localeCompare(b.item.id));
  const added = new Map<string, number>();
  for (const entry of ordered) {
    const goalId = entry.item.goalId as string;
    const goal = goals.get(goalId) as CommitmentGoal;
    const amount = convert(entry.item.amount, entry.item.currency, goal.currency, rates);
    if (entry.status === "settled") {
      if (!entry.settledBy?.contributionTwin) added.set(goalId, (added.get(goalId) ?? 0) + amount);
      continue;
    }
    if (entry.status !== "outstanding" || goal.target <= 0) continue;
    const day = entry.date.dueDate.getTime() < today.getTime() ? today : entry.date.dueDate;
    if (round2(goalSavedOn(goal, day, rates) + (added.get(goalId) ?? 0)) >= goal.target) {
      entry.status = "wont_post";
      entry.reason = "goal_achieved";
      continue;
    }
    added.set(goalId, (added.get(goalId) ?? 0) + amount);
  }
}

/**
 * Sets on each planned occurrence what the user earmarked for it
 * (`earmarks`, by occurrence key, already bounded by each deposit), in its
 * currency and never more than it costs. One posting will skip costs
 * nothing, so nothing covers it. The loader reads the earmarks once the
 * occurrences are planned, for exactly their keys.
 */
export function applyEarmarks(
  planned: ReadonlyMap<string, readonly CommitmentOccurrence[]>,
  earmarks: ReadonlyMap<string, readonly OccurrenceEarmark[]>,
  rates: RateTable,
): void {
  for (const bucket of planned.values()) {
    for (const occurrence of bucket) {
      const forKey = earmarks.get(occurrence.key);
      if (!forKey || forKey.length === 0 || occurrence.status === "wont_post") continue;
      const cover = coverOccurrence(occurrence.amount, occurrence.currency, forKey, rates);
      occurrence.earmarked = cover.earmarked;
      occurrence.earmarks = cover.earmarks;
    }
  }
}

/** What the period costs: every occurrence posting will charge or already has - wont_post left out. */
export function whole(occurrences: readonly CommitmentOccurrence[]): CommitmentOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.status !== "wont_post");
}

/** What is still to leave: the occurrences neither posted nor paid. */
export function outstanding(occurrences: readonly CommitmentOccurrence[]): CommitmentOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.status === "outstanding");
}

/** The occurrences posting will skip, each with its reason. */
export function wontPost(occurrences: readonly CommitmentOccurrence[]): CommitmentOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.status === "wont_post");
}

/**
 * What an occurrence still asks of the period, in its `currency`: its amount
 * less what is earmarked for it while outstanding, nothing once posted, paid
 * or skipped.
 */
export function outstandingAmount(occurrence: CommitmentOccurrence): number {
  return occurrence.status === "outstanding" ? Math.max(0, occurrence.amount - occurrence.earmarked) : 0;
}

/**
 * What an occurrence costs the period, in its `currency`: its amount less
 * what is earmarked for it - posted, paid or still to come - and nothing for
 * one posting will skip.
 */
export function wholeAmount(occurrence: CommitmentOccurrence): number {
  return occurrence.status === "wont_post" ? 0 : Math.max(0, occurrence.amount - occurrence.earmarked);
}

/**
 * What still leaves the account for an occurrence, in its `currency`: the
 * charge itself while outstanding - an earmark changes what the charge asks
 * of the plan, not what the bank takes. For readers of money leaving rather
 * than of the plan's cost: the monthly pace's spending still due.
 */
export function outstandingCharge(occurrence: CommitmentOccurrence): number {
  return occurrence.status === "outstanding" ? occurrence.amount : 0;
}

/** Occurrences summed into `currency` through `amountOf` (wholeAmount or outstandingAmount), unrounded. */
export function sumOccurrences(
  occurrences: readonly CommitmentOccurrence[],
  currency: string,
  rates: RateTable,
  amountOf: (occurrence: CommitmentOccurrence) => number,
): number {
  return occurrences.reduce(
    (total, occurrence) => total + convert(amountOf(occurrence), occurrence.currency, currency, rates),
    0,
  );
}

/** Occurrences grouped by item, items in the order of their first due date. */
export function byItem(occurrences: readonly CommitmentOccurrence[]): CommitmentOccurrence[][] {
  const groups = new Map<string, CommitmentOccurrence[]>();
  const ordered = [...occurrences].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.itemId.localeCompare(b.itemId),
  );
  for (const occurrence of ordered) {
    const group = groups.get(occurrence.itemId);
    if (group) group.push(occurrence);
    else groups.set(occurrence.itemId, [occurrence]);
  }
  return [...groups.values()];
}
