/** Prisma returns Decimal instances; every read path funnels through here. */
export type DecimalLike = { toString(): string } | number | string | null | undefined;

export function num(value: DecimalLike): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Money as whole cents. Comparing money for equality or within a tolerance
 * goes through cents, never through a float difference: 0.04 - 0.03 is
 * 0.010000000000000002, which is not within a cent (R28).
 */
export function toCents(value: number): number {
  return Math.round((value + Math.sign(value) * Number.EPSILON) * 100);
}

/**
 * A money tolerance as whole cents: 0.01 is one cent, 0.03 three, and a
 * half-cent tolerance (0.005) none - amounts within half a cent are the same
 * cent once rounded.
 */
function toleranceInCents(tolerance: number): number {
  return Math.floor(tolerance * 100 + 1e-9);
}

/** Whether `a` and `b` are within `tolerance` (a money amount, e.g. 0.01) of each other, compared in whole cents. */
export function withinCents(a: number, b: number, tolerance = 0): boolean {
  return Math.abs(toCents(a) - toCents(b)) <= toleranceInCents(tolerance);
}

/** Whether `a` is above `b` by more than `tolerance` (a money amount), compared in whole cents. */
export function exceedsCents(a: number, b: number, tolerance = 0): boolean {
  return toCents(a) - toCents(b) > toleranceInCents(tolerance);
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Share of `part` in `whole` as a 0-1 ratio, guarding division by zero. */
export function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return part / whole;
}

/** Largest value a Decimal(14,2) column can hold. */
export const AMOUNT_MAX = 999_999_999_999.99;

export type ParsedAmount =
  | { ok: true; amount: number }
  | { ok: false; reason: "empty" | "invalid" | "too_many_decimals" | "too_large" };

/** The first digits before a thousands separator: 1-3 digits, no leading zero ("0,125" is not 125). */
function isLeadingGroup(group: string): boolean {
  return /^[1-9]\d{0,2}$/.test(group);
}

/** Digits split on a thousands separator: a valid leading group, then groups of exactly three. */
function isGroupedInteger(groups: string[]): boolean {
  return isLeadingGroup(groups[0]) && groups.slice(1).every((group) => /^\d{3}$/.test(group));
}

/**
 * Parse a money amount the way people actually type it on a phone or paste it
 * from a statement, without ever guessing at a hundredfold difference:
 *
 *   "12.50" / "12,50" / "12,5"  -> 12.5   (either separator is a decimal point)
 *   "1,250" / "1,250.00"        -> 1250   (a comma followed by exactly three
 *                                          digits is a thousands separator when
 *                                          the digits before it are a valid
 *                                          leading group of 1-3 digits, not a
 *                                          lone 0, matching how Cadence
 *                                          formats money)
 *   "1.250,50" / "1,234.56"     -> both separators present: the last one is the
 *                                  decimal point, the other groups thousands
 *   "1 250,50"                  -> spaces are ignored
 *   "0,125" / "12.345" / "1.250" -> rejected: more than two decimals is either a
 *                                  typo or a thousands separator in a locale
 *                                  Cadence does not display in, so ask rather
 *                                  than pick
 *
 * The result is built from whole cents, so "0.07" never comes back as
 * 0.07000000000000001 and nothing is rounded behind the user's back.
 */
export function parseAmountInput(raw: string): ParsedAmount {
  let text = raw.replace(/\s+/g, "");
  if (text === "") return { ok: false, reason: "empty" };

  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (!/^[\d.,]+$/.test(text)) return { ok: false, reason: "invalid" };

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let integerPart: string;
  let fractionPart: string;

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const groupSeparator = decimalSeparator === "," ? "." : ",";
    const pieces = text.split(decimalSeparator);
    if (pieces.length !== 2) return { ok: false, reason: "invalid" };
    const groups = pieces[0].split(groupSeparator);
    if (!isGroupedInteger(groups)) return { ok: false, reason: "invalid" };
    integerPart = groups.join("");
    fractionPart = pieces[1];
  } else if (lastComma !== -1 || lastDot !== -1) {
    const separator = lastComma !== -1 ? "," : ".";
    const pieces = text.split(separator);
    if (pieces.length === 2) {
      const [whole, rest] = pieces;
      if (separator === "," && rest.length === 3 && isLeadingGroup(whole)) {
        integerPart = whole + rest;
        fractionPart = "";
      } else {
        integerPart = whole;
        fractionPart = rest;
      }
    } else {
      if (!isGroupedInteger(pieces)) return { ok: false, reason: "invalid" };
      integerPart = pieces.join("");
      fractionPart = "";
    }
  } else {
    integerPart = text;
    fractionPart = "";
  }

  if (integerPart === "" && fractionPart === "") return { ok: false, reason: "invalid" };
  if (fractionPart.length > 2) return { ok: false, reason: "too_many_decimals" };
  if (integerPart.length > 12) return { ok: false, reason: "too_large" };

  const cents =
    Number(integerPart || "0") * 100 + Number((fractionPart + "00").slice(0, 2));
  if (cents > AMOUNT_MAX * 100) return { ok: false, reason: "too_large" };
  const amount = cents / 100;
  return { ok: true, amount: negative ? -amount : amount };
}
