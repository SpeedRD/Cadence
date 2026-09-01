import { addDays, addMonths, addYears, startOfDay } from "@/lib/date";
import { prisma } from "@/lib/prisma";

import type { RecurringFrequency } from "@/generated/prisma/enums";

/** The next occurrence after `date` for a given frequency. */
export function advanceDate(date: Date, frequency: RecurringFrequency): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDays(date, 7);
    case "BIWEEKLY":
      return addDays(date, 14);
    case "YEARLY":
      return addYears(date, 1);
    case "MONTHLY":
    default:
      return addMonths(date, 1);
  }
}

/**
 * Roll every active recurring item forward until its nextDate is in the future.
 *
 * This is what keeps an already-passed item from being counted as still
 * "committed" in the current period. It never creates a Transaction - the user
 * logs the actual spend (Phase 2 will detect it automatically).
 */
export async function advanceDueRecurringItems(reference: Date): Promise<number> {
  const today = startOfDay(reference);
  const due = await prisma.recurringItem.findMany({
    where: { active: true, nextDate: { lt: today } },
    select: { id: true, nextDate: true, frequency: true },
  });

  let advanced = 0;
  for (const item of due) {
    let next = item.nextDate;
    // Bounded so a long-dormant weekly item cannot spin forever.
    for (let i = 0; i < 500 && next.getTime() < today.getTime(); i += 1) {
      next = advanceDate(next, item.frequency);
    }
    if (next.getTime() !== item.nextDate.getTime()) {
      await prisma.recurringItem.update({
        where: { id: item.id },
        data: { nextDate: next },
      });
      advanced += 1;
    }
  }
  return advanced;
}

/** Cost per calendar month, used for the subscriptions total. */
export function monthlyEquivalent(
  amount: number,
  frequency: RecurringFrequency,
): number {
  switch (frequency) {
    case "WEEKLY":
      return (amount * 52) / 12;
    case "BIWEEKLY":
      return (amount * 26) / 12;
    case "YEARLY":
      return amount / 12;
    case "MONTHLY":
    default:
      return amount;
  }
}
