/**
 * Amounts stored in the account's currency (QUANTITIES_MAP.md K7). A
 * Transaction's `amount` and `currency` are what its account moved, fixed at
 * entry: money entered in another currency is converted once, at the rate of
 * the day it was entered, and the entered figure and that rate are kept beside
 * it (originalAmount, originalCurrency, rate). Nothing re-converts a stored
 * row afterwards, so a balance no longer moves with the exchange rate.
 *
 * A row written before this existed may still carry another currency than its
 * account's, with no original. accountAmount reads such a row the way every
 * reader always did - converted at today's rate - so the code can run before
 * scripts/backfill-account-currency.ts stores those rows.
 *
 * Pure and database-free, so the transaction form can show exactly the figure
 * the server will store, and scripts/verify-domain.ts can check it directly.
 */
import { convert, ratesFitForWriting, type RateTable } from "@/lib/currency";
import { num, round2, toCents, withinCents, type DecimalLike } from "@/lib/money";
import { balanceSign, transferLegs } from "@/lib/transactions";

/** Transaction.rate's scale (Decimal(20, 10)). */
export const RATE_DECIMALS = 10;

/**
 * Thrown instead of converting with rates that may not be written down
 * (ratesFitForWriting, R20): the caller asks for the amount in the
 * account's currency, or tries again once rates are back - a foreign row is
 * never stored at a fallback or stale rate.
 */
export class RatesUnavailableError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`no current exchange rate to convert ${from} into ${to}`);
    this.name = "RatesUnavailableError";
  }
}

/**
 * Thrown when an amount entered in another currency comes to 0.00 in the
 * account's (0.25 DOP into a USD account, R29): a zero-amount row records
 * nothing, so the entry is refused rather than stored as 0.
 */
export class RoundsToZeroError extends Error {
  constructor(readonly entered: EnteredMoney, readonly accountCurrency: string) {
    super(`${entered.amount} ${entered.currency} is 0.00 in ${accountCurrency}`);
    this.name = "RoundsToZeroError";
  }
}

/** Money as the user entered it: the form's amount and currency. */
export interface EnteredMoney {
  amount: number;
  currency: string;
}

/** A row's money as stored: in its account's currency, with the entered figure when that differed. */
export interface StoredMoney {
  amount: number;
  currency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
  rate: number | null;
}

/** The money fields any reader has of a row; the originals are absent on rows loaded without them. */
export interface MoneyRow {
  amount: number;
  currency: string;
  originalAmount?: number | null;
  originalCurrency?: string | null;
  rate?: number | null;
}

/** A loaded row's money fields as numbers (Prisma returns Decimals). */
export function moneyRow(row: {
  amount: DecimalLike;
  currency: string;
  originalAmount?: DecimalLike;
  originalCurrency?: string | null;
  rate?: DecimalLike;
}): MoneyRow {
  return {
    amount: num(row.amount),
    currency: row.currency,
    originalAmount: row.originalAmount === null || row.originalAmount === undefined ? null : num(row.originalAmount),
    originalCurrency: row.originalCurrency ?? null,
    rate: row.rate === null || row.rate === undefined ? null : num(row.rate),
  };
}

/** A rate as Transaction.rate stores it. */
export function roundRate(rate: number): number {
  return Number(rate.toFixed(RATE_DECIMALS));
}

/** Units of `to` per unit of `from` in `table`, as stored. */
export function rateBetween(from: string, to: string, table: RateTable): number {
  return roundRate(convert(1, from, to, table));
}

/** `amount` converted at a stored rate, to the cent. */
export function atRate(amount: number, rate: number): number {
  return round2(amount * rate);
}

function plain(amount: number, currency: string): StoredMoney {
  return { amount: round2(amount), currency, originalAmount: null, originalCurrency: null, rate: null };
}

