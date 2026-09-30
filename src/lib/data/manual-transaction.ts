/**
 * Creating a transaction by hand, as a plain function - no requireAuth()/
 * cookies() - so scripts/verify-domain.ts drives the same code
 * saveTransactionAction does; the action parses, checks the session and turns
 * the outcome into a toast and the form's follow-up questions.
 *
 * The row is always written. Two hints may come back with it, and neither can
 * stop it: an unusually large expense (src/lib/extraordinary.ts), and money
 * the ledger may already hold as a row Cadence wrote itself - a posted
 * recurring charge or a check-in's paycheck (lookUpPostedDuplicates, which
 * fails open).
 */
import {
  needsConversion,
  shareInAccountCurrency,
  toAccountMoney,
  type MoneyRow,
  type StoredMoney,
} from "@/lib/account-money";
import { IDENTITY_RATES } from "@/lib/currency";
import { ownShare } from "@/lib/shared-expense";
import { prisma } from "@/lib/prisma";
import { num } from "@/lib/money";
import { getRateTable } from "@/lib/rates";

import { findExtraordinaryCandidates, type ExtraordinaryHit } from "@/lib/data/extraordinary";
import {
  entryDigest,
  lookUpPostedDuplicates,
  type PostedLookup,
  type PostedMatch,
} from "@/lib/data/posted-duplicates";

import type { z } from "zod";
import type { AppContext } from "@/lib/data/context";
import type { RateTable } from "@/lib/currency";
import type { transactionSchema } from "@/lib/validation";

export type ManualTransactionValues = Omit<z.infer<typeof transactionSchema>, "id">;

/** The form's values as the row stores them: amount and share in the account's currency, with the entered figure kept beside them. */
export type StoredTransactionValues = Omit<ManualTransactionValues, "currency"> & StoredMoney;

/**
 * K7 for the transaction form (src/lib/account-money.ts): the entered amount
 * and share stored in the account's currency, converted once at `getRates`'
 * rate when the form's currency is another, with the entered figure and the
 * rate kept. `previous` is the row being edited, as stored, and its account's
 * currency: re-saving it unchanged keeps its stored conversion, and a new
 * amount in the same currency is converted at the rate stored with it.
 * Rates are asked for only when a conversion is needed.
 */
export async function storedTransactionValues(
  values: ManualTransactionValues,
  getRates: () => Promise<RateTable>,
  previous?: { row: MoneyRow & { yourShare: number | null }; accountCurrency: string } | null,
): Promise<StoredTransactionValues> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: values.accountId }, select: { currency: true } });
  const table = needsConversion(values.currency, account.currency) ? await getRates() : IDENTITY_RATES;
  const stored = toAccountMoney({ amount: values.amount, currency: values.currency }, account.currency, table, previous);
  return {
    ...values,
    amount: stored.amount,
    currency: stored.currency,
    originalAmount: stored.originalAmount,
    originalCurrency: stored.originalCurrency,
    rate: stored.rate,
    // undefined stays undefined: the form did not offer the share, and the
    // stored one is left as it is (see transactionSchema).
    yourShare:
      values.yourShare === undefined ? undefined : shareInAccountCurrency(values.yourShare, stored, previous),
  };
}

export interface ManualTransactionResult {
  id: string;
  /** Set when the expense is unusually large for its category, measured at `measured` (the user's own share). */
  extraordinary: { hit: ExtraordinaryHit; measured: number } | null;
  /** Set when the saved row matches a posted charge or a recorded paycheck; `savedDigest` names the row as saved. */
  posted: { match: PostedMatch; savedDigest: string } | null;
}

export async function createManualTransaction(
  values: ManualTransactionValues,
  options: {
    /** The request's context - loaded only for a categorized expense, which the one-off check measures. */
    getContext: () => Promise<AppContext>;
    /** Rates for the duplicate check, asked for only when a candidate is in another currency. */
    getRates?: () => Promise<RateTable>;
    lookup?: PostedLookup;
    timeoutMs?: number;
  },
): Promise<ManualTransactionResult> {
  // Measured before the row lands so it is not its own history. The row is
  // saved unflagged whatever the verdict; a hit only asks the form to put
  // the question to the user (see src/lib/extraordinary.ts). A shared
  // expense is measured at the user's own share: that is the figure the
  // averages the flag protects would read for it.
  const measured = ownShare({ amount: values.amount, yourShare: values.yourShare ?? null });
  const context = values.type === "EXPENSE" && values.categoryId ? await options.getContext() : null;
  const extraordinary =
    context && values.categoryId
      ? (
          await findExtraordinaryCandidates(
            [{ key: "new", categoryId: values.categoryId, amount: measured, currency: values.currency }],
            context,
          )
        ).get("new")
      : undefined;

  // Stored in the account's currency (K7); the one-off check above measured
  // what the user typed, which it converts into the display currency itself.
  const stored = await storedTransactionValues(
    values,
    async () => (context ? context.rates : await (options.getRates ?? getRateTable)()),
  );
  const created = await prisma.transaction.create({ data: { ...stored, source: "MANUAL" } });

  const found =
    created.type === "EXPENSE" || created.type === "INCOME"
      ? await lookUpPostedDuplicates(
          [
            {
              key: created.id,
              accountId: created.accountId,
              type: created.type,
              date: created.date,
              amount: num(created.amount),
              currency: created.currency,
              originalAmount: created.originalAmount === null ? null : num(created.originalAmount),
              originalCurrency: created.originalCurrency,
              rate: created.rate === null ? null : num(created.rate),
              note: created.note,
              categoryId: created.categoryId,
            },
          ],
          context ? context.rates : (options.getRates ?? getRateTable),
          { lookup: options.lookup, timeoutMs: options.timeoutMs },
        )
      : null;
  const match = found?.get(created.id);

  return {
    id: created.id,
    extraordinary: extraordinary ? { hit: extraordinary, measured } : null,
    posted: match ? { match, savedDigest: entryDigest(created) } : null,
  };
}
