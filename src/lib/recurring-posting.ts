/**
 * Automatic posting of recurring items.
 *
 * On each run, every active RecurringItem whose nextDate has arrived is turned
 * into real ledger rows - one per elapsed occurrence - and rolled forward:
 *
 *   SUBSCRIPTION  -> an EXPENSE Transaction (source RECURRING) charged to the
 *                    item's account on the occurrence's due date, in the
 *                    account's currency: an item in another currency is
 *                    converted once, at the day's rate, which is kept with
 *                    the row (src/lib/account-money.ts).
 *   CONTRIBUTION  -> the same outgoing Transaction from the item's account, plus
 *                    a GoalContribution on the item's goal, converted once into
 *                    the goal's own currency and tagged with the same
 *                    externalId the Transaction carries so monthly
 *                    savings/investing does not count the pair twice. The
 *                    goal's cached savedAmount is then rebuilt via
 *                    recomputeGoalSaved (the helper the manual "Log
 *                    contribution" flow uses).
 *
 * An item missing the link its kind needs (account for both kinds, goal for a
 * contribution) or pointing at an archived account is skipped outright - not
 * posted and, crucially, not advanced - and reported in the returned summary so
 * the cron log and the UI can show it. The occurrences it missed while it sat
 * there were never charged, so the app moves its nextDate to the first
 * occurrence on or after today when the user makes it postable again (an
 * account restored or assigned, a goal open again, the item resumed - see
 * skipMissedOccurrences in src/lib/data/recurring.ts); an item that is merely
 * overdue because a run failed keeps its backlog and posts all of it.
 *
 * Two occurrences are claimed (rolled forward) without writing a RECURRING row:
 *
 *   already logged  -> a charge the user entered (an approved email receipt, a
 *                      CSV import, a manual entry) already paid it. Posting it
 *                      again would duplicate real money, so the occurrence is
 *                      settled by that charge instead, and the pairing is
 *                      recorded (RecurringSettlement) in the claim's own
 *                      transaction so the charge can never settle another
 *                      occurrence, on this run or any later one - or, when
 *                      the user already paired the two before the
 *                      occurrence fell due ("It's that payment"), the row
 *                      they recorded is kept. Which charge
 *                      settles which occurrence is planSettlements'
 *                      (src/lib/recurring-settlement.ts), over every due item
 *                      at once - the matcher the payday check-in's "Already
 *                      paid this period" reads too, so the two agree. For a
 *                      CONTRIBUTION the charge becomes the contribution's
 *                      ledger half: posting writes the GoalContribution with
 *                      the occurrence key, dated on the charge, so the goal
 *                      counts the money once and the ledger shows it once. A
 *                      hand-logged contribution's own expense already has its
 *                      GoalContribution, so settling with one writes nothing.
 *   already posted  -> a RECURRING row for this exact (item, due date) already
 *                      exists, so the unique key would reject a second one.
 *                      Rolling forward anyway is what keeps an item whose
 *                      nextDate was moved back onto a posted day from failing
 *                      the same write on every future run, for ever.
 *
 * A finite item (RecurringItem.remainingOccurrences set - an installment plan
 * from the Afford calculator) counts down by one per occurrence it posts or
 * settles, and the claim that reaches zero also sets active to false in the
 * same statement. An already-posted occurrence was counted when it was first
 * posted, so rolling past it again spends nothing. An item with a null
 * countdown is never touched by any of that: its claim is the plain nextDate
 * roll-forward it always was.
 *
 * A contribution stops at its goal: before each GoalContribution it would
 * write, the claim locks the goal row and re-reads the goal's saved total, and
 * a goal already reached leaves that occurrence (and the rest of the backlog)
 * unclaimed, exactly as the goal_achieved skip below does. The last
 * contribution is not trimmed to what the goal still needed - a single one
 * never is, posted or logged by hand.
 *
 * Exactly one code path posts: the daily cron route (/api/cron/recurring) and
 * the per-request catch-up in getAppContext() both call postDueRecurringItems.
 * Two overlapping runs can never double-post because each occurrence is
 * claimed with a compare-and-swap on nextDate inside the same database
 * transaction that writes its rows, and the Transaction's (source, externalId)
 * unique key pins each (item, due date) pair as a second guard.
 */
