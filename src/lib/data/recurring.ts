import { convert, type RateTable } from "@/lib/currency";
import { addDays, today as todayInAppZone, toISODate } from "@/lib/date";
import { recomputeGoalSaved } from "@/lib/goals";
import { num, round2 } from "@/lib/money";
import { nextPeriod, periodForDate, periodInfo, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";
import { advanceDate, firstOccurrenceOnOrAfter, isFinishedPlan, monthlyEquivalent, paidPastOccurrences, semiMonthlyAnchorsCollide, skipReasonFor } from "@/lib/recurring";
import {
  planPostedDuplicates,
  planSettlements,
  recurringExternalId,
  settlementClaimed,
  settlementWindow,
} from "@/lib/recurring-settlement";
import { manualContributionIdFromTransaction } from "@/lib/transactions";

import { loadCommitments } from "@/lib/data/period-commitments";

import type { AppContext } from "@/lib/data/context";
import type { OccurrenceEarmark } from "@/lib/earmarks";
import type { Prisma } from "@/generated/prisma/client";
import type { RecurringFrequency, RecurringKind } from "@/generated/prisma/enums";

export interface RecurringRow {
  id: string;
  name: string;
  kind: RecurringKind;
  frequency: RecurringFrequency;
  amount: number;
  currency: string;
  displayAmount: number;
  monthlyDisplayAmount: number;
  nextDate: Date;
  /**
   * SEMI_MONTHLY only: the item's other due day each month, direct and
   * unclamped - unlike anchorDay (never exposed here, since it's always
   * re-derived from nextDate), the edit form needs this value as-is to
   * prefill its own dedicated field.
   */
  secondAnchorDay: number | null;
  /** The row's version when it was read, so the edit form can refuse a stale save. */
  updatedAt: Date;
  active: boolean;
  /**
   * Payments still to post for an installment plan (see the Afford
   * calculator); null for an ordinary, open-ended item. 0 with active false
   * is a plan that has finished, as opposed to one the user paused.
   */
  remainingOccurrences: number | null;
  /** Recorded by the Afford calculator's "I bought this" (RecurringItem.fromAfford); listed under "From Afford", never among the subscriptions or contributions. */
  fromAfford: boolean;
  note: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountId: string | null;
  accountName: string | null;
  goalId: string | null;
  goalName: string | null;
  /**
   * What automatic posting is waiting on, if anything: the item has no usable
   * (active) account, is a contribution with no goal, or is a contribution to
   * a goal that is already fully funded. Mirrors the skip rules in
   * src/lib/recurring-posting.ts.
   */
  needs: "account" | "goal" | "goal_achieved" | null;
  /**
   * Deposits the user set aside for its occurrences from the current period
   * on (src/lib/earmarks.ts), one entry per occurrence and deposit, soonest
   * first - each part as the period commitments apply it, in the currency of
   * the account it covers.
   */
  covered: (OccurrenceEarmark & { dueDate: Date })[];
}

/**
 * What covers each item's occurrences from the current period on, by item
 * id: the period commitments' own figures (src/lib/period-commitments.ts),
 * read through the last period an earmark names. Nothing is read beyond the
 * earmark table when there are none.
 */
async function loadCovered(context: AppContext): Promise<Map<string, RecurringRow["covered"]>> {
  const result = new Map<string, RecurringRow["covered"]>();
  const latest = await prisma.recurringEarmark.findFirst({
    where: { dueDate: { gte: context.currentPeriod.start } },
    orderBy: { dueDate: "desc" },
    select: { dueDate: true },
  });
  if (!latest) return result;
  const last = periodForDate(latest.dueDate);
  const periods: PeriodInfo[] = [context.currentPeriod];
  while (periods[periods.length - 1].key !== last.key && periods.length < 400) {
    periods.push(periodInfo(nextPeriod(periods[periods.length - 1])));
  }
  const commitments = await loadCommitments(periods, context);
  for (const occurrence of [...commitments.values()].flat()) {
    if (occurrence.earmarks.length === 0) continue;
    const list = result.get(occurrence.itemId) ?? [];
    list.push(...occurrence.earmarks.map((earmark) => ({ ...earmark, dueDate: occurrence.dueDate })));
    result.set(occurrence.itemId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return result;
}

export async function listRecurringItems(context: AppContext) {
  const [items, covered] = await Promise.all([
    prisma.recurringItem.findMany({
      include: {
        category: { select: { name: true, color: true } },
        account: { select: { name: true, status: true } },
        goal: { select: { name: true, achievedAt: true } },
      },
      orderBy: [{ active: "desc" }, { nextDate: "asc" }],
    }),
    loadCovered(context),
  ]);

  const rows: RecurringRow[] = items.map((item) => {
    const amount = num(item.amount);
    const displayAmount = convert(
      amount,
      item.currency,
      context.displayCurrency,
      context.rates,
    );
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      frequency: item.frequency,
      amount,
      currency: item.currency,
      displayAmount: round2(displayAmount),
      monthlyDisplayAmount: round2(
        monthlyEquivalent(displayAmount, item.frequency),
      ),
      nextDate: item.nextDate,
      secondAnchorDay: item.secondAnchorDay,
      updatedAt: item.updatedAt,
      active: item.active,
      remainingOccurrences: item.remainingOccurrences,
      fromAfford: item.fromAfford,
      note: item.note,
      categoryId: item.categoryId,
      categoryName: item.category?.name ?? null,
      categoryColor: item.category?.color ?? null,
      accountId: item.accountId,
      accountName: item.account?.name ?? null,
      goalId: item.goalId,
      goalName: item.goalId ? (item.goal?.name ?? null) : null,
      needs:
        !item.accountId || item.account?.status === "ARCHIVED"
          ? "account"
          : item.kind === "CONTRIBUTION" && !item.goalId
            ? "goal"
            : item.kind === "CONTRIBUTION" && item.goal?.achievedAt
              ? "goal_achieved"
              : null,
      covered: covered.get(item.id) ?? [],
    };
  });

  // A plan Afford recorded has its own section, whatever its kind: it is
  // never a subscription or a contribution here, not merely grouped apart.
  const fromAfford = rows.filter((row) => row.fromAfford);
  const subscriptions = rows.filter((row) => !row.fromAfford && row.kind === "SUBSCRIPTION");
  const contributions = rows.filter((row) => !row.fromAfford && row.kind === "CONTRIBUTION");

  const monthlyTotal = (list: RecurringRow[]) =>
    round2(
      list
        .filter((row) => row.active)
        .reduce((total, row) => total + row.monthlyDisplayAmount, 0),
    );

  return {
    subscriptions,
    contributions,
    fromAfford,
    subscriptionsMonthly: monthlyTotal(subscriptions),
    contributionsMonthly: monthlyTotal(contributions),
    fromAffordMonthly: monthlyTotal(fromAfford),
  };
}

/** Which of a recurring item's links is missing or unusable. */
export type RecurringReferenceProblem = "account" | "category" | "goal";

/**
 * Posting refuses an item on an archived account, so saving one would create
 * something that silently never posts; a stale category or goal id would
 * otherwise arrive as a raw foreign-key error. The first problem found, or
 * null when every link the item carries is usable.
 */
export async function checkRecurringReferences(
  refs: {
    accountId?: string | null;
    categoryId?: string | null;
    goalId?: string | null;
  },
  db: Prisma.TransactionClient = prisma,
): Promise<RecurringReferenceProblem | null> {
  const account = refs.accountId
    ? await db.account.findUnique({ where: { id: refs.accountId }, select: { status: true } })
    : null;
  if (!account || account.status !== "ACTIVE") return "account";
  if (refs.categoryId) {
    const category = await db.category.findUnique({
      where: { id: refs.categoryId },
      select: { id: true },
    });
    if (!category) return "category";
  }
  if (refs.goalId) {
    const goal = await db.goal.findUnique({ where: { id: refs.goalId }, select: { id: true } });
    if (!goal) return "goal";
  }
  return null;
}

/** Everything a new RecurringItem row carries, as the Recurring form's schema produces it. */
export type NewRecurringItem = Prisma.RecurringItemUncheckedCreateInput;

export type CreateRecurringItemResult =
  | { ok: true; id: string }
  | { ok: false; problem: RecurringReferenceProblem };

/**
 * The one way a RecurringItem is created: the reference checks above, then
 * the row. The Recurring form (saveRecurringAction) and an accepted pattern
 * suggestion (acceptRecurringSuggestion) both come through here, so an item
 * can never be created on an archived account by either. `db` lets a caller
 * that creates several items at once run them inside one transaction.
 */
export async function createRecurringItem(
  data: NewRecurringItem,
  db: Prisma.TransactionClient = prisma,
): Promise<CreateRecurringItemResult> {
  const problem = await checkRecurringReferences(data, db);
  if (problem) return { ok: false, problem };
  const created = await db.recurringItem.create({ data, select: { id: true } });
  return { ok: true, id: created.id };
}

/**
 * The Recurring form's values once a typed past due date is read (D46): with
 * `pastOccurrences` "paid" (the default) on an active item whose due date the
 * user typed, the occurrences before `today` count as already paid
 * (paidPastOccurrences in src/lib/recurring.ts) - nextDate moves to the first
 * one on or after today and a finite plan's countdown drops by as many. A
 * plan with every payment behind today has nothing left to record and is
 * refused. "post" keeps the values as typed, so posting charges each one.
 */
export function startAfterPaidOccurrences<
  V extends {
    nextDate: Date;
    frequency: RecurringFrequency;
    anchorDay?: number | null;
    secondAnchorDay?: number | null;
    remainingOccurrences: number | null;
    active: boolean;
  },
>(
  values: V,
  choice: { dateTyped: boolean; pastOccurrences: "paid" | "post" },
  today: Date,
): { ok: true; values: V } | { ok: false; reason: "all_paid" } {
  if (!choice.dateTyped || !values.active || choice.pastOccurrences === "post") return { ok: true, values };
  const paid = paidPastOccurrences(
    { ...values, anchorDay: values.anchorDay ?? values.nextDate.getUTCDate() },
    today,
  );
  if (!paid) return { ok: true, values };
  if (paid.allPaid) return { ok: false, reason: "all_paid" };
  return { ok: true, values: { ...values, nextDate: paid.nextDate, remainingOccurrences: paid.remainingOccurrences } };
}

/**
 * Moves each item in `scope` that is postable now and overdue to its first
 * occurrence on or after `today`, and returns what it moved. The one place the
 * skip happens, called by every transition that makes an item postable again
 * after a stretch in which it could not post - a stretch is not a backlog:
 * the occurrences it covered were never charged, so posting must not walk
 * them (postDueRecurringItems catches up on every occurrence since nextDate,
 * by design, for an item a failed run left overdue). The caller says which
 * items just changed state (`scope`); this narrows to the active ones whose
 * links let them post (skipReasonFor, the rule posting itself applies) and
 * whose date is behind. `remainingOccurrences` is not touched: a skipped
 * occurrence was not spent.
 *
 * Each move is a compare-and-swap on the nextDate it read, so a posting run
 * that claimed an occurrence in the meantime wins and the item is left as
 * that run left it.
 */
export async function skipMissedOccurrences(
  scope: Prisma.RecurringItemWhereInput,
  today: Date,
  db: Prisma.TransactionClient = prisma,
): Promise<{ id: string; from: Date; to: Date }[]> {
  const overdue = await db.recurringItem.findMany({
    where: { AND: [scope, { active: true, nextDate: { lt: today } }] },
    include: {
      account: { select: { status: true } },
      goal: { select: { achievedAt: true } },
    },
  });
  const moved: { id: string; from: Date; to: Date }[] = [];
  for (const item of overdue) {
    if (skipReasonFor(item) !== null) continue;
    const to = firstOccurrenceOnOrAfter(item, today);
    const claimed = await db.recurringItem.updateMany({
      where: { id: item.id, active: true, nextDate: item.nextDate },
      data: { nextDate: to },
    });
    if (claimed.count > 0) moved.push({ id: item.id, from: item.nextDate, to });
  }
  return moved;
}

/** Whether posting would skip this item right now, for the state it was read in - `active` included. */
function isBlocked(item: Prisma.RecurringItemGetPayload<{ include: { account: { select: { status: true } }; goal: { select: { achievedAt: true } } } }>): boolean {
  return !item.active || skipReasonFor(item) !== null;
}

export type SetActiveResult =
  | { ok: true; /** Where resuming moved nextDate to, or null when it stayed. */ movedTo: Date | null }
  | { ok: false; reason: "not_found" | "finished_plan" };

/**
 * Pauses or resumes an item. Resuming one whose nextDate is behind moves it to
 * the first occurrence on or after `today` in the same transaction as the
 * flag, so no posting run can see it active with the old date. Pausing changes
 * the flag alone.
 */
export async function setRecurringItemActive(
  id: string,
  active: boolean,
  today: Date = todayInAppZone(),
): Promise<SetActiveResult> {
  const item = await prisma.recurringItem.findUnique({ where: { id } });
  if (!item) return { ok: false, reason: "not_found" };
  // Flipping a finished plan back on would only have posting retire it again
  // on the next run, after a toast that said "Resumed". It needs new Payments
  // left first, which the edit form sets.
  if (active && isFinishedPlan(item)) return { ok: false, reason: "finished_plan" };

  if (!active) {
    await prisma.recurringItem.updateMany({ where: { id, active: true }, data: { active: false } });
    return { ok: true, movedTo: null };
  }
  return prisma.$transaction(async (tx) => {
    const resumed = await tx.recurringItem.updateMany({ where: { id, active: false }, data: { active: true } });
    if (resumed.count === 0) return { ok: true as const, movedTo: null };
    const [moved] = await skipMissedOccurrences({ id }, today, tx);
    return { ok: true as const, movedTo: moved?.to ?? null };
  });
}

/** A recorded payment that an edit of its item's schedule moved to another occurrence. */
export interface SettlementMove {
  itemName: string;
  from: Date;
  to: Date;
}

/** A recorded payment an edit of its item's schedule let go: the charge no longer pays any occurrence. */
export interface SettlementRelease {
  itemName: string;
  dueDate: Date;
}

export interface RecurringEditResult {
  /** Rows written: 0 when the item moved on since the form was read, or is gone. */
  written: number;
  settlements: { rekeyed: SettlementMove[]; released: SettlementRelease[] };
}

/**
 * The Recurring form's edit, in one place. Writes every field the form
 * carries, guarded by the `updatedAt` it was rendered with (no rows match once
 * the item has moved on; the caller tells the user to reopen). Returns how
 * many rows were written - see updateRecurringItemDetailed for what else it
 * did.
 */
export async function updateRecurringItem(
  id: string,
  updatedAt: Date | null,
  values: Prisma.RecurringItemUncheckedUpdateManyInput & { nextDate: Date; frequency: RecurringFrequency },
  today: Date = todayInAppZone(),
): Promise<number> {
  return (await updateRecurringItemDetailed(id, updatedAt, values, today)).written;
}

/**
 * The Recurring form's edit, and what it did to the payments recorded for
 * the item (shown in the save's toast).
 *
 * When the edit is what makes the item postable again - it was paused, on
 * an archived or missing account, missing a goal or on an achieved one, and
 * now none of that holds - and the due date is still the one stored (the user
 * did not pick another), a nextDate behind `today` moves to the first
 * occurrence on or after it, as every other such transition does. A date the
 * user typed by hand is theirs: it is saved as typed, in the past or not.
 * `values.nextDate` is compared with the stored one, so an edit that leaves
 * the date alone is recognised without the form having to say so.
 *
 * An edit of the schedule (next date, frequency, anchors) also moves the
 * item's recorded payments (RecurringSettlement) the new schedule would
 * otherwise charge again, so none is left on a key the schedule no longer
 * has while the occurrence that replaced it posts the same money
 * (reconcileSettlements). The write, and that, happen under the item's row
 * lock, the one posting's claim takes.
 */
export async function updateRecurringItemDetailed(
  id: string,
  updatedAt: Date | null,
  values: Prisma.RecurringItemUncheckedUpdateManyInput & { nextDate: Date; frequency: RecurringFrequency },
  today: Date = todayInAppZone(),
  rates?: RateTable,
): Promise<RecurringEditResult> {
  const none: RecurringEditResult = { written: 0, settlements: { rekeyed: [], released: [] } };
  const goalsToRebuild = new Set<string>();
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RecurringItem" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.recurringItem.findUnique({
        where: { id },
        include: { account: { select: { status: true } }, goal: { select: { achievedAt: true } } },
      });
      if (!before) return none;

      let nextDate = values.nextDate;
      if (isBlocked(before) && before.nextDate.getTime() === values.nextDate.getTime() && values.nextDate.getTime() < today.getTime()) {
        const [account, goal] = await Promise.all([
          typeof values.accountId === "string"
            ? tx.account.findUnique({ where: { id: values.accountId }, select: { status: true } })
            : null,
          typeof values.goalId === "string"
            ? tx.goal.findUnique({ where: { id: values.goalId }, select: { achievedAt: true } })
            : null,
        ]);
        const after = {
          kind: (values.kind as RecurringKind | undefined) ?? before.kind,
          accountId: typeof values.accountId === "string" ? values.accountId : null,
          goalId: typeof values.goalId === "string" ? values.goalId : null,
          account,
          goal,
        };
        if (values.active !== false && skipReasonFor(after) === null) {
          nextDate = firstOccurrenceOnOrAfter(
            {
              nextDate: values.nextDate,
              frequency: values.frequency,
              anchorDay: typeof values.anchorDay === "number" ? values.anchorDay : before.anchorDay,
              secondAnchorDay: typeof values.secondAnchorDay === "number" ? values.secondAnchorDay : null,
            },
            today,
          );
        }
      }

      const written = await tx.recurringItem.updateMany({
        where: {
          id,
          ...(updatedAt ? { updatedAt } : {}),
          // Moving the date is only right if nothing has moved it since it was read.
          ...(nextDate.getTime() !== values.nextDate.getTime() ? { nextDate: before.nextDate } : {}),
        },
        data: { ...values, nextDate },
      });
      if (written.count === 0) return none;

      const after = await tx.recurringItem.findUniqueOrThrow({ where: { id } });
      const scheduleChanged =
        after.nextDate.getTime() !== before.nextDate.getTime() ||
        after.frequency !== before.frequency ||
        after.anchorDay !== before.anchorDay ||
        after.secondAnchorDay !== before.secondAnchorDay;
      const settlements = scheduleChanged
        ? await reconcileSettlements(tx, after, before.nextDate, rates, goalsToRebuild)
        : { rekeyed: [], released: [] };
      return { written: written.count, settlements };
    },
    { timeout: 20000 },
  );
  for (const goalId of goalsToRebuild) await recomputeGoalSaved(goalId);
  return result;
}

