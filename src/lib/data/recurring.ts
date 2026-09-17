import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { monthlyEquivalent } from "@/lib/recurring";

import type { AppContext } from "@/lib/data/context";
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
}

export async function listRecurringItems(context: AppContext) {
  const items = await prisma.recurringItem.findMany({
    include: {
      category: { select: { name: true, color: true } },
      account: { select: { name: true, status: true } },
      goal: { select: { name: true, achievedAt: true } },
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
 * The one write for "which account funds this recurring item" - the same
 * RecurringItem.accountId the Recurring page's form saves, so the payday
 * check-in's per-account reassignment moves the very row that page lists
 * rather than keeping a plan-local override. Returns false when the item is
 * gone (deleted in another tab while the wizard was open).
 */
export async function setRecurringItemAccount(id: string, accountId: string): Promise<boolean> {
  const updated = await prisma.recurringItem.updateMany({ where: { id }, data: { accountId } });
  return updated.count > 0;
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
