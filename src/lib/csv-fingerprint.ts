import { createHash } from "node:crypto";

/**
 * How a CSV row is recognised when the same statement is imported twice.
 * The fingerprint is deterministic over the fields a bank export carries -
 * account, date, amount, currency and description - so a later import of
 * overlapping rows can find the rows already in the ledger, whether they
 * were stored with a fingerprint (rows imported after this existed) or
 * predate it (their fingerprint is recomputed from the same fields).
 *
 * Stored on Transaction.externalId under source CSV, the same
 * (source, externalId) pairing recurring posting and goal contributions use.
 * Two genuinely identical rows are allowed to coexist: the second one stored
 * carries an ordinal ("<fingerprint>#2"), which keeps the unique index happy
 * while fingerprintFromCsvExternalId still maps it back to the same key.
 */

export function normalizeCsvNote(note: string | null | undefined): string {
  return (note ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function csvFingerprint(row: {
  accountId: string;
  /** "YYYY-MM-DD" */
  date: string;
  amount: number;
  currency: string;
  note: string | null | undefined;
}): string {
  const material = [
    row.accountId,
    row.date,
    row.amount.toFixed(2),
    row.currency.toUpperCase(),
    normalizeCsvNote(row.note),
  ].join("");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

const ORDINAL_SEPARATOR = "#";

/** The externalId for the `ordinal`-th row (1-based) carrying this fingerprint. */
export function csvExternalId(fingerprint: string, ordinal: number): string {
  return ordinal <= 1 ? fingerprint : `${fingerprint}${ORDINAL_SEPARATOR}${ordinal}`;
}

/** The fingerprint a stored CSV externalId carries, or null for rows without one. */
export function fingerprintFromCsvExternalId(externalId: string | null | undefined): string | null {
  if (!externalId) return null;
  const separator = externalId.indexOf(ORDINAL_SEPARATOR);
  return separator === -1 ? externalId : externalId.slice(0, separator);
}
