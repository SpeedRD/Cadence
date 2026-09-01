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
