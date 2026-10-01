import {
  inAccountCurrency,
  moneyRow,
  roundRate,
  toAccountMoney,
  type MoneyRow,
  type StoredMoney,
} from "@/lib/account-money";
import { IDENTITY_RATES, convert, type RateTable } from "@/lib/currency";
import { today as todayInAppZone } from "@/lib/date";
import { num, round2, type DecimalLike } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getRateTable } from "@/lib/rates";
import { skipMissedOccurrences } from "@/lib/data/recurring";
import { manualContributionExternalId } from "@/lib/transactions";

export interface ManualContributionInput {
  goalId: string;
  /** Must already be checked to exist and be active (see checkReferences). */
  accountId: string;
  /** In the goal's own currency, exactly as typed. */
  amount: number;
  date: Date;
  note: string | null;
}

/**
 * Logs a contribution by hand, moving the money for real: one outgoing EXPENSE
 * Transaction from the chosen account (source MANUAL, denominated in the
 * account's currency, converted from the goal's at today's rate when they
 * differ, filed under the Savings/Investment category so period budgets and
 * the monthly pace treat it as saving rather than spending, note = the goal's
 * name so the ledger reads like the auto-posted rows do) and the
 * GoalContribution itself, in the goal's currency exactly as entered and
 * pointing back at the account. Both rows land in one database transaction, so
 * a failure leaves neither. Goal.savedAmount is not rebuilt here - the caller
 * does that after this commits, as before.
 */
export async function logManualContribution(
  input: ManualContributionInput,
  rates?: RateTable,
): Promise<{ contributionId: string; transactionId: string }> {
  const [goal, account, savingsCategory] = await Promise.all([
    prisma.goal.findUniqueOrThrow({
      where: { id: input.goalId },
      select: { id: true, name: true, currency: true },
    }),
    prisma.account.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { id: true, currency: true },
    }),
    prisma.category.findFirst({ where: { isSavingsDefault: true }, select: { id: true } }),
  ]);
  // Fetched before the transaction: getRateTable can call the rate service and
  // upsert ExchangeRate rows, neither of which belongs inside a write.
  const table =
    rates ?? (goal.currency === account.currency ? IDENTITY_RATES : await getRateTable());
  // The twin is stored in the account's currency with the contribution's own
  // figure and the rate kept beside it (K7), like any other row.
  const twin = inAccountCurrency({ amount: input.amount, currency: goal.currency }, account.currency, table);

  return prisma.$transaction(async (tx) => {
    const contribution = await tx.goalContribution.create({
      data: {
        goalId: goal.id,
        accountId: account.id,
        amount: input.amount,
        currency: goal.currency,
        date: input.date,
        note: input.note,
      },
      select: { id: true },
    });
    const transaction = await tx.transaction.create({
      data: {
        date: input.date,
        ...twin,
        type: "EXPENSE",
        accountId: account.id,
        categoryId: savingsCategory?.id ?? null,
        note: goal.name,
        source: "MANUAL",
        externalId: manualContributionExternalId(contribution.id),
      },
      select: { id: true },
    });
    return { contributionId: contribution.id, transactionId: transaction.id };
  });
}

/**
 * Removes a contribution and the Transaction that carries its money, together.
 * A manual row is paired through its accountId and the goal-contribution
 * externalId; a row recurring posting wrote is paired through
 * recurringExternalId, the same key its RECURRING Transaction carries - or,
 * when posting settled that occurrence with a charge the user entered, the
 * key that charge's RecurringSettlement carries. A row with neither (logged
 * before contributions had an account) is deleted on its own. deleteMany
 * rather than delete for the twin: the user may already have removed it from
 * the ledger, and that must not block removing the contribution.
 */
export async function removeContribution(contribution: {
  id: string;
  accountId: string | null;
  recurringExternalId?: string | null;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.goalContribution.delete({ where: { id: contribution.id } });
    if (contribution.accountId !== null) {
      await tx.transaction.deleteMany({
        where: { source: "MANUAL", externalId: manualContributionExternalId(contribution.id) },
      });
    }
    if (contribution.recurringExternalId) {
      await tx.transaction.deleteMany({
        where: {
          OR: [
            { source: "RECURRING", externalId: contribution.recurringExternalId },
            { recurringSettlement: { is: { occurrenceKey: contribution.recurringExternalId } } },
          ],
        },
      });
    }
  });
}

/** The ledger half of a contribution recurring posting wrote: its RECURRING row, or the charge that settled its occurrence. */
function recurringContributionTwin(key: string) {
  return prisma.transaction.findFirst({
    where: {
      OR: [
        { source: "RECURRING", externalId: key },
        { recurringSettlement: { is: { occurrenceKey: key } } },
      ],
    },
    select: { id: true, amount: true, currency: true, originalAmount: true, originalCurrency: true, rate: true },
  });
}

