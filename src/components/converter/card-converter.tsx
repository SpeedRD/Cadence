"use client";

import { useState } from "react";

import { Field } from "@/components/form/field";
import { EnumSelect } from "@/components/form/selects";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BPD_RATE_MAX_AGE_DAYS } from "@/lib/bpd-rate-payload";
import {
  CARD_ACCOUNT_CURRENCY,
  CARD_CURRENCIES,
  MIN_LEARNED_CHARGES,
  cardRate,
  estimateFromForeign,
  estimateFromPesos,
  isCardCurrency,
  type CardCurrency,
  type CardEstimate,
} from "@/lib/card-rate";
import { formatMoney, formatRate } from "@/lib/currency";
import { daysBetween, fromISODate } from "@/lib/date";
import { formatDate } from "@/lib/date-format";
import { getDictionary, type Locale } from "@/lib/i18n";
import { parseAmountInput } from "@/lib/money";

import type { ConverterData, ConverterPublication } from "@/lib/data/card-rate";

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

/** The field a figure was typed in; the other one follows it. */
type Source = "foreign" | "pesos";

/** The currency the user has most charges in, so the page opens on the one they use. */
function defaultCurrency(data: ConverterData): CardCurrency {
  return CARD_CURRENCIES.reduce((best, currency) =>
    data.learned[currency].count > data.learned[best].count ? currency : best,
  );
}

function dayLabel(day: string, locale: Locale): string {
  const date = fromISODate(day);
  return date ? formatDate(date, locale) : day;
}

/**
 * Two linked amount fields, one per currency, and what the card will likely
 * charge for them. Typing in either fills the other at the card's learned
 * rate (or the bank's published sell rate when nothing is learned yet). The
 * amounts parse exactly as the transaction dialog's do (parseAmountInput).
 */
export function CardConverter({ data, locale }: { data: ConverterData; locale: Locale }) {
  const t = getDictionary(locale).converter;
  const rates = data.rates as ConverterPublication;
  const [currency, setCurrency] = useState<CardCurrency>(() => defaultCurrency(data));
  const [source, setSource] = useState<Source>("foreign");
  const [text, setText] = useState("");

  const learned = data.learned[currency];
  const sell = rates.sell[currency];
  const buy = rates.buy[currency];
  const parsed = parseAmountInput(text);
  const amount = parsed.ok && parsed.amount > 0 ? parsed.amount : null;
  const estimate: CardEstimate | null =
    amount === null
      ? null
      : source === "foreign"
        ? estimateFromForeign(amount, currency, sell, learned)
        : estimateFromPesos(amount, currency, sell, learned);
  const followed = (field: Source) =>
    source === field ? text : estimate ? (field === "foreign" ? estimate.foreign : estimate.charge).toFixed(2) : "";
  const type = (field: Source) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setSource(field);
    setText(event.target.value);
  };

  const latest = data.newer ?? rates;
  const today = fromISODate(data.today);
  const latestDay = fromISODate(latest.day);
  const staleDays = today && latestDay ? daysBetween(latestDay, today) : 0;
  const rateText = (rate: number) => t.perUnit(formatRate(rate, { minimumFractionDigits: 2 }), currency);

  return (
    <div className="space-y-5">
      {data.stale ? (
        <Alert className="border-[var(--warning)]/40">
          <AlertTitle>{t.staleTitle}</AlertTitle>
          <AlertDescription>
            <p>{t.staleDescription(dayLabel(latest.day, locale), staleDays, BPD_RATE_MAX_AGE_DAYS)}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.calculatorHeading}</CardTitle>
            <CardDescription>{t.amountHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label={t.currency} htmlFor="converter-currency">
              <EnumSelect
                id="converter-currency"
                name="currency"
                options={CARD_CURRENCIES}
                labels={{ USD: "USD", EUR: "EUR" }}
                value={currency}
                onValueChange={(next) => {
                  if (isCardCurrency(next)) setCurrency(next);
                }}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.amountIn(currency)} htmlFor="converter-foreign">
                <Input
                  id="converter-foreign"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="font-mono"
                  autoComplete="off"
                  value={followed("foreign")}
                  onChange={type("foreign")}
                  aria-invalid={source === "foreign" && text !== "" && !parsed.ok ? true : undefined}
                />
              </Field>
              <Field label={t.amountIn(CARD_ACCOUNT_CURRENCY)} htmlFor="converter-pesos">
                <Input
                  id="converter-pesos"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="font-mono"
                  autoComplete="off"
                  value={followed("pesos")}
                  onChange={type("pesos")}
                  aria-invalid={source === "pesos" && text !== "" && !parsed.ok ? true : undefined}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card aria-live="polite" data-converter-result>
          <CardHeader>
            <p className="eyebrow">{learned.learned ? t.likelyCharge : t.publishedRateLabel}</p>
          </CardHeader>
          <CardContent className="grid gap-2">
            {estimate ? (
              <p className="figure figure-lg text-3xl" data-converter-charge>
                {formatMoney(estimate.charge, CARD_ACCOUNT_CURRENCY)}
              </p>
            ) : (
              <p className="text-muted-foreground">{t.enterAmount}</p>
            )}
            {learned.learned ? (
              <>
                {estimate && estimate.low !== null && estimate.high !== null ? (
                  <p className="text-sm" data-converter-range>
                    {t.likelyRange(
                      formatMoney(estimate.low, CARD_ACCOUNT_CURRENCY),
                      formatMoney(estimate.high, CARD_ACCOUNT_CURRENCY),
                    )}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {t.cardRate(formatRate(cardRate(sell, learned.gap), { minimumFractionDigits: 2 }), currency)}
                </p>
                <p className="text-xs text-muted-foreground" data-converter-learned>
                  {t.learnedFrom(learned.count, percent.format(learned.min), percent.format(learned.max))}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{rateText(sell)}</p>
                <p className="text-xs text-muted-foreground" data-converter-learned>
                  {t.notEnoughCharges(learned.count, MIN_LEARNED_CHARGES)}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-converter-reference>
        <CardHeader>
          <CardTitle>{t.referenceHeading}</CardTitle>
          <CardDescription>
            {(data.stale ? t.lastPublishedOn : t.publishedOn)(dayLabel(rates.day, locale))}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="eyebrow">{t.sell}</dt>
              <dd className="figure text-xl">{rateText(sell)}</dd>
              <dd className="text-xs text-muted-foreground">{t.sellHint}</dd>
            </div>
            <div className="space-y-1">
              <dt className="eyebrow">{t.buy}</dt>
              <dd className={buy === null ? "text-xl text-muted-foreground" : "figure text-xl"}>
                {buy === null ? t.notPublished : rateText(buy)}
              </dd>
              <dd className="text-xs text-muted-foreground">{t.buyHint}</dd>
            </div>
          </dl>
          {data.newer ? (
            <p className="text-xs text-muted-foreground">{t.newerPublication(dayLabel(data.newer.day, locale))}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
