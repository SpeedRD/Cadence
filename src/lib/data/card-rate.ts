import { isWithinFreshnessWindow } from "@/lib/bpd-rate-payload";
import {
  CARD_ACCOUNT_CURRENCY,
  CARD_CURRENCIES,
  cardDataPoints,
  learnedGap,
  publicationInForce,
  type CardCharge,
  type CardCurrency,
  type LearnedGap,
  type RatePublication,
} from "@/lib/card-rate";
import { appTimeZone, civilDateInZone, toISODate } from "@/lib/date";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

/** A publication as the converter page shows it: its civil day and its rates. */
export interface ConverterPublication {
  /** "YYYY-MM-DD", the day it was published in the app's timezone. */
  day: string;
  sell: Record<CardCurrency, number>;
  buy: Record<CardCurrency, number | null>;
}

export interface ConverterData {
  /** "YYYY-MM-DD", today in the app's timezone. */
  today: string;
  /**
   * The publication a charge made today is converted at (publicationInForce
   * for today), or the latest when none was published before today. Null
   * with no publication at all.
   */
  rates: ConverterPublication | null;
  /** The latest publication when it is newer than `rates`: published today, in force from tomorrow. */
  newer: ConverterPublication | null;
  /** The latest publication is outside the freshness window (BPD_RATE_MAX_AGE_DAYS). */
  stale: boolean;
  learned: Record<CardCurrency, LearnedGap>;
}

function forPage(publication: RatePublication, timeZone: string): ConverterPublication {
  return {
    day: toISODate(civilDateInZone(publication.asOf, timeZone)),
    sell: { USD: publication.dollarSellRate, EUR: publication.euroSellRate },
    buy: { USD: publication.dollarBuyRate, EUR: publication.euroBuyRate },
  };
}

/**
 * Everything the converter page shows, read only: the bank's publications and
 * the user's card charges (src/lib/card-rate.ts decides which are data points).
 */
export async function loadConverter(now: Date = new Date()): Promise<ConverterData> {
  const timeZone = appTimeZone();
  const [publicationRows, chargeRows] = await Promise.all([
    prisma.bpdRatePublication.findMany({ orderBy: { asOf: "asc" } }),
    prisma.transaction.findMany({
      where: {
        type: "EXPENSE",
        isBankFigure: true,
        originalCurrency: { in: [...CARD_CURRENCIES] },
        account: { currency: CARD_ACCOUNT_CURRENCY },
      },
      select: {
        id: true,
        date: true,
        createdAt: true,
        type: true,
        isBankFigure: true,
        amount: true,
        currency: true,
        originalAmount: true,
        originalCurrency: true,
        account: { select: { currency: true } },
      },
    }),
  ]);

  const publications: RatePublication[] = publicationRows.map((row) => ({
    asOf: row.asOf,
    dollarSellRate: num(row.dollarSellRate),
    euroSellRate: num(row.euroSellRate),
    dollarBuyRate: row.dollarBuyRate === null ? null : num(row.dollarBuyRate),
    euroBuyRate: row.euroBuyRate === null ? null : num(row.euroBuyRate),
  }));
  const charges: CardCharge[] = chargeRows.map((row) => ({
    id: row.id,
    date: row.date,
    createdAt: row.createdAt,
    type: row.type,
    isBankFigure: row.isBankFigure,
    amount: num(row.amount),
    currency: row.currency,
    accountCurrency: row.account.currency,
    originalAmount: row.originalAmount === null ? null : num(row.originalAmount),
    originalCurrency: row.originalCurrency,
  }));

  const today = civilDateInZone(now, timeZone);
  const latest = publications.at(-1) ?? null;
  const inForce = publicationInForce(publications, today, timeZone) ?? latest;
  return {
    today: toISODate(today),
    rates: inForce ? forPage(inForce, timeZone) : null,
    newer: latest && inForce && latest !== inForce ? forPage(latest, timeZone) : null,
    stale: latest ? !isWithinFreshnessWindow(latest.asOf, now, timeZone) : false,
    learned: {
      USD: learnedGap(cardDataPoints(charges, publications, "USD", timeZone)),
      EUR: learnedGap(cardDataPoints(charges, publications, "EUR", timeZone)),
    },
  };
}