/**
 * A contribution's ledger twin as K7 reads it: stored in its account's
 * currency, converted from the contribution's own figure. A twin written
 * before K7 kept no original, but it was converted from the contribution
 * all the same, so the contribution's stored amount and the rate that pair
 * implies stand in for it - an amount correction then scales the twin in
 * proportion rather than re-converting it at today's rate (B25).
 */
function twinAsStored(
  twin: { amount: DecimalLike; currency: string; originalAmount: DecimalLike; originalCurrency: string | null; rate: DecimalLike },
  contribution: { amount: DecimalLike; currency: string },
): MoneyRow {
  const row = moneyRow(twin);
  if (row.originalCurrency !== null || row.currency === contribution.currency) return row;
  const contributed = num(contribution.amount);
  if (contributed <= 0) return row;
  return { ...row, originalAmount: contributed, originalCurrency: contribution.currency, rate: roundRate(row.amount / contributed) };
}

export type RecurringContributionUpdate =
  | { ok: true; goalId: string; transactionAmount: number | null }
  | { ok: false; reason: "not_found" }
  /** Only rows recurring posting wrote are edited this way; manual ones are re-logged. */
  | { ok: false; reason: "not_recurring" };

/**
 * Corrects one already-posted occurrence of a recurring contribution: the
 * amount the goal counts (in the goal's currency, as stored) and the expense
 * that moved the money - the RECURRING row, or the charge that settled the
 * occurrence - in one write. The expense stays in its account's currency: a
 * new amount is carried across at the rate the expense was stored at (K7), so
 * the correction scales it rather than re-converting it at today's rate.
 * The RecurringItem itself is untouched: this is about what was charged on
 * that date, not what the item charges next. The caller rebuilds the goal's
 * cached total afterwards, as every contribution write does.
 */
export async function updateRecurringContributionAmount(
  contributionId: string,
  amount: number,
  rates?: RateTable,
): Promise<RecurringContributionUpdate> {
  const contribution = await prisma.goalContribution.findUnique({
    where: { id: contributionId },
    select: { id: true, goalId: true, amount: true, currency: true, recurringExternalId: true },
  });
  if (!contribution) return { ok: false, reason: "not_found" };
  if (!contribution.recurringExternalId) return { ok: false, reason: "not_recurring" };

  const twin = await recurringContributionTwin(contribution.recurringExternalId);
  const table =
    rates ??
    (!twin || twin.currency === contribution.currency ? IDENTITY_RATES : await getRateTable());
  const stored = twin
    ? toAccountMoney({ amount, currency: contribution.currency }, twin.currency, table, {
        row: twinAsStored(twin, contribution),
        accountCurrency: twin.currency,
      })
    : null;
  const transactionAmount = stored ? stored.amount : null;

  await prisma.$transaction(async (tx) => {
    await tx.goalContribution.update({
      where: { id: contribution.id },
      data: { amount },
    });
    if (twin && stored) {
      await tx.transaction.update({
        where: { id: twin.id },
        data: stored,
      });
    }
  });
  return { ok: true, goalId: contribution.goalId, transactionAmount };
}

export type ManualContributionUpdate =
  | { ok: true; goalId: string; transactionAmount: number | null }
  | { ok: false; reason: "not_found" }
  /** Only rows logged by hand are edited this way; a recurring one is corrected via updateRecurringContributionAmount. */
  | { ok: false; reason: "not_manual" };

/**
 * Corrects a hand-logged contribution in place - amount, date, and which
 * account the money left - together with the Transaction logManualContribution
 * paired it with, in one write. The manual counterpart to
 * updateRecurringContributionAmount above.
 *
 * Changing the account converts the amount into that account's own
 * currency at today's rate, the same conversion logManualContribution applies
 * at creation. Leaving the account alone keeps the twin as stored (K7): an
 * edit of the date alone never touches its amount (B25), and a new amount is
 * carried across at the rate the twin was stored at. A contribution logged before
 * contributions had an account has no twin to find - as with the recurring
 * path, the contribution itself is still corrected, and the account it now
 * points at takes effect the next time a twin exists to move.
 */