/**
 * K7 at entry: `entered` as the account in `accountCurrency` stores it. In the
 * account's own currency it is stored as typed; in another it is converted at
 * `table`'s rate, which is kept with the entered figure - only when both
 * currencies have a rate fit to be written down (ratesFitForWriting);
 * otherwise RatesUnavailableError.
 */
export function inAccountCurrency(entered: EnteredMoney, accountCurrency: string, table: RateTable): StoredMoney {
  if (entered.currency === accountCurrency) return plain(entered.amount, accountCurrency);
  if (!ratesFitForWriting(table, entered.currency, accountCurrency)) throw new RatesUnavailableError(entered.currency, accountCurrency);
  const rate = rateBetween(entered.currency, accountCurrency, table);
  return {
    amount: atRate(entered.amount, rate),
    currency: accountCurrency,
    originalAmount: round2(entered.amount),
    originalCurrency: entered.currency,
    rate,
  };
}

/** The row as the user entered it: its original when it was converted, otherwise what is stored. */
export function enteredMoney(row: MoneyRow): EnteredMoney {
  return row.originalCurrency != null && row.originalAmount != null
    ? { amount: row.originalAmount, currency: row.originalCurrency }
    : { amount: row.amount, currency: row.currency };
}

/** The stored fields of a row, with absent originals read as none. */
export function storedMoney(row: MoneyRow): StoredMoney {
  return {
    amount: row.amount,
    currency: row.currency,
    originalAmount: row.originalAmount ?? null,
    originalCurrency: row.originalCurrency ?? null,
    rate: row.rate ?? null,
  };
}

/**
 * K7 on an edit of a row already stored (`previous`, on an account in
 * `previousAccountCurrency`): the same money re-entered on the same account
 * keeps its stored conversion - an edit of the date or the note never
 * re-converts anything (B25); a new amount in the same currency is converted
 * at the rate stored with the row, so a correction scales what was stored
 * rather than taking today's rate; anything else - another currency, another
 * account, a row stored before K7 in a foreign currency - is converted as a
 * new entry would be.
 */
export function toAccountMoney(
  entered: EnteredMoney,
  accountCurrency: string,
  table: RateTable,
  previous?: { row: MoneyRow; accountCurrency: string } | null,
): StoredMoney {
  if (entered.currency === accountCurrency) return plain(entered.amount, accountCurrency);
  const kept = previous && previous.accountCurrency === accountCurrency ? storedMoney(previous.row) : null;
  if (kept && kept.currency === accountCurrency && kept.originalCurrency === entered.currency && kept.rate !== null) {
    if (kept.originalAmount !== null && withinCents(kept.originalAmount, entered.amount)) return kept;
    return {
      amount: atRate(entered.amount, kept.rate),
      currency: accountCurrency,
      originalAmount: round2(entered.amount),
      originalCurrency: entered.currency,
      rate: kept.rate,
    };
  }
  return inAccountCurrency(entered, accountCurrency, table);
}

/**
 * K7 with the bank's own figure: `entered` (in another currency than the
 * account's) stored as `charged`, what the account really moved, to the cent,
 * with the entered figure kept and the rate the two imply (charged /
 * original) - not a rate table's. In the account's own currency there is
 * nothing to convert and `charged` is not read.
 */
export function chargedInAccount(entered: EnteredMoney, accountCurrency: string, charged: number): StoredMoney {
  if (entered.currency === accountCurrency || entered.amount <= 0) return plain(entered.amount, accountCurrency);
  return {
    amount: round2(charged),
    currency: accountCurrency,
    originalAmount: round2(entered.amount),
    originalCurrency: entered.currency,
    rate: roundRate(round2(charged) / round2(entered.amount)),
  };
}

/**
 * Refuses money entered above zero that is stored as 0.00 in the account's
 * currency (R29), returning `stored` otherwise.
 */
export function refuseZeroAmount(entered: EnteredMoney, stored: StoredMoney): StoredMoney {
  if (entered.amount > 0 && toCents(stored.amount) === 0) throw new RoundsToZeroError(entered, stored.currency);
  return stored;
}