import { exactAmountIn, inAccountCurrency } from "@/lib/account-money";
import { IDENTITY_RATES, convert, type RateTable } from "@/lib/currency";
import { startOfDay, toISODate } from "@/lib/date";
import { contributionsOnOrBefore, markGoalsReachedByDate, recomputeGoalSaved, savedFromContributions } from "@/lib/goals";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";
import { MAX_OCCURRENCES_PER_ITEM, advanceDate, skipReasonFor, type RecurringSkipReason } from "@/lib/recurring";
import { recurringExternalId } from "@/lib/recurring-settlement";

import { loadSettlementPlan, type PlannedCharge } from "@/lib/data/recurring-settlement";

import type { RecurringKind } from "@/generated/prisma/enums";

export { MAX_OCCURRENCES_PER_ITEM };

export type { RecurringSkipReason };

export interface SkippedRecurringItem {
  id: string;
  name: string;
  kind: RecurringKind;
  /** The still-unposted due date, "YYYY-MM-DD". */
  nextDate: string;
  reason: RecurringSkipReason;
}

export interface FailedRecurringItem {
  id: string;
  name: string;
  error: string;
}

export interface RecurringPostingSummary {
  /** The reference day the run used, "YYYY-MM-DD". */
  today: string;
  /** Active items whose nextDate was on or before `today`. */
  itemsDue: number;
  /** Items for which at least one occurrence was posted by this run. */
  itemsPosted: number;
  transactionsCreated: number;
  goalContributionsCreated: number;
  itemsSkipped: number;
  skipped: SkippedRecurringItem[];
  /** Occurrences rolled forward without posting because the charge was already in the ledger. */
  occurrencesAlreadyLogged: number;
  /** Occurrences rolled forward whose RECURRING row already existed. */
  occurrencesAlreadyPosted: number;
  /** Items that hit MAX_OCCURRENCES_PER_ITEM and still have occurrences due. */
  itemsCapped: number;
  /** Items whose posting threw; the run carries on with the rest. */
  itemsFailed: number;
  failed: FailedRecurringItem[];
  /** Finite items that claimed their last occurrence this run and deactivated themselves. */
  itemsCompleted: number;
}

async function loadDueItems(today: Date) {
  return prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lte: today } },
    include: {
      account: { select: { status: true, currency: true } },
      goal: { select: { currency: true, achievedAt: true } },
    },
    orderBy: { nextDate: "asc" },
  });
}

type DueItem = Awaited<ReturnType<typeof loadDueItems>>[number];

/** The dedup key for one (item, due date) pair; see Transaction.externalId. */
export { recurringExternalId };

/** What claiming one occurrence did, once the compare-and-swap succeeded. */
type OccurrenceResult = "posted" | "already_logged" | "already_posted";

type OccurrenceOutcome =
  | {
      result: OccurrenceResult;
      goalContribution: boolean;
      completed: boolean;
      /** Whether the claim spent one of a finite item's remaining occurrences. */
      counted: boolean;
    }
  /** The goal was reached before this occurrence; nothing was claimed. */
  | { result: "goal_achieved" }
  /** The planned charge was paired elsewhere first (or removed); nothing was claimed. */
  | { result: "settlement_lost" };

/** Thrown inside a claim to roll it back when its planned charge is no longer free. */
class SettlementLost extends Error {}

/**
 * Claims one occurrence atomically and writes its rows unless they would
 * duplicate money that is already recorded. Returns null when another run
 * already claimed it (its nextDate no longer equals `due`), in which case
 * nothing was written by this call.
 *
 * `settledBy` is the charge the settlement plan says already paid this
 * occurrence, or null to post it. `expectedRemaining` is what a finite item's
 * countdown must still read for this claim (null for an unbounded item): the
 * value it was loaded with less the occurrences this run has counted.
 * `completed` is true when this claim consumed the item's last occurrence -
 * the same statement also switched it off, so the caller must stop walking.
 */
