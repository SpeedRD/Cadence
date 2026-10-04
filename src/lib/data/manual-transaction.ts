/**
 * Creating a transaction by hand, as a plain function - no requireAuth()/
 * cookies() - so scripts/verify-domain.ts drives the same code
 * saveTransactionAction does; the action parses, checks the session and turns
 * the outcome into a toast and the form's follow-up questions.
 *
 * The row is written unless it cannot be stored truthfully or was just
 * saved: an amount in another currency with no current rate to convert it
 * (RatesUnavailableError), one that comes to 0.00 in the account's currency
 * (RoundsToZeroError), or the same entry submitted again within seconds
 * (RecentDuplicateError). Two hints may come back with it, and neither can
 * stop it: an unusually large expense (src/lib/extraordinary.ts), and money
 * the ledger may already hold as a row Cadence wrote itself - a posted
 * recurring charge or a check-in's paycheck - or that posting will write, an
 * upcoming payment in another currency (lookUpPostedDuplicates, which fails
 * open).
 */
import {
  chargedInAccount,
  needsConversion,
  refuseZeroAmount,
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
import { refuseRecentDuplicate } from "@/lib/data/recent-duplicate";
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
 * `chargedAmount` is the bank's own figure in the account's currency, when
 * the form has one: it is stored as typed, with the entered amount kept and
 * the rate the two imply (chargedInAccount). Rates are asked for only when a
 * conversion is needed, and only rates fit to be written down are used: with
 * none, the conversion throws RatesUnavailableError and the form asks for the
 * amount in the account's currency instead (R20). An entry that comes to
 * 0.00 in the account's currency throws RoundsToZeroError (R29).
 */
export async function storedTransactionValues(
  values: ManualTransactionValues,
  getRates: () => Promise<RateTable>,
  previous?: { row: MoneyRow & { yourShare: number | null }; accountCurrency: string } | null,
  chargedAmount: number | null = null,
): Promise<StoredTransactionValues> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: values.accountId }, select: { currency: true } });
  const entered = { amount: values.amount, currency: values.currency };
  // The bank's own figure, when the form has one, is the stored amount as
  // typed; otherwise the entry is converted (or keeps its stored conversion).
  const stored = refuseZeroAmount(
    entered,
    chargedAmount != null && needsConversion(values.currency, account.currency)
      ? chargedInAccount(entered, account.currency, chargedAmount)
      : toAccountMoney(
          entered,
          account.currency,
          needsConversion(values.currency, account.currency) ? await getRates() : IDENTITY_RATES,
          previous,
        ),
  );
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
  /** The amount as stored, in the account's currency (K7). */
  storedAmount: number;
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
    /** "Amount charged in <account currency>": the bank's own figure for an entry in another currency. */
    chargedAmount?: number | null;
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
    null,
    options.chargedAmount ?? null,
  );
  // The same entry saved a moment ago (a second submit) is refused and
  // nothing is written (refuseRecentDuplicate, R30).
  const created = await prisma.$transaction(async (tx) => {
    await refuseRecentDuplicate(tx, {
      accountId: stored.accountId,
      date: stored.date,
      amount: stored.amount,
      currency: stored.currency,
      type: stored.type,
      transferDirection: stored.transferDirection,
      categoryId: stored.categoryId,
      note: stored.note,
      source: "MANUAL",
    });
    return tx.transaction.create({ data: { ...stored, source: "MANUAL" } });
  });

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
          // A charge in the account's currency may also be an upcoming
          // payment in another currency, which posting would otherwise
          // write again (see findPostedDuplicates' `upcoming`).
          { lookup: options.lookup, timeoutMs: options.timeoutMs, upcoming: true },
        )
      : null;
  const match = found?.get(created.id);

  return {
    id: created.id,
    storedAmount: num(created.amount),
    extraordinary: extraordinary ? { hit: extraordinary, measured } : null,
    posted: match ? { match, savedDigest: entryDigest(created) } : null,
  };
}
