/**
 * Automatic posting of recurring items.
 *
 * On each run, every active RecurringItem whose nextDate has arrived is turned
 * into real ledger rows - one per elapsed occurrence - and rolled forward:
 *
 *   SUBSCRIPTION  -> an EXPENSE Transaction (source RECURRING) charged to the
 *                    item's account on the occurrence's due date.
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
 * the cron log and the UI can show it. It catches up from its original due date
 * once the user fixes it.
 *
 * Two occurrences are claimed (rolled forward) without writing a ledger row:
 *
 *   already logged  -> the charge is already in the ledger from another source
 *                      (an approved email receipt, a CSV import, a manual
 *                      entry). Posting it again would duplicate real money, so
 *                      the occurrence is consumed instead. Judged over the pay
 *                      period the occurrence falls in, with the same matcher,
 *                      so this job and the payday check-in's "Already paid this
 *                      period" badge always reach the same verdict. See
 *                      findLoggedCharge.
 *   already posted  -> a RECURRING row for this exact (item, due date) already
 *                      exists, so the unique key would reject a second one.
 *                      Rolling forward anyway is what keeps an item whose
 *                      nextDate was moved back onto a posted day from failing
 *                      the same write on every future run, for ever.
 *
 * Exactly one code path posts: the daily cron route (/api/cron/recurring) and
 * the per-request catch-up in getAppContext() both call postDueRecurringItems.
 * Two overlapping runs can never double-post because each occurrence is
 * claimed with a compare-and-swap on nextDate inside the same database
 * transaction that writes its rows, and the Transaction's (source, externalId)
 * unique key pins each (item, due date) pair as a second guard.
 */
import { IDENTITY_RATES, convert, type RateTable } from "@/lib/currency";
import { startOfDay, toISODate } from "@/lib/date";
import { recomputeGoalSaved } from "@/lib/goals";
import { num, round2 } from "@/lib/money";
import { periodForDate } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";
import { advanceDate } from "@/lib/recurring";

import { matchRecurringToTransactions } from "@/lib/data/monthly";

import type { RecurringKind } from "@/generated/prisma/enums";

/**
 * How many elapsed occurrences a single run posts per item. Bounds the work
 * (and the surprise) when the app has been untouched for a long time; a longer
 * backlog finishes over the following runs.
 */
export const MAX_OCCURRENCES_PER_ITEM = 24;

export type RecurringSkipReason =
  | "missing_account"
  | "missing_goal"
  | "missing_account_and_goal"
  | "account_archived";

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
}

async function loadDueItems(today: Date) {
  return prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lte: today } },
    include: {
      account: { select: { status: true } },
      goal: { select: { currency: true } },
    },
    orderBy: { nextDate: "asc" },
  });
}

type DueItem = Awaited<ReturnType<typeof loadDueItems>>[number];

function skipReasonFor(item: DueItem): RecurringSkipReason | null {
  const missingAccount = !item.accountId;
  const missingGoal = item.kind === "CONTRIBUTION" && !item.goalId;
  if (missingAccount && missingGoal) return "missing_account_and_goal";
  if (missingAccount) return "missing_account";
  if (missingGoal) return "missing_goal";
  if (item.account?.status === "ARCHIVED") return "account_archived";
  return null;
}

/** The dedup key for one (item, due date) pair; see Transaction.externalId. */
export function recurringExternalId(itemId: string, due: Date): string {
  return `${itemId}:${toISODate(due)}`;
}

interface LoggedCharge {
  id: string;
  date: Date;
  amount: unknown;
  currency: string;
  categoryId: string | null;
  note: string | null;
}

/**
 * Every expense on this item's account that could be one of its occurrences
 * already paid through another route, across every pay period the backlog this
 * run might post touches. RECURRING rows are excluded: those are this job's own
 * output, and an occurrence that already has one is handled by the claim itself.
 */
async function loadLoggedCharges(item: DueItem, today: Date): Promise<LoggedCharge[]> {
  if (!item.accountId) return [];
  return prisma.transaction.findMany({
    where: {
      type: "EXPENSE",
      accountId: item.accountId,
      source: { not: "RECURRING" },
      date: {
        gte: periodForDate(item.nextDate).start,
        lte: periodForDate(today).end,
      },
    },
    select: { id: true, date: true, amount: true, currency: true, categoryId: true, note: true },
  });
}

/**
 * The already-logged charge that covers this occurrence, or null.
 *
 * Both the predicate and the candidate set are the payday check-in's: the same
 * matcher (src/lib/data/monthly.ts - same currency, amount to the cent, and
 * either the item's category or its name in the note) over the same window (the
 * pay period the occurrence falls in, exactly what getPaydayCheckinDraft scopes
 * its `alreadyLogged` query to). Sharing the predicate but not the window was
 * enough to disagree: a charge logged nine days before its due date read as
 * "Already paid this period" in the check-in while this job, looking only a few
 * days either side, still posted a duplicate for it.
 *
 * A period-wide window is wider than a weekly cadence, so it can no longer be
 * the window that stops two occurrences of one item claiming the same charge.
 * `consumed` does that instead, and does it exactly: one logged charge answers
 * for one occurrence, whatever the cadence.
 */
function findLoggedCharge(
  item: DueItem,
  due: Date,
  charges: LoggedCharge[],
  consumed: ReadonlySet<string>,
): string | null {
  const period = periodForDate(due);
  const candidates = charges
    .filter(
      (charge) =>
        !consumed.has(charge.id) &&
        charge.date.getTime() >= period.start.getTime() &&
        charge.date.getTime() <= period.end.getTime(),
    )
    .map((charge) => ({
      id: charge.id,
      amount: num(charge.amount as never),
      currency: charge.currency,
      categoryId: charge.categoryId,
      note: charge.note,
    }));
  if (candidates.length === 0) return null;

  const { matchedTransactionIds } = matchRecurringToTransactions(
    [
      {
        id: item.id,
        name: item.name,
        amount: num(item.amount),
        currency: item.currency,
        categoryId: item.categoryId,
        kind: item.kind,
        frequency: item.frequency,
        nextDate: item.nextDate,
      },
    ],
    candidates,
  );
  const [matched] = matchedTransactionIds;
  return matched ?? null;
}

