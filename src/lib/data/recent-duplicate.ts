/**
 * The guard against saving the same entry twice (R30): a second submit of
 * the form - a double click that got through, a retried request, a second
 * tab - arriving within RECENT_DUPLICATE_WINDOW_MS of a row identical in
 * account, date, amount, type, category, note and source is refused and
 * writes nothing.
 *
 * Two identical requests can arrive together, each checking before the
 * other has written, so the check and the write run in one transaction
 * under a transaction-level advisory lock on the entry's identity: the
 * second waits for the first to commit, then finds its row.
 */
import type { Prisma } from "@/generated/prisma/client";

/** How long after a save an identical one is taken for the same entry submitted again. */
export const RECENT_DUPLICATE_WINDOW_MS = 10_000;

/** Thrown inside the write's transaction so nothing of the second save is written. */
export class RecentDuplicateError extends Error {
  constructor(readonly existingId: string) {
    super("This looks like the entry you just saved");
    this.name = "RecentDuplicateError";
  }
}

/** The fields that make two saves the same entry, as the row stores them. */
export interface EntryIdentity {
  accountId: string;
  date: Date;
  amount: number;
  currency: string;
  type: "EXPENSE" | "INCOME" | "EXTERNAL_TRANSFER" | "TRANSFER" | "OPENING_BALANCE";
  transferDirection?: "IN" | "OUT" | null;
  categoryId: string | null;
  note: string | null;
  source: "MANUAL" | "CSV" | "GMAIL" | "OUTLOOK" | "PAYPAL" | "PAYDAY_CHECKIN" | "OPENING_BALANCE" | "RECURRING";
}

function identityKey(entry: EntryIdentity): string {
  return [
    "recent-entry",
    entry.accountId,
    entry.date.toISOString().slice(0, 10),
    entry.amount.toFixed(2),
    entry.currency,
    entry.type,
    entry.transferDirection ?? "",
    entry.categoryId ?? "",
    entry.note ?? "",
    entry.source,
  ].join("|");
}

/**
 * Inside `tx`, before the row is written: waits for any identical save in
 * flight, then throws RecentDuplicateError when an identical row was saved
 * within the window. `now` is the save's own clock.
 */
export async function refuseRecentDuplicate(
  tx: Prisma.TransactionClient,
  entry: EntryIdentity,
  now: Date = new Date(),
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identityKey(entry)}))`;
  const existing = await tx.transaction.findFirst({
    where: {
      accountId: entry.accountId,
      date: entry.date,
      amount: entry.amount.toFixed(2),
      currency: entry.currency,
      type: entry.type,
      transferDirection: entry.transferDirection ?? null,
      categoryId: entry.categoryId,
      note: entry.note,
      source: entry.source,
      createdAt: { gte: new Date(now.getTime() - RECENT_DUPLICATE_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (existing) throw new RecentDuplicateError(existing.id);
}
