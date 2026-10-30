/**
 * What the user's card really charges in pesos for an amount in another
 * currency. It starts from Banco Popular's published sell rate
 * (BpdRatePublication) and learns, from the user's own charges, how far the
 * card's real figures sit from it: a charge whose stored pesos are the bank's
 * own figure (Transaction.isBankFigure) is a data point, its gap the rate it
 * implies over the published sell rate in force for it, less one.
 *
 * Pure and database-free, so scripts/verify-domain.ts can check it directly
 * and the converter page can recompute an estimate as the user types; the
 * loader is src/lib/data/card-rate.ts.
 */
import { atRateFor, roundRate } from "@/lib/account-money";
import { appTimeZone, civilDateInZone } from "@/lib/date";

/** The foreign currencies Banco Popular publishes a rate for. */
export const CARD_CURRENCIES = ["USD", "EUR"] as const;
export type CardCurrency = (typeof CARD_CURRENCIES)[number];

/** The currency the bank's rates and the card's charges are in. */
export const CARD_ACCOUNT_CURRENCY = "DOP";

/** How many of the most recent data points the learned gap is taken over. */
export const LEARNED_GAP_WINDOW = 12;
/** Fewer data points than this and nothing is learned. */
export const MIN_LEARNED_CHARGES = 3;

export function isCardCurrency(value: string): value is CardCurrency {
  return (CARD_CURRENCIES as readonly string[]).includes(value);
}

/** One Banco Popular publication, as BpdRatePublication holds it, in pesos per unit. */
export interface RatePublication {
  asOf: Date;
  dollarSellRate: number;
  euroSellRate: number;
  dollarBuyRate: number | null;
  euroBuyRate: number | null;
}

/** What the bank charges you per unit of `currency`. */
export function publishedSell(publication: RatePublication, currency: CardCurrency): number {
  return currency === "USD" ? publication.dollarSellRate : publication.euroSellRate;
}

/** What the bank pays you per unit of `currency`, when it published one. */
export function publishedBuy(publication: RatePublication, currency: CardCurrency): number | null {
  return currency === "USD" ? publication.dollarBuyRate : publication.euroBuyRate;
}

/**
 * The publication in force for a charge on civil day `day` (UTC midnight):
 * the latest one published before that day began in `timeZone`. A
 * publication of the same day is not in force for it yet. Null when nothing
 * was published before it.
 */
export function publicationInForce(
  publications: readonly RatePublication[],
  day: Date,
  timeZone: string = appTimeZone(),
): RatePublication | null {
  let inForce: RatePublication | null = null;
  for (const publication of publications) {
    if (civilDateInZone(publication.asOf, timeZone).getTime() >= day.getTime()) continue;
    if (!inForce || publication.asOf.getTime() > inForce.asOf.getTime()) inForce = publication;
  }
  return inForce;
}

/** A transaction's fields the card's data points are read from. */
export interface CardCharge {
  id: string;
  /** The charge's civil day (UTC midnight). */
  date: Date;
  createdAt: Date;
  type: string;
  isBankFigure: boolean;
  amount: number;
  currency: string;
  accountCurrency: string;
  originalAmount: number | null;
  originalCurrency: string | null;
}

export interface CardDataPoint {
  id: string;
  date: Date;
  currency: CardCurrency;
  /** Pesos the card charged. */
  amount: number;
  /** What was charged in `currency`. */
  originalAmount: number;
  /** The published sell rate in force for the charge. */
  publishedSell: number;
  /** amount / originalAmount over publishedSell, less one: -0.005 is half a percent below it. */
  gap: number;
}

/**
 * Whether `charge` can teach the card's rate for `currency`: an EXPENSE whose
 * pesos are the bank's own figure, charged in `currency`, on a peso account.
 */
export function isCardCharge(charge: CardCharge, currency: CardCurrency): boolean {
  return (
    charge.type === "EXPENSE" &&
    charge.isBankFigure &&
    charge.originalCurrency === currency &&
    charge.accountCurrency === CARD_ACCOUNT_CURRENCY &&
    charge.currency === CARD_ACCOUNT_CURRENCY &&
    charge.originalAmount !== null &&
    charge.originalAmount > 0 &&
    charge.amount > 0
  );
}

/**
 * The data points for `currency`, most recent first (by charge day, then by
 * when the row was written). A card charge with no publication in force for
 * its day is not one.
 */
