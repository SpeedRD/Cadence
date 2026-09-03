/**
 * Automatic posting of recurring items.
 *
 * On each run, every active RecurringItem whose nextDate has arrived is turned
 * into real ledger rows - one per elapsed occurrence - and rolled forward:
 *
 *   SUBSCRIPTION  -> an EXPENSE Transaction (source RECURRING) charged to the
 *                    item's account on the occurrence's due date.
 *   CONTRIBUTION  -> the same outgoing Transaction from the item's account, plus
 *                    a GoalContribution on the item's goal (tagged with
 *                    recurringItemId so monthly savings/investing does not
 *                    count the pair twice), after which the goal's cached
 *                    savedAmount is rebuilt via recomputeGoalSaved (the same
 *                    helper the manual "Log contribution" flow uses).
 *
 * An item missing the link its kind needs (account for both kinds, goal for a
 * contribution) or pointing at an archived account is skipped outright - not
 * posted and, crucially, not advanced - and reported in the returned summary so
 * the cron log and the UI can show it. It catches up from its original due date
 * once the user fixes it.
 *
 * Exactly one code path posts: the daily cron route (/api/cron/recurring) and
 * the per-request catch-up in getAppContext() both call postDueRecurringItems.
 * Two overlapping runs can never double-post because each occurrence is
 * claimed with a compare-and-swap on nextDate inside the same database
 * transaction that writes its rows, and the Transaction's (source, externalId)
 * unique key pins each (item, due date) pair as a second guard.
 */
import { startOfDay, toISODate } from "@/lib/date";
import { recomputeGoalSaved } from "@/lib/goals";
import { prisma } from "@/lib/prisma";
import { advanceDate } from "@/lib/recurring";

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
  /** Items that hit MAX_OCCURRENCES_PER_ITEM and still have occurrences due. */
  itemsCapped: number;
  /** Items whose posting threw; the run carries on with the rest. */
  itemsFailed: number;
  failed: FailedRecurringItem[];
}

async function loadDueItems(today: Date) {
  return prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lte: today } },
    include: { account: { select: { status: true } } },
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

/**
 * Posts one occurrence atomically. Returns null when another run already
 * claimed it (its nextDate no longer equals `due`), in which case nothing was
 * written by this call.
 */
async function postOccurrence(
  item: DueItem,
  accountId: string,
  due: Date,
): Promise<{ goalContribution: boolean } | null> {
  const next = advanceDate(due, item.frequency);
  const goalId = item.kind === "CONTRIBUTION" ? item.goalId : null;

  const outcome = await prisma.$transaction(async (tx) => {
    const claimed = await tx.recurringItem.updateMany({
      where: { id: item.id, active: true, nextDate: due },
      data: { nextDate: next },
    });
    if (claimed.count === 0) return null;

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
        externalId: recurringExternalId(item.id, due),
      },
    });

    if (!goalId) return { goalContribution: false };
    // recurringItemId marks this row as the counterpart of the Transaction
    // above, so the monthly savings/investing calculation counts the
    // occurrence once (see src/lib/data/monthly.ts). Manual contributions
    // never set it.
    await tx.goalContribution.create({
      data: {
        goalId,
        amount: item.amount,
        currency: item.currency,
        date: due,
        note: item.name,
        recurringItemId: item.id,
      },
    });
    return { goalContribution: true };
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
    itemsCapped: 0,
    itemsFailed: 0,
    failed: [],
  };

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
    let occurrence = item.nextDate;
    try {
      for (
        let i = 0;
        i < MAX_OCCURRENCES_PER_ITEM && occurrence.getTime() <= today.getTime();
        i += 1
      ) {
        const outcome = await postOccurrence(item, item.accountId, occurrence);
        // Someone else (an overlapping run) owns this item now; leave the
        // rest of its backlog to them rather than racing for each occurrence.
        if (!outcome) break;
        posted += 1;
        summary.transactionsCreated += 1;
        if (outcome.goalContribution) summary.goalContributionsCreated += 1;
        occurrence = advanceDate(occurrence, item.frequency);
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
      posted === MAX_OCCURRENCES_PER_ITEM &&
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