/** Whether storing `entered` on an account in `accountCurrency` needs a rate table at all. */
export function needsConversion(enteredCurrency: string, accountCurrency: string): boolean {
  return enteredCurrency !== accountCurrency;
}

/**
 * The share of a shared expense (Transaction.yourShare) as stored beside
 * `stored`: the entered share at the same rate as the amount, never above
 * the amount. On an edit, a share re-entered unchanged (as enteredShare shows
 * it) beside a kept conversion keeps its stored figure.
 */
export function shareInAccountCurrency(
  enteredShareAmount: number | null,
  stored: StoredMoney,
  previous?: { row: MoneyRow & { yourShare: number | null } } | null,
): number | null {
  if (enteredShareAmount === null) return null;
  if (stored.rate === null) return round2(enteredShareAmount);
  const previousRow = previous?.row;
  if (
    previousRow &&
    previousRow.yourShare !== null &&
    previousRow.rate === stored.rate &&
    withinCents(previousRow.amount, stored.amount) &&
    withinCents(enteredShare(previousRow) ?? Number.NaN, enteredShareAmount)
  ) {
    return previousRow.yourShare;
  }
  return Math.min(stored.amount, atRate(enteredShareAmount, stored.rate));
}

/** A stored share as the form shows it: in the entered currency, when the row was converted. */
export function enteredShare(row: MoneyRow & { yourShare: number | null }): number | null {
  if (row.yourShare === null) return null;
  if (row.rate == null || row.rate === 0 || row.originalCurrency == null) return row.yourShare;
  return round2(row.yourShare / row.rate);
}

/**
 * K7 at read: the row in its account's currency. A row stored in that
 * currency is read as stored; one written before K7 in another currency is
 * converted at today's rate, exactly as every reader did before.
 */
export function accountAmount(row: MoneyRow, accountCurrency: string, table: RateTable): number {
  return row.currency === accountCurrency ? row.amount : convert(row.amount, row.currency, accountCurrency, table);
}

/**
 * The row's money in `currency` when the row holds it exactly - its stored
 * amount in that currency, or the original it was converted from - and null
 * when only a conversion at some rate could say.
 */
export function exactAmountIn(row: MoneyRow, currency: string): number | null {
  if (row.currency === currency) return row.amount;
  if (row.originalCurrency === currency && row.originalAmount != null) return row.originalAmount;
  return null;
}

/**
 * Whether two rows are the same money exactly: some currency both hold
 * exactly (stored or original) agrees to within `tolerance`, compared in
 * whole cents (R28). Neither side is
 * converted at a rate here, so a charge in the account's currency only agrees
 * with a foreign row through the figure that row stores in that currency.
 */
export function sameMoneyExactly(a: MoneyRow, b: MoneyRow, tolerance = 0.01): boolean {
  const currencies = new Set([a.currency, b.currency, a.originalCurrency, b.originalCurrency]);
  for (const currency of currencies) {
    if (!currency) continue;
    const left = exactAmountIn(a, currency);
    const right = exactAmountIn(b, currency);
    if (left !== null && right !== null && withinCents(left, right, tolerance)) return true;
  }
  return false;
}

/** Whether the stored figure came from a conversion at a rate (the row was entered in another currency). */
export function wasConverted(row: MoneyRow): boolean {
  return row.originalCurrency != null && row.originalCurrency !== row.currency;
}

/**
 * A transfer's two legs as their accounts store them (K7): each in its own
 * account's currency. The sending leg is the entered amount, converted when
 * it was entered in another currency. The receiving leg is what the bank
 * credited when the user gave it (a cross-currency transfer's "actual amount
 * received"), kept with the entered amount and the rate that implies;
 * otherwise the entered amount converted at `table`'s rate, once. `previous`
 * are the stored legs of the transfer being edited, so re-saving it unchanged
 * converts nothing again.
 */
