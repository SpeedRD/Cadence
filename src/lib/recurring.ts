import { addDays, addMonths, addYears } from "@/lib/date";

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