export async function updateManualContribution(
  contributionId: string,
  input: { amount: number; date: Date; accountId: string },
  rates?: RateTable,
): Promise<ManualContributionUpdate> {
  const contribution = await prisma.goalContribution.findUnique({
    where: { id: contributionId },
    select: { id: true, goalId: true, amount: true, currency: true, recurringExternalId: true },
  });
  if (!contribution) return { ok: false, reason: "not_found" };
  if (contribution.recurringExternalId) return { ok: false, reason: "not_manual" };

  const twin = await prisma.transaction.findFirst({
    where: { source: "MANUAL", externalId: manualContributionExternalId(contribution.id) },
    select: { id: true, amount: true, currency: true, originalAmount: true, originalCurrency: true, rate: true, accountId: true },
  });

  let account: { id: string; currency: string } | null = null;
  let stored: StoredMoney | null = null;
  if (twin) {
    const sameAccount = twin.accountId === input.accountId;
    account = sameAccount
      ? { id: twin.accountId, currency: twin.currency }
      : await prisma.account.findUniqueOrThrow({
          where: { id: input.accountId },
          select: { id: true, currency: true },
        });
    const kept = sameAccount ? { row: twinAsStored(twin, contribution), accountCurrency: twin.currency } : null;
    const keepsConversion =
      kept !== null &&
      kept.row.originalCurrency === contribution.currency &&
      kept.row.rate !== null &&
      kept.row.rate !== undefined;
    const table =
      rates ??
      (account.currency === contribution.currency || keepsConversion ? IDENTITY_RATES : await getRateTable());
    stored = toAccountMoney({ amount: input.amount, currency: contribution.currency }, account.currency, table, kept);
  }
  const transactionAmount = stored ? stored.amount : null;

  await prisma.$transaction(async (tx) => {
    await tx.goalContribution.update({
      where: { id: contribution.id },
      data: twin
        ? { amount: input.amount, date: input.date, accountId: account!.id }
        : { amount: input.amount, date: input.date },
    });
    if (twin && account && stored) {
      await tx.transaction.update({
        where: { id: twin.id },
        data: {
          ...stored,
          date: input.date,
          accountId: account.id,
        },
      });
    }
  });

  return { ok: true, goalId: contribution.goalId, transactionAmount };
}

/**
 * Deletes a goal. Its contributions cascade at the database, but the MANUAL
 * expenses those contributions wrote have no foreign key and stay in the
 * ledger - the money did leave the account. Their goal-contribution
 * externalId is cleared in the same transaction so they become ordinary,
 * editable rows instead of pointing the transaction form at a goal that no
 * longer exists. RECURRING rows keep their key: it pairs them with the
 * recurring item's history, not with the goal.
 */
export async function deleteGoalDetachingLedger(goalId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const goal = await tx.goal.findUnique({ where: { id: goalId }, select: { id: true } });
    if (!goal) return false;
    const manual = await tx.goalContribution.findMany({
      where: { goalId, accountId: { not: null } },
      select: { id: true },
    });
    if (manual.length > 0) {
      await tx.transaction.updateMany({
        where: {
          source: "MANUAL",
          externalId: { in: manual.map((row) => manualContributionExternalId(row.id)) },
        },
        data: { externalId: null },
      });
    }
    await tx.goal.delete({ where: { id: goalId } });
    return true;
  });
}

/**
 * Recompute Goal.savedAmount from its contributions - the source of truth - and
 * write the cached value back. Thin wrapper over rebuildGoalSaved() for the
 * callers that only need the total.
 *
 * Contributions are normally already in the goal's own currency: the manual
 * flow forces it, and recurring posting converts once when it writes the row
 * (see src/lib/recurring-posting.ts). The conversion below is for the case that
 * genuinely needs it, a goal whose currency the user has since changed, so the
 * usual rebuild is a plain sum that cannot move with the exchange rate.
 *
 * The read and the write share one transaction with a row lock on the goal.
 * Without it two contributions landing at once can each read the total before
 * the other's row is visible, and the slower writer then persists a
 * savedAmount that is missing a contribution - which also drags achievedAt
 * back and forth with it.
 */
export async function recomputeGoalSaved(goalId: string, today: Date = todayInAppZone()): Promise<number> {
  return (await rebuildGoalSaved(goalId, today)).saved;
}

/**
 * A goal's saved total from its contribution rows, in the goal's currency: a
 * plain sum, converting only rows stored in another currency. The one
 * formula behind Goal.savedAmount, shared with recurring posting's check that
 * a goal is not already reached before each contribution it writes.
 */
export function savedFromContributions(
  contributions: readonly { amount: { toString(): string } | number; currency: string }[],
  goalCurrency: string,
  rates: RateTable,
): number {
  return round2(
    contributions.reduce((total, contribution) => {
      const amount = num(contribution.amount);
      return (
        total +
        (contribution.currency === goalCurrency ? amount : convert(amount, contribution.currency, goalCurrency, rates))
      );
    }, 0),
  );
}

