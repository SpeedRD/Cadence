/**
 * The threshold for the Recurring form's large-subscription room check. No
 * I/O and no Prisma here: the form (a client component) reads the threshold
 * to explain itself, and src/lib/data/subscription-room.ts applies it.
 */
import { convert, type RateTable } from "@/lib/currency";
import { monthlyEquivalent } from "@/lib/recurring";

import type { RecurringFrequency } from "@/generated/prisma/enums";

/** A subscription whose charge or monthly cost is at or above this (converted from whatever currency it is entered in) gets the check. */
export const LARGE_SUBSCRIPTION_THRESHOLD = { amount: 10000, currency: "DOP" } as const;

/**
 * Checked when one charge reaches the threshold or the item's monthly
 * equivalent does. A weekly 3,000 DOP item costs about 13,000 a month however
 * small each charge is; a yearly 119,999 DOP item costs about 10,000 a month
 * but lands whole in one pay period. SEMI_MONTHLY is never checked (the room
 * check's occurrence walk has no second anchor to work with).
 */
export function isLargeSubscription(
  amount: number,
  currency: string,
  frequency: RecurringFrequency,
  rates: RateTable,
): boolean {
  if (frequency === "SEMI_MONTHLY") return false;
  const reaches = (value: number) =>
    convert(value, currency, LARGE_SUBSCRIPTION_THRESHOLD.currency, rates) >=
    LARGE_SUBSCRIPTION_THRESHOLD.amount;
  return reaches(amount) || reaches(monthlyEquivalent(amount, frequency));
}