async function postOccurrence(
  item: DueItem,
  accountId: string,
  accountCurrency: string,
  due: Date,
  settledBy: PlannedCharge | null,
  rates: RateTable,
  expectedRemaining: number | null,
  today: Date,
): Promise<OccurrenceOutcome | null> {
  const next = advanceDate(due, item.frequency, item.anchorDay, item.secondAnchorDay);
  const goalId = item.kind === "CONTRIBUTION" ? item.goalId : null;
  const externalId = recurringExternalId(item.id, due);

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // This occurrence's rows already exist (its nextDate was moved back onto
      // a day that had been posted). Creating the Transaction would violate
      // (source, externalId) and roll back the claim with it, leaving the item
      // to fail identically on every future run. Keep the roll-forward
      // instead - without spending an installment, which the first posting
      // already did.
      const alreadyPosted =
        (await tx.transaction.findUnique({
          where: { source_externalId: { source: "RECURRING", externalId } },
          select: { id: true },
        })) !== null;

      // A contribution about to add money to its goal first checks, under the
      // goal's row lock (the one rebuildGoalSaved takes), that the goal still
      // needs it. Read from the contribution rows rather than the cached
      // achievedAt, so a contribution another run wrote a moment ago counts.
      // Only rows dated today or earlier count, as in rebuildGoalSaved: a
      // contribution dated ahead has not reached the goal yet.
      const writesContribution = goalId !== null && !alreadyPosted && !settledBy?.isContributionTwin;
      if (writesContribution) {
        await tx.$queryRaw`SELECT "id" FROM "Goal" WHERE "id" = ${goalId} FOR UPDATE`;
        const goal = await tx.goal.findUnique({ where: { id: goalId }, select: { currency: true, targetAmount: true } });
        if (goal) {
          const rows = await tx.goalContribution.findMany({ where: { goalId }, select: { amount: true, currency: true, date: true } });
          const target = num(goal.targetAmount);
          if (target > 0 && savedFromContributions(contributionsOnOrBefore(rows, today), goal.currency, rates) >= target) {
            return { result: "goal_achieved" as const };
          }
        }
      }

      // A finite item counts this occurrence down whether it is posted or
      // settled - it is one installment accounted for. The expected countdown
      // joins the compare-and-swap so a value changed elsewhere while this run
      // was in flight makes the claim fail (and the run leave the item alone)
      // rather than get overwritten, and the claim that reaches zero
      // deactivates the item in the very same statement. An unbounded item
      // (null) gets the plain roll-forward it always had.
      const counted = expectedRemaining !== null && !alreadyPosted;
      const remainingAfter = counted ? expectedRemaining - 1 : null;
      const completed = remainingAfter !== null && remainingAfter <= 0;
      const claimed = await tx.recurringItem.updateMany({
        where:
          expectedRemaining === null
            ? { id: item.id, active: true, nextDate: due }
            : { id: item.id, active: true, nextDate: due, remainingOccurrences: expectedRemaining },
        data:
          remainingAfter === null
            ? { nextDate: next }
            : { nextDate: next, remainingOccurrences: Math.max(0, remainingAfter), active: !completed },
      });
      if (claimed.count === 0) return null;

      if (alreadyPosted) {
        return { result: "already_posted" as const, goalContribution: false, completed, counted };
      }

      // The charge reached the ledger from somewhere else. The occurrence is
      // still claimed - the item moves on - but posting it would double it.
      // The pairing is written with the claim, and both unique keys guard it:
      // if an overlapping run paired this charge first, nothing is inserted
      // and the claim is rolled back for the next run to plan again.
      // A pairing the user recorded before the occurrence fell due is kept as
      // it is - it must still be there, with the same charge.
      if (settledBy) {
        const charge = await tx.transaction.findUnique({ where: { id: settledBy.id }, select: { id: true } });
        const recorded = !charge
          ? { count: 0 }
          : settledBy.alreadyRecorded
            ? {
                count:
                  (await tx.recurringSettlement.findUnique({ where: { occurrenceKey: externalId }, select: { transactionId: true } }))
                    ?.transactionId === settledBy.id
                    ? 1
                    : 0,
              }
            : await tx.recurringSettlement.createMany({
                data: [{ transactionId: settledBy.id, occurrenceKey: externalId, recurringItemId: item.id, kind: item.kind, dueDate: due }],
                skipDuplicates: true,
              });
        if (recorded.count === 0) throw new SettlementLost();
        if (!writesContribution || !goalId) {
          return { result: "already_logged" as const, goalContribution: false, completed, counted };
        }
        // The charge is this contribution's ledger half: the GoalContribution
        // carries the occurrence key (the settlement's too) and the charge's
        // own date and amount, so the goal counts exactly the money that left
        // - the figure the charge holds in the goal's currency when it holds
        // one (its stored amount, or what it was entered as), converted
        // otherwise.
        const goalCurrency = item.goal?.currency ?? item.currency;
        await tx.goalContribution.create({
          data: {
            goalId,
            amount: exactAmountIn(settledBy, goalCurrency) ?? round2(convert(settledBy.amount, settledBy.currency, goalCurrency, rates)),
            currency: goalCurrency,
            date: settledBy.date,
            note: item.name,
            recurringItemId: item.id,
            recurringExternalId: externalId,
          },
        });
        return { result: "already_logged" as const, goalContribution: true, completed, counted };
      }

      // Stored in the account's currency (K7): an item in another currency is
      // converted once, here, at the day's rate, and the item's own amount
      // and that rate are kept with the row. The row is then the fact of what
      // was charged; the item stays the schedule.
      const charged = inAccountCurrency({ amount: num(item.amount), currency: item.currency }, accountCurrency, rates);
      await tx.transaction.create({
        data: {
          date: due,
          ...charged,
          type: "EXPENSE",
          accountId,
          categoryId: item.categoryId,
          note: item.name,
          source: "RECURRING",
          externalId,
        },
      });

      if (!goalId) return { result: "posted" as const, goalContribution: false, completed, counted };
      // Contributions are stored in the goal's own currency, exactly as the
      // manual "Log contribution" flow does. Storing the item's currency instead
      // would leave recomputeGoalSaved re-converting this row at whatever rate
      // happens to be current on every later rebuild, so the goal's savedAmount -
      // and with it achievedAt - would drift with the exchange rate rather than
      // with the money. Converting once, here, fixes the row at the rate on the
      // day it was posted.
      // A goal in the account's currency counts exactly what the account
      // moved, so the two halves of the occurrence agree to the cent.
      const goalCurrency = item.goal?.currency ?? item.currency;
      const contributionAmount =
        goalCurrency === item.currency
          ? num(item.amount)
          : goalCurrency === charged.currency
            ? charged.amount
            : round2(convert(num(item.amount), item.currency, goalCurrency, rates));
      // recurringExternalId is the same key as the Transaction's externalId
      // above, and unlike recurringItemId it is not nulled when the item is
      // deleted - that is what lets the monthly savings/investing calculation
      // keep counting this occurrence once (see src/lib/data/monthly.ts).
      await tx.goalContribution.create({
        data: {
          goalId,
          amount: contributionAmount,
          currency: goalCurrency,
          date: due,
          note: item.name,
          recurringItemId: item.id,
          recurringExternalId: externalId,
        },
      });
      return { result: "posted" as const, goalContribution: true, completed, counted };
    });

    // The cache rebuild reads through the shared client, so it runs after the
    // rows above are committed and visible - the same order as the manual flow.
    if (outcome && "goalContribution" in outcome && outcome.goalContribution && goalId) {
      await recomputeGoalSaved(goalId);
    }
    return outcome;
  } catch (error) {
    if (error instanceof SettlementLost) return { result: "settlement_lost" };
    throw error;
  }
}