/** How far past a recorded payment's due date the new schedule is walked for the occurrence that replaces it. */
const RECONCILE_REACH_DAYS = 62;

/**
 * Moves each recorded payment of `item` whose occurrence the item's new
 * schedule no longer has to the occurrence that replaces it, or lets it go.
 *
 *   - A pairing posting has not claimed yet (the user's "It's that payment",
 *     settlementClaimed false) is always looked at. One whose due date is on
 *     the new schedule stays; any other moves to the new occurrence nearest
 *     its old due date that is free (no RECURRING row, no other recorded
 *     payment) and that the charge still pays, or is released: the charge is
 *     an ordinary one again, and the occurrence that replaced it posts on its
 *     due date.
 *   - A pairing posting already claimed is history, and stays, unless the
 *     schedule moved back (`formerNext`, the nextDate before the edit) so that
 *     it walks again the span posting had claimed. Then one not on the new
 *     schedule moves to a free new occurrence in that span that the charge
 *     still pays - the occurrence that replaced it - and otherwise stays: it
 *     paid what it paid.
 *
 * "Pays" is the settlement rules: planSettlements, the one matcher posting
 * uses, against the new occurrence; for the user's own answer also the
 * question that produced it (planPostedDuplicates' upcoming occurrence, which
 * takes an amount in the account's currency within
 * CROSS_CURRENCY_MATCH_TOLERANCE). Moving or releasing a contribution's
 * pairing moves or removes its GoalContribution with it, so the goal counts
 * the money exactly when the ledger does. A moved pairing keeps whether
 * posting has claimed it, so a claimed one is rolled past, never counted
 * again.
 */
