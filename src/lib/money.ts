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

/**
 * Parse a money amount the way people actually type it on a phone or paste it
 * from a statement, without ever guessing at a hundredfold difference:
 *
 *   "12.50" / "12,50" / "12,5"  -> 12.5   (either separator is a decimal point)
 *   "1,250" / "1,250.00"        -> 1250   (a comma followed by exactly three
 *                                          digits is a thousands separator,
 *                                          matching how Cadence formats money)
 *   "1.250,50" / "1,234.56"     -> both separators present: the last one is the
 *                                  decimal point, the other groups thousands
 *   "1 250,50"                  -> spaces are ignored
 *   "12.345" / "1.250"          -> rejected: more than two decimals is either a
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
    if (groups[0] === "" || groups.slice(1).some((group) => group.length !== 3)) {
      return { ok: false, reason: "invalid" };
    }
    integerPart = groups.join("");
    fractionPart = pieces[1];
  } else if (lastComma !== -1 || lastDot !== -1) {
    const separator = lastComma !== -1 ? "," : ".";
    const pieces = text.split(separator);
    if (pieces.length === 2) {
      const [whole, rest] = pieces;
      if (separator === "," && whole !== "" && rest.length === 3) {
        integerPart = whole + rest;
        fractionPart = "";
      } else {
        integerPart = whole;
        fractionPart = rest;
      }
    } else {
      if (pieces[0] === "" || pieces.slice(1).some((group) => group.length !== 3)) {
        return { ok: false, reason: "invalid" };
      }
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