/**
 * Post everything due on or before `reference` (a calendar day; the time part
 * is ignored). Safe to call as often as you like - a caught-up database is a
 * no-op apart from one indexed query.
 */
export async function postDueRecurringItems(
  reference: Date,
): Promise<RecurringPostingSummary> {
  const today = startOfDay(reference);
  // A goal whose last contribution was dated ahead is reached the day it
  // arrives; mark it before the run reads achievedAt below.
  await markGoalsReachedByDate(today);
  const due = await loadDueItems(today);

  const summary: RecurringPostingSummary = {
    today: toISODate(today),
    itemsDue: due.length,
    itemsPosted: 0,
    transactionsCreated: 0,
    goalContributionsCreated: 0,
    itemsSkipped: 0,
    skipped: [],
    occurrencesAlreadyLogged: 0,
    occurrencesAlreadyPosted: 0,
    itemsCapped: 0,
    itemsFailed: 0,
    failed: [],
    itemsCompleted: 0,
  };

  // Items that can post at all this run. With none - a caught-up database, or
  // only items waiting on a missing link - nothing below is loaded, so an
  // item stuck on a missing account costs no more per request than one query.
  const postable = due.filter((item) => skipReasonFor(item) === null && item.accountId !== null);

  // Only an item whose currency differs from its account's or its goal's
  // needs a rate to post, and only a goal holding contributions in another
  // currency (its currency was changed since) needs one to check its saved
  // total, so a run with nothing to convert never touches the rate service.
  const contributionGoals = new Map(
    postable
      .filter((item) => item.kind === "CONTRIBUTION" && item.goalId !== null && item.goal !== null)
      .map((item) => [item.goalId as string, item.goal!.currency]),
  );
  const foreignContributions =
    contributionGoals.size > 0 &&
    (
      await prisma.goalContribution.groupBy({
        by: ["goalId", "currency"],
        where: { goalId: { in: [...contributionGoals.keys()] } },
      })
    ).some((group) => group.currency !== contributionGoals.get(group.goalId));
  const needsRates =
    foreignContributions ||
    postable.some(
      (item) =>
        (item.account !== null && item.account.currency !== item.currency) ||
        (item.kind === "CONTRIBUTION" && item.goal !== null && item.goal.currency !== item.currency),
    );
  const rates = needsRates ? await getRateTable() : IDENTITY_RATES;

  // Which due occurrences a charge the user entered already paid, decided
  // once for the whole run, over every item together (see
  // src/lib/recurring-settlement.ts). An item this run skips or stops early
  // leaves its planned charges unpaired; the next run plans again.
  const plan = postable.length > 0 ? await loadSettlementPlan(today) : { posted: new Set<string>(), settledBy: new Map() };

  for (const item of due) {
    const reason = skipReasonFor(item);
    if (reason || !item.accountId) {
      summary.itemsSkipped += 1;
      summary.skipped.push({
        id: item.id,
        name: item.name,
        kind: item.kind,
        nextDate: toISODate(item.nextDate),
        reason: reason ?? "missing_account",
      });
      continue;
    }

    // Nothing left to post. The app never writes a zero countdown without
    // deactivating in the same statement, but a row edited by hand could
    // arrive here; retiring it is the only outcome that never posts past an
    // installment plan's end.
    if (item.remainingOccurrences !== null && item.remainingOccurrences <= 0) {
      const retired = await prisma.recurringItem.updateMany({
        where: { id: item.id, active: true, remainingOccurrences: { lte: 0 } },
        data: { active: false },
      });
      if (retired.count > 0) summary.itemsCompleted += 1;
      continue;
    }

    let posted = 0;
    let claimed = 0;
    let completed = false;
    let expectedRemaining = item.remainingOccurrences;
    let occurrence = item.nextDate;
    try {
      for (
        let i = 0;
        i < MAX_OCCURRENCES_PER_ITEM && occurrence.getTime() <= today.getTime();
        i += 1
      ) {
        const outcome = await postOccurrence(
          item,
          item.accountId,
          item.account?.currency ?? item.currency,
          occurrence,
          plan.settledBy.get(recurringExternalId(item.id, occurrence)) ?? null,
          rates,
          expectedRemaining,
          today,
        );
        // Someone else (an overlapping run) owns this item now; leave the
        // rest of its backlog to them rather than racing for each occurrence.
        // The same when the charge planned for this occurrence was paired
        // elsewhere first: the next run plans it again from what is left.
        if (!outcome || outcome.result === "settlement_lost") break;
        // The goal was reached part-way through the backlog: the rest waits,
        // unclaimed, exactly as an item skipped for goal_achieved does.
        if (outcome.result === "goal_achieved") {
          summary.itemsSkipped += 1;
          summary.skipped.push({
            id: item.id,
            name: item.name,
            kind: item.kind,
            nextDate: toISODate(occurrence),
            reason: "goal_achieved",
          });
          break;
        }
        claimed += 1;
        if (outcome.counted && expectedRemaining !== null) expectedRemaining -= 1;
        if (outcome.goalContribution) summary.goalContributionsCreated += 1;
        if (outcome.result === "posted") {
          posted += 1;
          summary.transactionsCreated += 1;
        } else if (outcome.result === "already_logged") {
          summary.occurrencesAlreadyLogged += 1;
        } else {
          summary.occurrencesAlreadyPosted += 1;
        }
        // That was the item's last occurrence and it is now inactive; any
        // later due date in the walk belongs to nobody.
        if (outcome.completed) {
          completed = true;
          break;
        }
        occurrence = advanceDate(occurrence, item.frequency, item.anchorDay, item.secondAnchorDay);
      }
    } catch (error) {
      summary.itemsFailed += 1;
      summary.failed.push({
        id: item.id,
        name: item.name,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[recurring] posting "${item.name}" (${item.id}) failed`, error);
    }

    if (posted > 0) summary.itemsPosted += 1;
    if (completed) summary.itemsCompleted += 1;
    if (
      !completed &&
      claimed === MAX_OCCURRENCES_PER_ITEM &&
      occurrence.getTime() <= today.getTime()
    ) {
      summary.itemsCapped += 1;
    }
  }

  return summary;
}

const SKIP_REASON_TEXT: Record<RecurringSkipReason, string> = {
  missing_account: "missing account",
  missing_goal: "missing goal",
  missing_account_and_goal: "missing account and goal",
  account_archived: "account archived",
  goal_achieved: "goal fully funded",
};

/** One log line for the cron output, e.g. "2 items posted ...; 1 item skipped: Netflix (missing account)". */
export function describeRecurringPosting(summary: RecurringPostingSummary): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    `${plural(summary.itemsPosted, "item")} posted (${plural(summary.transactionsCreated, "transaction")}, ${plural(summary.goalContributionsCreated, "goal contribution")})`,
  ];
  if (summary.occurrencesAlreadyLogged > 0) {
    parts.push(
      `${plural(summary.occurrencesAlreadyLogged, "occurrence")} already logged elsewhere, rolled forward without posting`,
    );
  }
  if (summary.occurrencesAlreadyPosted > 0) {
    parts.push(
      `${plural(summary.occurrencesAlreadyPosted, "occurrence")} already posted, rolled forward`,
    );
  }
  if (summary.itemsSkipped > 0) {
    const details = summary.skipped
      .map((item) => `${item.name} (${SKIP_REASON_TEXT[item.reason]})`)
      .join(", ");
    parts.push(`${plural(summary.itemsSkipped, "item")} skipped: ${details}`);
  }
  if (summary.itemsCompleted > 0) {
    parts.push(`${plural(summary.itemsCompleted, "item")} posted its last occurrence and stopped`);
  }
  if (summary.itemsCapped > 0) {
    parts.push(`${plural(summary.itemsCapped, "item")} still catching up (capped at ${MAX_OCCURRENCES_PER_ITEM} per run)`);
  }
  if (summary.itemsFailed > 0) {
    const details = summary.failed.map((item) => `${item.name}: ${item.error}`).join(", ");
    parts.push(`${plural(summary.itemsFailed, "item")} failed: ${details}`);
  }
  return `[recurring] ${summary.today}: ${parts.join("; ")}`;
}