async function reconcileSettlements(
  tx: Prisma.TransactionClient,
  item: Prisma.RecurringItemGetPayload<object>,
  formerNext: Date,
  rates: RateTable | undefined,
  goalsToRebuild: Set<string>,
): Promise<RecurringEditResult["settlements"]> {
  const movedBack = item.nextDate.getTime() < formerNext.getTime();
  const moves: RecurringEditResult["settlements"] = { rekeyed: [], released: [] };
  const recorded = (
    await tx.recurringSettlement.findMany({
      where: { recurringItemId: item.id },
      select: {
        id: true,
        occurrenceKey: true,
        dueDate: true,
        claimedByPostingAt: true,
        transaction: {
          select: { id: true, date: true, amount: true, currency: true, originalAmount: true, originalCurrency: true, rate: true, accountId: true, categoryId: true, note: true, source: true, externalId: true },
        },
      },
      orderBy: { dueDate: "asc" },
    })
  ).filter(
    (row) =>
      !settlementClaimed(row) ||
      (movedBack &&
        row.dueDate.getTime() < formerNext.getTime() &&
        row.dueDate.getTime() >= addDays(item.nextDate, -RECONCILE_REACH_DAYS).getTime()),
  );
  if (recorded.length === 0) return moves;

  const walkTo = addDays(recorded[recorded.length - 1].dueDate, RECONCILE_REACH_DAYS);
  const schedule: Date[] = [];
  for (let cursor = item.nextDate; cursor.getTime() <= walkTo.getTime() && schedule.length < 400; ) {
    schedule.push(cursor);
    cursor = advanceDate(cursor, item.frequency, item.anchorDay, item.secondAnchorDay);
  }
  const nextAfter = (due: Date) => advanceDate(due, item.frequency, item.anchorDay, item.secondAnchorDay);
  const onSchedule = new Set(schedule.map((due) => toISODate(due)));
  const scheduleKeys = schedule.map((due) => recurringExternalId(item.id, due));
  const taken = new Set([
    ...(
      await tx.transaction.findMany({ where: { source: "RECURRING", externalId: { in: scheduleKeys } }, select: { externalId: true } })
    ).map((row) => row.externalId as string),
    ...(await tx.recurringSettlement.findMany({ where: { occurrenceKey: { in: scheduleKeys } }, select: { occurrenceKey: true } })).map(
      (row) => row.occurrenceKey,
    ),
  ]);
  const guard = (
    await tx.recurringItem.findMany({
      where: { active: true },
      select: { id: true, name: true, amount: true, currency: true, categoryId: true, kind: true, goalId: true },
    })
  ).map((row) => ({ ...row, amount: num(row.amount), goalId: row.kind === "CONTRIBUTION" ? row.goalId : null }));
  const self = {
    id: item.id,
    name: item.name,
    amount: num(item.amount),
    currency: item.currency,
    categoryId: item.categoryId,
    kind: item.kind,
    goalId: item.kind === "CONTRIBUTION" ? item.goalId : null,
  };
  const items = guard.some((row) => row.id === item.id) ? guard : [...guard, self];
  let table = rates;

  for (const row of recorded) {
    if (onSchedule.has(toISODate(row.dueDate))) continue;
    const claimed = settlementClaimed(row);
    const charge = row.transaction;
    const contributionId = manualContributionIdFromTransaction(charge);
    const contributionGoalId = contributionId
      ? ((await tx.goalContribution.findUnique({ where: { id: contributionId }, select: { goalId: true } }))?.goalId ?? null)
      : null;
    const amount = num(charge.amount);
    const originalAmount = charge.originalAmount === null ? null : num(charge.originalAmount);
    const pays = async (due: Date): Promise<boolean> => {
      const occurrence = { itemId: item.id, due, nextDue: nextAfter(due) };
      const settled = planSettlements({
        items,
        occurrences: [occurrence],
        charges: [{ id: charge.id, date: charge.date, amount, currency: charge.currency, originalAmount, originalCurrency: charge.originalCurrency, categoryId: charge.categoryId, note: charge.note, contributionGoalId }],
      });
      if (settled.size > 0) return true;
      // The user's own answer: the question that produced it.
      if (claimed || item.kind !== "SUBSCRIPTION" || !item.accountId || charge.accountId !== item.accountId) return false;
      table ??= await getRateTable();
      return planPostedDuplicates({
        incoming: [{ key: charge.id, accountId: charge.accountId, type: "EXPENSE", date: charge.date, amount, currency: charge.currency, originalAmount, originalCurrency: charge.originalCurrency, rate: charge.rate === null ? null : num(charge.rate), categoryId: charge.categoryId, note: charge.note }],
        posted: [{ id: "next", kind: "upcoming", accountId: item.accountId, type: "EXPENSE", date: due, amount: self.amount, currency: item.currency, window: settlementWindow(due, nextAfter(due)), item: self }],
        items,
        rates: table,
      }).has(charge.id);
    };
    const candidates = schedule
      .filter((due) => !taken.has(recurringExternalId(item.id, due)) && (!claimed || due.getTime() < formerNext.getTime()))
      .sort(
        (a, b) =>
          Math.abs(a.getTime() - row.dueDate.getTime()) - Math.abs(b.getTime() - row.dueDate.getTime()) || a.getTime() - b.getTime(),
      );
    let target: Date | null = null;
    for (const due of candidates) {
      if (await pays(due)) {
        target = due;
        break;
      }
    }

    if (target) {
      const key = recurringExternalId(item.id, target);
      taken.add(key);
      await tx.recurringSettlement.update({
        where: { id: row.id },
        data: { occurrenceKey: key, dueDate: target },
      });
      const moved = await tx.goalContribution.updateMany({ where: { recurringExternalId: row.occurrenceKey }, data: { recurringExternalId: key } });
      if (moved.count > 0 && item.goalId) goalsToRebuild.add(item.goalId);
      moves.rekeyed.push({ itemName: item.name, from: row.dueDate, to: target });
    } else if (!claimed) {
      await tx.recurringSettlement.delete({ where: { id: row.id } });
      const removed = await tx.goalContribution.findMany({ where: { recurringExternalId: row.occurrenceKey }, select: { goalId: true } });
      if (removed.length > 0) {
        await tx.goalContribution.deleteMany({ where: { recurringExternalId: row.occurrenceKey } });
        for (const contribution of removed) goalsToRebuild.add(contribution.goalId);
      }
      moves.released.push({ itemName: item.name, dueDate: row.dueDate });
    }
  }
  return moves;
}