export function cardDataPoints(
  charges: readonly CardCharge[],
  publications: readonly RatePublication[],
  currency: CardCurrency,
  timeZone: string = appTimeZone(),
): CardDataPoint[] {
  const found: { point: CardDataPoint; createdAt: Date }[] = [];
  for (const charge of charges) {
    if (!isCardCharge(charge, currency)) continue;
    const inForce = publicationInForce(publications, charge.date, timeZone);
    if (!inForce) continue;
    const originalAmount = charge.originalAmount as number;
    const sell = publishedSell(inForce, currency);
    found.push({
      createdAt: charge.createdAt,
      point: {
        id: charge.id,
        date: charge.date,
        currency,
        amount: charge.amount,
        originalAmount,
        publishedSell: sell,
        gap: charge.amount / originalAmount / sell - 1,
      },
    });
  }
  found.sort(
    (a, b) => b.point.date.getTime() - a.point.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return found.map(({ point }) => point);
}

export type LearnedGap =
  | {
      learned: true;
      /** The median gap of the `count` most recent data points. */
      gap: number;
      min: number;
      max: number;
      /** Data points the gap is taken over: at most LEARNED_GAP_WINDOW. */
      count: number;
    }
  | {
      learned: false;
      /** Data points there are, fewer than MIN_LEARNED_CHARGES. */
      count: number;
    };

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The card's gap for one currency, from its data points most recent first
 * (cardDataPoints): the median of the LEARNED_GAP_WINDOW most recent, with
 * their count, min and max. Nothing is learned from fewer than
 * MIN_LEARNED_CHARGES.
 */
export function learnedGap(points: readonly CardDataPoint[]): LearnedGap {
  if (points.length < MIN_LEARNED_CHARGES) return { learned: false, count: points.length };
  const gaps = points
    .slice(0, LEARNED_GAP_WINDOW)
    .map((point) => point.gap)
    .sort((a, b) => a - b);
  return { learned: true, gap: median(gaps), min: gaps[0], max: gaps[gaps.length - 1], count: gaps.length };
}

/** Pesos per unit the card charges at `gap` over `sell`, at Transaction.rate's scale. */
export function cardRate(sell: number, gap: number): number {
  return roundRate(sell * (1 + gap));
}

export interface CardEstimate {
  /** The amount in `currency`. */
  foreign: number;
  /** Pesos the card will likely charge for it. */
  charge: number;
  /** The pesos at the smallest and largest gap seen; null with nothing learned. */
  low: number | null;
  high: number | null;
}

/**
 * The card's likely charge for `foreign` units of `currency`: the published
 * sell rate times one plus the learned gap, with the range its min and max
 * gaps give - or, with nothing learned, the published sell rate alone.
 * Rounded to the cent as account-money.ts rounds a conversion.
 */
export function estimateFromForeign(
  foreign: number,
  currency: CardCurrency,
  sell: number,
  learned: LearnedGap,
): CardEstimate {
  const pesosAt = (rate: number) => atRateFor(foreign, currency, CARD_ACCOUNT_CURRENCY, rate);
  if (!learned.learned) return { foreign, charge: pesosAt(sell), low: null, high: null };
  return {
    foreign,
    charge: pesosAt(cardRate(sell, learned.gap)),
    low: pesosAt(cardRate(sell, learned.min)),
    high: pesosAt(cardRate(sell, learned.max)),
  };
}

/**
 * The reverse: how much of `currency` a charge of `pesos` stands for, at the
 * same rate. The charge is `pesos` as given; the range is what that amount of
 * `currency` comes to at the min and max gaps.
 */
export function estimateFromPesos(
  pesos: number,
  currency: CardCurrency,
  sell: number,
  learned: LearnedGap,
): CardEstimate {
  const rate = learned.learned ? cardRate(sell, learned.gap) : sell;
  const foreign = atRateFor(pesos, CARD_ACCOUNT_CURRENCY, currency, 1 / rate);
  if (!learned.learned) return { foreign, charge: pesos, low: null, high: null };
  const exactForeign = pesos / rate;
  const pesosAt = (gap: number) => atRateFor(exactForeign, currency, CARD_ACCOUNT_CURRENCY, cardRate(sell, gap));
  return { foreign, charge: pesos, low: pesosAt(learned.min), high: pesosAt(learned.max) };
}
