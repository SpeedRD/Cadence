import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { monthlyEquivalent } from "@/lib/recurring";

import type { AppContext } from "@/lib/data/context";
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
  active: boolean;
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
   * (active) account, or is a contribution with no goal. Mirrors the skip
   * rules in src/lib/recurring-posting.ts.
   */
  needs: "account" | "goal" | null;
}

export async function listRecurringItems(context: AppContext) {
  const items = await prisma.recurringItem.findMany({
    include: {
      category: { select: { name: true, color: true } },
      account: { select: { name: true, status: true } },
      goal: { select: { name: true } },
    },
    orderBy: [{ active: "desc" }, { nextDate: "asc" }],
  });

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
      active: item.active,
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
            : null,
    };
  });

  const subscriptions = rows.filter((row) => row.kind === "SUBSCRIPTION");
  const contributions = rows.filter((row) => row.kind === "CONTRIBUTION");

  const monthlyTotal = (list: RecurringRow[]) =>
    round2(
      list
        .filter((row) => row.active)
        .reduce((total, row) => total + row.monthlyDisplayAmount, 0),
    );

  return {
    subscriptions,
    contributions,
    subscriptionsMonthly: monthlyTotal(subscriptions),
    contributionsMonthly: monthlyTotal(contributions),
  };
}