/**
 * Whether saving an edit of item `id` would store a SEMI_MONTHLY pair of due
 * days that posting collapses into one charge in some month (see
 * semiMonthlyAnchorsCollide). The form's schema judges the pair when the due
 * date is picked, because the anchor is then the date's day; an edit that
 * leaves the date alone carries no anchor, so the stored one stands in for it
 * here - which is what catches a change to only the second day, or to
 * SEMI_MONTHLY from another frequency. Saving the pair the item already has is
 * never refused: an item already saved is not rewritten by being saved again.
 */
export async function semiMonthlyEditCollides(
  id: string,
  values: { frequency: RecurringFrequency; anchorDay?: number | null; secondAnchorDay?: number | null },
): Promise<boolean> {
  const { secondAnchorDay } = values;
  if (values.frequency !== "SEMI_MONTHLY" || typeof secondAnchorDay !== "number") return false;
  const before = await prisma.recurringItem.findUnique({
    where: { id },
    select: { frequency: true, anchorDay: true, secondAnchorDay: true, nextDate: true },
  });
  if (!before) return false;
  const anchorDay =
    typeof values.anchorDay === "number" ? values.anchorDay : before.anchorDay ?? before.nextDate.getUTCDate();
  const unchanged =
    before.frequency === "SEMI_MONTHLY" &&
    before.secondAnchorDay === secondAnchorDay &&
    (before.anchorDay ?? before.nextDate.getUTCDate()) === anchorDay;
  return !unchanged && semiMonthlyAnchorsCollide(anchorDay, secondAnchorDay);
}

