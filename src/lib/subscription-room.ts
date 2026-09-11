/**
 * The threshold for the Recurring form's large-subscription room check. No
 * I/O and no Prisma here: the form (a client component) reads the threshold
 * to explain itself, and src/lib/data/subscription-room.ts applies it.
 */
import { convert, type RateTable } from "@/lib/currency";

/** A subscription at or above this (converted from whatever currency it is entered in) gets the check. */
export const LARGE_SUBSCRIPTION_THRESHOLD = { amount: 10000, currency: "DOP" } as const;

export function isLargeSubscription(amount: number, currency: string, rates: RateTable): boolean {
  return (
    convert(amount, currency, LARGE_SUBSCRIPTION_THRESHOLD.currency, rates) >=
    LARGE_SUBSCRIPTION_THRESHOLD.amount
  );
}
