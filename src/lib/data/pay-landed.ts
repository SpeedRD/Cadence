/**
 * When each period's pay landed (loadPayLanded), which opens its funding
 * window (fundingWindow in src/lib/period.ts): the goal plan's contribution
 * window (K3), Step 1's reconciliation date, and the period a recurring
 * contribution is filed in (src/lib/period-commitments.ts). Its own module so
 * the period commitments can read it without importing period income, which
 * reads them.
 */
import { accountAmount, moneyRow } from "@/lib/account-money";
import { num } from "@/lib/money";
import {
  fundedPeriodFor,
  incomeWindow,
  nextPeriod as nextPeriodRef,
  paydayDateFor,
  periodInfo,
  periodKey,
  type PayLanded,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { reimbursedExpenseIdFromTransaction } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";

/**
 * A deposit is pay - it opens its period's goal money (fundingWindow) and
 * Step 1's reconciliation date - only when it is at least this share of the
 * account's most recent confirmed paycheck (R4): a refund, interest or a
 * small transfer landing in the lead days is not.
 */
export const PAY_SHARE_OF_PAYCHECK = 0.5;

/**
 * The day each period's pay was recorded as landing, for fundingWindow (src/lib/period.ts):
 * the earliest of its confirmed check-in's paycheck transaction and the
 * ordinary deposits its income window attributes to it (one-off income and
 * paybacks are not pay) that are at least PAY_SHARE_OF_PAYCHECK of their
 * account's most recent confirmed paycheck - the incomeEntered of the latest
 * confirmed check-in before that period recording income on it - counting
 * only one dated from PAYCHECK_LEAD_DAYS before its first day through its
 * payday. An account with no confirmed paycheck before the period has no
 * deposit that opens it. A period with none has no entry and its window
 * opens on its payday. Returned as the PayLanded lookup fundingWindow takes,
 * covering `periods` and the period after each.
 */
export async function loadPayLanded(
  periods: readonly PeriodRef[],
  context: Pick<AppContext, "rates">,
): Promise<PayLanded> {
  const refs = new Map<string, PeriodRef>();
  for (const period of periods) {
    const info = periodInfo(period);
    refs.set(info.key, info);
    const next = periodInfo(nextPeriodRef(info));
    refs.set(next.key, next);
  }
  const landed = new Map<string, Date>();
  const lookup: PayLanded = (ref) => landed.get(periodKey(ref)) ?? null;
  if (refs.size === 0) return lookup;
  const all = [...refs.values()];
  const from = new Date(Math.min(...all.map((ref) => incomeWindow(ref).from.getTime())));
  const through = new Date(Math.max(...all.map((ref) => paydayDateFor(ref).getTime())));
  const lastKey = all.map((ref) => periodKey(ref)).sort().at(-1) as string;
  const [rows, checkins, paychecks] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: "INCOME", date: { gte: from, lte: through } },
      select: {
        id: true,
        date: true,
        source: true,
        type: true,
        isOneOffIncome: true,
        reimbursesTransactionId: true,
        accountId: true,
        amount: true,
        currency: true,
        originalAmount: true,
        originalCurrency: true,
        rate: true,
      },
    }),
    prisma.paydayCheckin.findMany({
      where: { status: "CONFIRMED", OR: all.map((ref) => ({ year: ref.year, month: ref.month, period: ref.period })) },
      select: { year: true, month: true, period: true, snapshots: { select: { incomeTransactionId: true } } },
    }),
    // Every confirmed paycheck up to the last period asked about, newest
    // first: the reference a deposit is measured against.
    prisma.paydayAccountSnapshot.findMany({
      where: { incomeEntered: { gt: 0 }, checkin: { status: "CONFIRMED" } },
      select: { accountId: true, incomeEntered: true, currency: true, checkin: { select: { year: true, month: true, period: true } } },
    }),
  ]);
  const paycheckHistory = paychecks
    .map((snapshot) => ({
      accountId: snapshot.accountId,
      key: periodKey(snapshot.checkin),
      amount: num(snapshot.incomeEntered),
      currency: snapshot.currency,
    }))
    .filter((paycheck) => paycheck.key <= lastKey)
    .sort((a, b) => b.key.localeCompare(a.key));
  // The account's most recent confirmed paycheck before the period `key`.
  const paycheckBefore = (accountId: string, key: string) =>
    paycheckHistory.find((paycheck) => paycheck.accountId === accountId && paycheck.key < key) ?? null;
  // A check-in's paycheck row belongs to the period its check-in planned.
  const paycheckPeriod = new Map<string, string>();
  for (const checkin of checkins) {
    for (const snapshot of checkin.snapshots) {
      if (snapshot.incomeTransactionId) paycheckPeriod.set(snapshot.incomeTransactionId, periodInfo(checkin).key);
    }
  }
  for (const row of rows) {
    let key: string | undefined;
    if (row.source === "PAYDAY_CHECKIN") key = paycheckPeriod.get(row.id);
    else if (!row.isOneOffIncome && reimbursedExpenseIdFromTransaction(row) === null) {
      const funded = fundedPeriodFor(row.date).key;
      const paycheck = paycheckBefore(row.accountId, funded);
      // Pay, not a refund or interest: at least half the account's last paycheck.
      const amount = paycheck ? accountAmount(moneyRow(row), paycheck.currency, context.rates) : 0;
      if (paycheck && amount + 0.005 >= paycheck.amount * PAY_SHARE_OF_PAYCHECK) key = funded;
    }
    const ref = key ? refs.get(key) : undefined;
    if (!key || !ref) continue;
    // Only pay landing from the lead through the payday opens the window.
    if (row.date.getTime() < incomeWindow(ref).from.getTime() || row.date.getTime() > paydayDateFor(ref).getTime()) continue;
    const current = landed.get(key);
    if (!current || row.date.getTime() < current.getTime()) landed.set(key, row.date);
  }
  return lookup;
}