/**
 * The contributions dated on or before `today`: the ones that count towards a
 * goal being achieved. Dates are UTC-midnight calendar days, so the
 * comparison is exact.
 */
export function contributionsOnOrBefore<T extends { date: Date }>(contributions: readonly T[], today: Date): T[] {
  return contributions.filter((contribution) => contribution.date.getTime() <= today.getTime());
}

/**
 * The same rebuild, reporting whether *this* call is the one that crossed the
 * target - i.e. the goal had no achievedAt going in and has one coming out.
 *
 * It has to be decided in here rather than by comparing before/after from the
 * caller: the row lock above is what makes the answer single-valued. Two
 * contributions landing together are serialised by it, so the first sees a null
 * achievedAt and reports the crossing, and the second sees the timestamp the
 * first wrote and reports nothing. A caller reading achievedAt outside the lock
 * could have both report it.
 *
 * A goal that leaves the achieved state here - its target raised, the
 * contribution that reached it removed or edited down, its currency changed -
 * reopens the contributions recurring posting skipped while it was full
 * (skipReasonFor's goal_achieved). Those occurrences were never charged, so
 * the items aimed at the goal move to the first occurrence on or after
 * `today` in the same transaction (skipMissedOccurrences) instead of posting
 * the whole stretch. A goal that stays open, or that was never achieved,
 * touches no item.
 */
export async function rebuildGoalSaved(
  goalId: string,
  today: Date = todayInAppZone(),
): Promise<{ saved: number; justAchieved: boolean }> {
  const exists = await prisma.goal.findUnique({
    where: { id: goalId },
    select: { id: true },
  });
  if (!exists) return { saved: 0, justAchieved: false };

  // Fetched before the transaction on purpose: getRateTable can call the rate
  // service and upsert ExchangeRate rows, and neither belongs inside a lock.
  // It is a single indexed read while the cached rates are fresh.
  const rates = await getRateTable();

  return prisma.$transaction(async (tx) => {
    // Serialises rebuilds for this goal; everything read below is therefore the
    // state left by whichever rebuild committed last.
    await tx.$queryRaw`SELECT "id" FROM "Goal" WHERE "id" = ${goalId} FOR UPDATE`;

    const goal = await tx.goal.findUnique({
      where: { id: goalId },
      select: { currency: true, targetAmount: true, achievedAt: true },
    });
    if (!goal) return { saved: 0, justAchieved: false };

    const contributions = await tx.goalContribution.findMany({
      where: { goalId },
      select: { amount: true, currency: true, date: true },
    });

    // The cached total holds every contribution, whatever its date; reaching
    // the target is judged on the ones dated today or earlier, the same
    // "saved as of today" every page shows (D42), so a contribution dated
    // later cannot mark the goal achieved before its day.
    const saved = savedFromContributions(contributions, goal.currency, rates);
    const savedToDate = savedFromContributions(contributionsOnOrBefore(contributions, today), goal.currency, rates);

    const target = num(goal.targetAmount);
    const achieved = target > 0 && savedToDate >= target;

    await tx.goal.update({
      where: { id: goalId },
      data: {
        savedAmount: saved,
        achievedAt: achieved ? (goal.achievedAt ?? new Date()) : null,
      },
    });
    if (goal.achievedAt !== null && !achieved) {
      await skipMissedOccurrences({ goalId, kind: "CONTRIBUTION" }, today, tx);
    }

    return { saved, justAchieved: achieved && goal.achievedAt === null };
  });
}

/**
 * Marks the goals whose last contribution has come due. A contribution dated
 * ahead is in the cached total from the day it is logged but does not
 * achieve the goal (rebuildGoalSaved), so the day it arrives nothing has
 * written the goal's achievedAt: the cached total holds the target and
 * achievedAt is still null, which is exactly what this looks for. Called at
 * the head of every posting run, before posting reads achievedAt; a caught-up
 * database costs the one query.
 */
export async function markGoalsReachedByDate(today: Date): Promise<number> {
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Goal"
    WHERE "achievedAt" IS NULL
      AND "targetAmount" > 0
      AND "savedAmount" >= "targetAmount"
      AND EXISTS (SELECT 1 FROM "GoalContribution" c WHERE c."goalId" = "Goal"."id")`;
  for (const goal of candidates) {
    await rebuildGoalSaved(goal.id, today);
  }
  return candidates.length;
}

/** Self-heal every goal if the cached values ever drift. */
export async function recomputeAllGoals(): Promise<number> {
  const goals = await prisma.goal.findMany({ select: { id: true } });
  for (const goal of goals) {
    await recomputeGoalSaved(goal.id);
  }
  return goals.length;
}