/** What claiming one occurrence did, once the compare-and-swap succeeded. */
type OccurrenceResult = "posted" | "already_logged" | "already_posted";

/**
 * Claims one occurrence atomically and writes its rows unless they would
 * duplicate money that is already recorded. Returns null when another run
 * already claimed it (its nextDate no longer equals `due`), in which case
 * nothing was written by this call.
 */
async function postOccurrence(
  item: DueItem,
  accountId: string,
  due: Date,
  alreadyLogged: boolean,
  rates: RateTable,
): Promise<{ result: OccurrenceResult; goalContribution: boolean } | null> {
  const next = advanceDate(due, item.frequency, item.anchorDay);
  const goalId = item.kind === "CONTRIBUTION" ? item.goalId : null;
  const externalId = recurringExternalId(item.id, due);

  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await tx.recurringItem.updateMany({
      where: { id: item.id, active: true, nextDate: due },
      data: { nextDate: next },
    });
    if (claimed.count === 0) return null;

    // The charge reached the ledger from somewhere else. The occurrence is
    // still consumed - the item moves on - but posting it would double it.
    if (alreadyLogged) {
      return { result: "already_logged" as const, goalContribution: false };
    }

    // This occurrence's rows already exist (its nextDate was moved back onto a
    // day that had been posted). Creating the Transaction would violate
    // (source, externalId) and roll back the claim with it, leaving the item to
    // fail identically on every future run. Keep the roll-forward instead.
    const posted = await tx.transaction.findUnique({
      where: { source_externalId: { source: "RECURRING", externalId } },
      select: { id: true },
    });
    if (posted) {
      return { result: "already_posted" as const, goalContribution: false };
    }

    await tx.transaction.create({
      data: {
        date: due,
        amount: item.amount,
        currency: item.currency,
        type: "EXPENSE",
        accountId,
        categoryId: item.categoryId,
        note: item.name,
        source: "RECURRING",
        externalId,
      },
    });

    if (!goalId) return { result: "posted" as const, goalContribution: false };
    // Contributions are stored in the goal's own currency, exactly as the
    // manual "Log contribution" flow does. Storing the item's currency instead
    // would leave recomputeGoalSaved re-converting this row at whatever rate
    // happens to be current on every later rebuild, so the goal's savedAmount -
    // and with it achievedAt - would drift with the exchange rate rather than
    // with the money. Converting once, here, fixes the row at the rate on the
    // day it was posted.
    const goalCurrency = item.goal?.currency ?? item.currency;
    const contributionAmount = round2(
      convert(num(item.amount), item.currency, goalCurrency, rates),
    );
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
    return { result: "posted" as const, goalContribution: true };
  });

  // The cache rebuild reads through the shared client, so it runs after the
  // rows above are committed and visible - the same order as the manual flow.
  if (outcome?.goalContribution && goalId) {
    await recomputeGoalSaved(goalId);
  }
  return outcome;
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
  };

  // Only a contribution whose currency differs from its goal's needs a rate at
  // all, so a run with nothing to convert never touches the rate service.
  const needsRates = due.some(
    (item) =>
      item.kind === "CONTRIBUTION" &&
      item.goal !== null &&
      item.goal.currency !== item.currency,
  );
  const rates = needsRates ? await getRateTable() : IDENTITY_RATES;

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

    let posted = 0;
    let claimed = 0;
    let occurrence = item.nextDate;
    try {
      const charges = await loadLoggedCharges(item, today);
      // One logged charge covers one occurrence: once it has answered for an
      // occurrence it leaves the candidate pool, so a single manual entry can
      // never suppress a whole period of a weekly item.
      const consumed = new Set<string>();
      for (
        let i = 0;
        i < MAX_OCCURRENCES_PER_ITEM && occurrence.getTime() <= today.getTime();
        i += 1
      ) {
        const loggedChargeId = findLoggedCharge(item, occurrence, charges, consumed);
        const outcome = await postOccurrence(
          item,
          item.accountId,
          occurrence,
          loggedChargeId !== null,
          rates,
        );
        // Someone else (an overlapping run) owns this item now; leave the
        // rest of its backlog to them rather than racing for each occurrence.
        if (!outcome) break;
        if (loggedChargeId !== null) consumed.add(loggedChargeId);
        claimed += 1;
        if (outcome.result === "posted") {
          posted += 1;
          summary.transactionsCreated += 1;
          if (outcome.goalContribution) summary.goalContributionsCreated += 1;
        } else if (outcome.result === "already_logged") {
          summary.occurrencesAlreadyLogged += 1;
        } else {
          summary.occurrencesAlreadyPosted += 1;
        }
        occurrence = advanceDate(occurrence, item.frequency, item.anchorDay);
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
    if (
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
  if (summary.itemsCapped > 0) {
    parts.push(`${plural(summary.itemsCapped, "item")} still catching up (capped at ${MAX_OCCURRENCES_PER_ITEM} per run)`);
  }
  if (summary.itemsFailed > 0) {
    const details = summary.failed.map((item) => `${item.name}: ${item.error}`).join(", ");
    parts.push(`${plural(summary.itemsFailed, "item")} failed: ${details}`);
  }
  return `[recurring] ${summary.today}: ${parts.join("; ")}`;
}