export function transferLegsInAccounts(
  input: { amount: number; currency: string; receivedAmount: number | null; fromCurrency: string; toCurrency: string },
  table: RateTable,
  previous?: { out?: { row: MoneyRow; accountCurrency: string } | null; in?: { row: MoneyRow; accountCurrency: string } | null },
): { out: StoredMoney; in: StoredMoney } {
  const entered = transferLegs(input);
  const out = toAccountMoney(entered.out, input.fromCurrency, table, previous?.out);
  const declared = input.fromCurrency !== input.toCurrency && input.receivedAmount !== null;
  if (!declared || input.currency === input.toCurrency) {
    return { out, in: toAccountMoney(entered.in, input.toCurrency, table, previous?.in) };
  }
  // What the bank credited, with what was sent and the rate that implies.
  const received = round2(entered.in.amount);
  return {
    out,
    in: {
      amount: received,
      currency: input.toCurrency,
      originalAmount: round2(input.amount),
      originalCurrency: input.currency,
      rate: roundRate(received / input.amount),
    },
  };
}

/**
 * A stored rate as people read one: "1 USD = 61.2 DOP" - always per unit of
 * the dearer currency, so a peso-to-dollar rate reads "1 USD = 61.2 DOP"
 * rather than "1 DOP = 0.0163 USD".
 */
export function rateLine(from: string, to: string, rate: number): string {
  const format = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  return rate >= 1 ? `1 ${from} = ${format(rate)} ${to}` : `1 ${to} = ${format(1 / rate)} ${from}`;
}

// ---------------------------------------------------------------------------
// The backfill (scripts/backfill-account-currency.ts): rows written before K7
// in another currency than their account's, stored in the account's currency
// at one rate table - the rate of the day the backfill runs, since the rate
// of the day each row was entered is not recoverable.
// ---------------------------------------------------------------------------

/** A row as the backfill reads it. */
export interface BackfillRow extends MoneyRow {
  id: string;
  accountId: string;
  type: string;
  transferDirection: string | null;
  yourShare: number | null;
}

/** What the backfill writes on one row. */
export interface BackfillChange {
  id: string;
  accountId: string;
  from: { amount: number; currency: string };
  to: StoredMoney;
  yourShare: { from: number; to: number } | null;
}

/**
 * One account's balance, every row, in its own currency: `before` with each
 * row at what it holds (its figure in the account's currency where it holds
 * one exactly, the rest converted at the backfill's rates), `after` as the
 * planned rows store it - the two agree to the cent - and `appReads` as the
 * app reads it today (accountAmount: every foreign row at today's rate),
 * which differs from them only where a row holding the account's currency
 * exactly had drifted.
 */
export interface BackfillBalance {
  accountId: string;
  currency: string;
  before: number;
  after: number;
  appReads: number;
}

/**
 * Plans the backfill: every row whose currency differs from its account's is
 * stored in the account's currency, keeping what it was entered as and the
 * rate. A row that holds the account's currency exactly (exactAmountIn: it
 * was entered in that currency and converted, as on an account whose
 * currency was changed afterwards - R19) gets that figure back as typed,
 * with no conversion. Any other row is converted at `table` from what it was
 * entered as - its original when it has one, never the converted figure
 * converted again. The converted amounts are the exact conversion rounded
 * down or up to the cent - chosen per account, largest remainder first, so
 * that the account's balance reads the same to the cent before and after (a
 * row-by-row rounding could move it by a few cents). A share (yourShare) is
 * carried at the same rate from the share as entered, never above its
 * amount. Rows already in their account's currency are untouched, so
 * planning again after the backfill changes nothing.
 */