/**
 * The one write for "which account funds this recurring item" - the same
 * RecurringItem.accountId the Recurring page's form saves, so the payday
 * check-in's per-account reassignment moves the very row that page lists
 * rather than keeping a plan-local override. Returns false when the item is
 * gone (deleted in another tab while the wizard was open).
 *
 * An item that had no usable account (none, or an archived one) and is
 * postable with this one skips what it missed, like every transition that
 * makes an item postable again; moving an item between two working accounts
 * is not one, and leaves an overdue item's backlog alone.
 */
export async function setRecurringItemAccount(
  id: string,
  accountId: string,
  today: Date = todayInAppZone(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.recurringItem.findUnique({
      where: { id },
      include: { account: { select: { status: true } }, goal: { select: { achievedAt: true } } },
    });
    if (!before) return false;
    const updated = await tx.recurringItem.updateMany({ where: { id }, data: { accountId } });
    if (updated.count === 0) return false;
    if (isBlocked(before)) await skipMissedOccurrences({ id }, today, tx);
    return true;
  });
}

export type PaidOffResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  /** Only an installment plan with payments still owed can be paid off early. */
  | { ok: false; reason: "not_a_plan" };

/**
 * The remainder of an installment plan was settled outside the app in one
 * lump sum: the countdown goes to 0 and the item switches off in the same
 * write, leaving it in exactly the state posting its last occurrence would
 * have - "finished", not "paused" - with its posting history intact.
 */
export async function markRecurringItemPaidOff(itemId: string): Promise<PaidOffResult> {
  const item = await prisma.recurringItem.findUnique({
    where: { id: itemId },
    select: { remainingOccurrences: true },
  });
  if (!item) return { ok: false, reason: "not_found" };
  if (item.remainingOccurrences === null || item.remainingOccurrences <= 0) {
    return { ok: false, reason: "not_a_plan" };
  }
  const claimed = await prisma.recurringItem.updateMany({
    where: { id: itemId, remainingOccurrences: item.remainingOccurrences },
    data: { remainingOccurrences: 0, active: false },
  });
  return claimed.count === 0 ? { ok: false, reason: "not_a_plan" } : { ok: true };
}
