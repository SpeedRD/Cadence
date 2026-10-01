/**
 * Reads the deposits earmarked for recurring occurrences (RecurringEarmark;
 * the rules are src/lib/earmarks.ts). The period commitments
 * (src/lib/data/period-commitments.ts) read them for every occurrence they
 * plan, and the Recurring page for the occurrences it names. The form's
 * choices and the writer are src/lib/data/earmark-targets.ts.
 */
import { boundByDeposit, type EarmarkFact, type OccurrenceEarmark } from "@/lib/earmarks";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import type { Prisma } from "@/generated/prisma/client";
import type { RateTable } from "@/lib/currency";

type Client = Prisma.TransactionClient;

const EARMARK_SELECT = {
  transactionId: true,
  occurrenceKey: true,
  dueDate: true,
  amount: true,
  currency: true,
  transaction: { select: { date: true, amount: true, currency: true, note: true } },
} satisfies Prisma.RecurringEarmarkSelect;

/**
 * The deposits earmarked for each of `keys`, by occurrence key, each bounded
 * by its deposit (boundByDeposit): a deposit's other earmarks are read too,
 * so a deposit split over several occurrences never covers more than it
 * holds, whichever of them is asked about. Each part is in the currency it
 * was written in; planCommitments converts it into the occurrence's.
 */
export async function loadOccurrenceEarmarks(
  keys: readonly string[],
  rates: RateTable,
  client: Client = prisma,
): Promise<Map<string, OccurrenceEarmark[]>> {
  if (keys.length === 0) return new Map();
  const touching = await client.recurringEarmark.findMany({
    where: { occurrenceKey: { in: [...new Set(keys)] } },
    select: { transactionId: true },
  });
  if (touching.length === 0) return new Map();
  const rows = await client.recurringEarmark.findMany({
    where: { transactionId: { in: [...new Set(touching.map((row) => row.transactionId))] } },
    select: EARMARK_SELECT,
  });
  const facts: EarmarkFact[] = rows.map((row) => ({
    transactionId: row.transactionId,
    occurrenceKey: row.occurrenceKey,
    dueDate: row.dueDate,
    amount: num(row.amount),
    currency: row.currency,
    deposit: {
      date: row.transaction.date,
      amount: num(row.transaction.amount),
      currency: row.transaction.currency,
      label: row.transaction.note,
    },
  }));
  const wanted = new Set(keys);
  return new Map([...boundByDeposit(facts, rates)].filter(([key]) => wanted.has(key)));
}

/** One deposit's earmarks as the transaction form shows them, amounts as stored. */
export interface DepositEarmark {
  occurrenceKey: string;
  amount: number;
  currency: string;
}

/** Each of `depositIds`' earmarks, by deposit id, soonest occurrence first. */
export async function loadDepositEarmarks(depositIds: readonly string[]): Promise<Map<string, DepositEarmark[]>> {
  const result = new Map<string, DepositEarmark[]>();
  if (depositIds.length === 0) return result;
  const rows = await prisma.recurringEarmark.findMany({
    where: { transactionId: { in: [...new Set(depositIds)] } },
    orderBy: [{ dueDate: "asc" }, { occurrenceKey: "asc" }],
    select: { transactionId: true, occurrenceKey: true, amount: true, currency: true },
  });
  for (const row of rows) {
    const entry = { occurrenceKey: row.occurrenceKey, amount: num(row.amount), currency: row.currency };
    const list = result.get(row.transactionId);
    if (list) list.push(entry);
    else result.set(row.transactionId, [entry]);
  }
  return result;
}
