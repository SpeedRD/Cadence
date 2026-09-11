/**
 * Advisory room check for a large subscription, run from the Recurring item
 * form: which active account's typical pay-period margin can carry an ongoing
 * charge of this size?
 *
 * Nothing here projects anything itself. An open-ended subscription has no
 * schedule to walk, so the one period the form's "Next due" date lands in is
 * projected for every active account with Afford's own projectPeriods() -
 * income averaged from comparable history, commitments enumerated from every
 * other active item's schedule (achieved-goal contributions left out), the
 * per-account buffer - and this subscription's charge(s) in that period are
 * judged with Afford's evaluateAffordability(), so "room" means exactly what
 * Afford's account check means. A positive headroom says the account's
 * typical margin covers the charge; it is not a promise about every future
 * period, and the form never blocks a save on it.
 *
 * Afford exposes one account's figures per projection, so the projection runs
 * once per account (in parallel). A handful of accounts and a debounced form
 * make that cheap enough, and it keeps Afford's code untouched.
 */
import {
  buildInstallments,
  evaluateAffordability,
  installmentDates,
  type AccountCheck,
} from "@/lib/afford";
import { convert } from "@/lib/currency";
import { maxDate, startOfDay } from "@/lib/date";
import { num, round2 } from "@/lib/money";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { owedOccurrences } from "@/lib/recurring";
import { isLargeSubscription } from "@/lib/subscription-room";

import { projectPeriods, type AffordContext } from "@/lib/data/afford";
import { HISTORY_PERIODS } from "@/lib/data/payday";

import type { RecurringFrequency } from "@/generated/prisma/enums";

export interface SubscriptionRoomInput {
  amount: number;
  currency: string;
  frequency: RecurringFrequency;
  nextDate: Date;
  /**
   * The item being edited, if any. Its current schedule is already among the
   * period's commitments, so its own occurrences there are taken back out
   * before the edited amount is judged - otherwise editing a 12,000 item
   * would count it twice.
   */
  excludeItemId?: string | null;
}

/** One account's Afford-style check, plus its resulting headroom in the display currency so accounts in different currencies rank against each other. */
export interface AccountRoom extends AccountCheck {
  headroomAfterDisplay: number;
}

export type SubscriptionRoom =
  | { large: false }
  | {
      large: true;
      /** The pay period the "Next due" date lands in (today's period if that date has passed). */
      period: PeriodInfo;
      /** How many charges of this subscription land in that period (a weekly item has two or three). */
      occurrences: number;
      /** Their sum, in the subscription's currency - what every account's check subtracts. */
      charge: number;
      currency: string;
      displayCurrency: string;
      /** Most room first. */
      accounts: AccountRoom[];
      /** The account with the most room among those that keep their buffer; null when none does. */
      recommendedAccountId: string | null;
      historyPeriods: number;
    };

/**
 * Pure read. Plain function (no requireAuth()) so scripts/verify-domain.ts can
 * drive it the same way the server action does.
 */
export async function checkSubscriptionRoom(
  input: SubscriptionRoomInput,
  context: AffordContext,
): Promise<SubscriptionRoom> {
  if (!isLargeSubscription(input.amount, input.currency, context.rates)) return { large: false };

  const accounts = await prisma.account.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, currency: true },
  });

  // An overdue "Next due" is owed now, so it lands in the current period -
  // the same rule Afford's commitment walk applies to an overdue item.
  const reference = maxDate(startOfDay(input.nextDate), context.today);
  const period = periodForDate(reference);
  // Enough dates to cover a half-month at any frequency; only the ones inside
  // the reference period are kept. The first date always is.
  const dates = installmentDates(reference, input.frequency, 4).filter(
    (date) => periodForDate(date).key === period.key,
  );
  const installments = buildInstallments(dates, input.amount);
  const charge = round2(input.amount * installments.length);

  const ownCommitment = await ownCommitmentInPeriod(input.excludeItemId, period, accounts, context);

  const projections = await Promise.all(
    accounts.map((account) => projectPeriods([period], account, accounts, context)),
  );
  const rooms: AccountRoom[] = accounts.map((account, index) => {
    const projection = projections[index].get(period.key);
    if (!projection) throw new Error(`No projection for period ${period.key}`);
    const own = ownCommitment.accountId === account.id ? ownCommitment.amount : 0;
    const adjusted =
      own > 0
        ? {
            ...projection,
            account: { ...projection.account, committed: round2(projection.account.committed - own) },
          }
        : projection;
    const verdict = evaluateAffordability({
      installments,
      currency: input.currency,
      projections: new Map([[period.key, adjusted]]),
      rates: context.rates,
    });
    const check = verdict.periods[0].account;
    return {
      ...check,
      headroomAfterDisplay: round2(
        convert(check.headroomAfter, check.currency, context.displayCurrency, context.rates),
      ),
    };
  });
  rooms.sort((a, b) => b.headroomAfterDisplay - a.headroomAfterDisplay || a.name.localeCompare(b.name));

  const fitting = rooms.filter((room) => room.passes);
  return {
    large: true,
    period,
    occurrences: installments.length,
    charge,
    currency: input.currency,
    displayCurrency: context.displayCurrency,
    accounts: rooms,
    recommendedAccountId: fitting[0]?.accountId ?? null,
    historyPeriods: HISTORY_PERIODS,
  };
}

/**
 * What the item being edited already commits to `period` on its funding
 * account, in that account's currency - counted exactly as Afford's
 * loadScheduledCommitments counts it (same owedOccurrences walk, same
 * overdue-lands-now rule, same achieved-goal and inactive exclusions), so
 * taking it back out leaves the period as if the item did not exist yet.
 */
async function ownCommitmentInPeriod(
  itemId: string | null | undefined,
  period: PeriodInfo,
  accounts: { id: string; currency: string }[],
  context: AffordContext,
): Promise<{ accountId: string | null; amount: number }> {
  const none = { accountId: null, amount: 0 };
  if (!itemId) return none;
  const item = await prisma.recurringItem.findUnique({
    where: { id: itemId },
    select: {
      active: true,
      amount: true,
      currency: true,
      frequency: true,
      nextDate: true,
      anchorDay: true,
      remainingOccurrences: true,
      accountId: true,
      kind: true,
      goal: { select: { achievedAt: true } },
    },
  });
  if (!item || !item.active || !item.accountId) return none;
  if (item.kind === "CONTRIBUTION" && item.goal?.achievedAt) return none;
  const account = accounts.find((candidate) => candidate.id === item.accountId);
  if (!account) return none;
  const dues = owedOccurrences(item, context.today, period.end).filter((due) => {
    const key = due.getTime() < context.today.getTime() ? context.currentPeriod.key : periodForDate(due).key;
    return key === period.key;
  });
  if (dues.length === 0) return none;
  return {
    accountId: account.id,
    amount: round2(convert(num(item.amount), item.currency, account.currency, context.rates) * dues.length),
  };
}