export function planBackfill(
  accounts: readonly { id: string; currency: string }[],
  rows: readonly BackfillRow[],
  table: RateTable,
): { changes: BackfillChange[]; balances: BackfillBalance[] } {
  const changes: BackfillChange[] = [];
  const balances: BackfillBalance[] = [];
  for (const account of accounts) {
    const own = rows.filter((row) => row.accountId === account.id);
    const foreign = own.filter((row) => row.currency !== account.currency).sort((a, b) => a.id.localeCompare(b.id));
    if (foreign.length === 0) continue;
    const signOf = (row: BackfillRow) => balanceSign(row.type, row.transferDirection);
    const appReads = round2(own.reduce((total, row) => total + signOf(row) * accountAmount(row, account.currency, table), 0));
    // Rows holding the account's currency exactly take that figure back; the
    // rest are converted from what they were entered as.
    const exactRows = foreign.filter((row) => exactAmountIn(row, account.currency) !== null);
    const converted = foreign.filter((row) => exactAmountIn(row, account.currency) === null);
    const fixedCents =
      own
        .filter((row) => row.currency === account.currency)
        .reduce((total, row) => total + Math.round(signOf(row) * row.amount * 100), 0) +
      exactRows.reduce((total, row) => total + signOf(row) * toCents(exactAmountIn(row, account.currency) as number), 0);
    const exact = converted.map((row) => {
      const entered = enteredMoney(row);
      return signOf(row) * convert(entered.amount, entered.currency, account.currency, table);
    });
    const before = round2(fixedCents / 100 + exact.reduce((total, value) => total + value, 0));
    // The cents the converted rows must add up to for the balance to stay put.
    const targetCents = Math.round(before * 100) - fixedCents;
    // A stored amount is never 0: a conversion under half a cent keeps one.
    const cents = exact.map((value, index) => Math.round(value * 100) || signOf(converted[index]));
    let gap = targetCents - cents.reduce((total, value) => total + value, 0);
    const residual = exact.map((value, index) => value * 100 - cents[index]);
    const order = exact.map((_, index) => index);
    // Round up where the exact value was rounded down the most (or down where
    // it was rounded up the most), one cent each, until the gap is closed.
    order.sort((a, b) => (gap > 0 ? residual[b] - residual[a] : residual[a] - residual[b]) || converted[a].id.localeCompare(converted[b].id));
    for (const index of order) {
      if (gap === 0) break;
      const step = gap > 0 ? 1 : -1;
      if (cents[index] + step === 0) continue;
      cents[index] += step;
      gap -= step;
    }
    let afterCents = fixedCents;
    const shareFrom = (row: BackfillRow) => (row.yourShare === null ? null : enteredShare({ ...row, yourShare: row.yourShare }));
    for (const row of exactRows) {
      const amount = exactAmountIn(row, account.currency) as number;
      const share = shareFrom(row);
      changes.push({
        id: row.id,
        accountId: account.id,
        from: { amount: row.amount, currency: row.currency },
        to: { amount, currency: account.currency, originalAmount: null, originalCurrency: null, rate: null },
        yourShare: row.yourShare === null || share === null ? null : { from: row.yourShare, to: Math.min(amount, share) },
      });
    }
    converted.forEach((row, index) => {
      const sign = signOf(row);
      const amount = sign === 0 ? round2(Math.abs(exact[index])) : Math.abs(cents[index]) / 100;
      afterCents += sign * Math.round(amount * 100);
      const entered = enteredMoney(row);
      const rate = rateBetween(entered.currency, account.currency, table);
      const share = shareFrom(row);
      changes.push({
        id: row.id,
        accountId: account.id,
        from: { amount: row.amount, currency: row.currency },
        to: {
          amount,
          currency: account.currency,
          originalAmount: round2(entered.amount),
          originalCurrency: entered.currency,
          rate,
        },
        yourShare:
          row.yourShare === null || share === null
            ? null
            : { from: row.yourShare, to: Math.min(amount, round2(share * convert(1, entered.currency, account.currency, table))) },
      });
    });
    balances.push({ accountId: account.id, currency: account.currency, before, after: afterCents / 100, appReads });
  }
  return { changes, balances };
}
