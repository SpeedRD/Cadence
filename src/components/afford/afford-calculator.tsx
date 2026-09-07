"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AffordResults } from "@/components/afford/afford-results";
import { Field } from "@/components/form/field";
import { AccountSelect, CurrencySelect, EnumSelect, type Option } from "@/components/form/selects";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  MAX_INSTALLMENTS,
  buildInstallments,
  equalInstallmentAmount,
  installmentDates,
  type AffordVerdict,
} from "@/lib/afford";
import { formatMoney } from "@/lib/currency";
import { formatDate, fromISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { RECURRING_FREQUENCIES } from "@/lib/labels";
import { round2 } from "@/lib/money";
import { periodForDate } from "@/lib/period";
import { confirmAffordAction, evaluateAffordAction } from "@/server/actions/afford";
import { cn } from "@/lib/utils";

import type { AffordRecordedPlan } from "@/lib/data/afford";

interface Evaluated {
  /** The inputs this verdict was computed from, so an edit since is detected. */
  signature: string;
  verdict: AffordVerdict;
  recorded: AffordRecordedPlan;
}

function parseCount(text: string): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_INSTALLMENTS, Math.max(0, value));
}

export function AffordCalculator({
  accounts,
  defaultCurrency,
  today,
  historyPeriods,
  locale,
}: {
  accounts: Option[];
  defaultCurrency: string;
  /** "YYYY-MM-DD" in the app's timezone - the default first payment date. */
  today: string;
  historyPeriods: number;
  locale: Locale;
}) {
  const t = getDictionary(locale).afford;
  const common = getDictionary(locale).common;

  const [name, setName] = useState("");
  const [total, setTotal] = useState(0);
  const [currency, setCurrency] = useState(defaultCurrency);
  const [countText, setCountText] = useState("3");
  const [frequency, setFrequency] = useState("MONTHLY");
  const [firstDate, setFirstDate] = useState(today);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [evaluated, setEvaluated] = useState<Evaluated | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordedName, setRecordedName] = useState<string | null>(null);
  const [evaluating, startEvaluating] = useTransition();
  const [confirming, startConfirming] = useTransition();

  const count = parseCount(countText);
  // The same function the server runs on the same two inputs, so the rows
  // shown here are the amount that gets checked and, on confirm, recorded.
  const amount = equalInstallmentAmount(total, count);
  const firstDateParsed = fromISODate(firstDate);
  const dates = firstDateParsed
    ? installmentDates(firstDateParsed, frequency as (typeof RECURRING_FREQUENCIES)[number], count)
    : [];
  const installments = amount > 0 ? buildInstallments(dates, amount) : [];
  const installmentsTotal = round2(amount * count);
  const roundingDifference = round2(installmentsTotal - total);
  const account = accounts.find((option) => option.id === accountId) ?? null;

  const payload = {
    name: name.trim(),
    currency,
    frequency,
    firstDate,
    accountId,
    totalAmount: total,
    installments: count,
  };
  const signature = JSON.stringify(payload);
  const stale = evaluated !== null && evaluated.signature !== signature;

  function resetAll() {
    setName("");
    setTotal(0);
    setCountText("3");
    setFrequency("MONTHLY");
    setFirstDate(today);
    setEvaluated(null);
    setAcknowledged(false);
    setError(null);
  }

  function evaluate() {
    setError(null);
    setRecordedName(null);
    setAcknowledged(false);
    startEvaluating(async () => {
      const result = await evaluateAffordAction({ ...payload, acknowledged: false });
      if (!result.ok) {
        setEvaluated(null);
        setError(result.error);
        return;
      }
      setEvaluated({ signature, verdict: result.verdict, recorded: result.recorded });
    });
  }

  function confirm() {
    if (!evaluated || stale) return;
    setError(null);
    startConfirming(async () => {
      const result = await confirmAffordAction({ ...payload, acknowledged });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(result.message);
      const boughtName = payload.name;
      resetAll();
      setRecordedName(boughtName);
    });
  }

  const canEvaluate =
    payload.name.length > 0 && count > 0 && firstDateParsed !== null && accountId !== "" && amount > 0;

  return (
    <div className="space-y-5">
      {recordedName ? (
        <Alert className="border-[var(--good)]/40">
          <AlertTitle>{t.recordedTitle(recordedName)}</AlertTitle>
          <AlertDescription>
            <p>{t.recordedDescription}</p>
            <Link href="/recurring" className="underline underline-offset-3 hover:text-foreground">
              {t.viewRecurring}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t.purchaseHeading}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label={t.purchaseName} htmlFor="afford-name">
              <Input
                id="afford-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t.purchaseNamePlaceholder}
                maxLength={80}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
              <Field label={t.totalAmount} htmlFor="afford-total">
                <PaydayAmountInput
                  id="afford-total"
                  value={total}
                  onChange={(value) => setTotal(Math.max(0, value))}
                />
              </Field>
              <Field label={common.currency} htmlFor="afford-currency">
                <CurrencySelect
                  id="afford-currency"
                  name="currency"
                  defaultValue={currency}
                  onValueChange={setCurrency}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.installments} htmlFor="afford-count" hint={t.installmentsHint}>
                <Input
                  id="afford-count"
                  inputMode="numeric"
                  className="font-mono"
                  value={countText}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw !== "" && !/^\d{1,3}$/.test(raw)) return;
                    setCountText(raw);
                  }}
                />
              </Field>
              <Field label={t.frequency} htmlFor="afford-frequency">
                <EnumSelect
                  id="afford-frequency"
                  name="frequency"
                  options={RECURRING_FREQUENCIES}
                  labels={common.frequencyLabels}
                  defaultValue={frequency}
                  onValueChange={setFrequency}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.firstPayment} htmlFor="afford-first" hint={t.firstPaymentHint}>
                <Input
                  id="afford-first"
                  type="date"
                  value={firstDate}
                  onChange={(event) => setFirstDate(event.target.value)}
                />
              </Field>
              <Field label={t.account} htmlFor="afford-account" hint={t.accountHint}>
                <AccountSelect
                  id="afford-account"
                  name="accountId"
                  accounts={accounts}
                  defaultValue={accountId || undefined}
                  common={common}
                  onValueChange={setAccountId}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.scheduleHeading}</CardTitle>
            <CardDescription>{t.scheduleDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {installments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noScheduleYet}</p>
            ) : (
              <ul className="divide-y divide-border/70">
                {installments.map((installment) => {
                  const period = periodForDate(installment.date);
                  return (
                    <li
                      key={installment.index}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">{t.paymentLabel(installment.index)}</p>
                        <p className="text-[0.6875rem] text-muted-foreground">
                          {formatDate(installment.date)} · {period.label}
                        </p>
                      </div>
                      <span className="figure text-sm">{formatMoney(installment.amount, currency)}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {installments.length > 0 ? (
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border/70 pt-3 text-sm">
                <span className="text-muted-foreground">{t.scheduleTotal}</span>
                <span className="text-right">
                  <span className="figure">{formatMoney(installmentsTotal, currency)}</span>
                  {roundingDifference !== 0 ? (
                    <span className="block text-[0.6875rem] text-muted-foreground">
                      {roundingDifference < 0
                        ? t.scheduleRoundedUnder(formatMoney(-roundingDifference, currency))
                        : t.scheduleRoundedOver(formatMoney(roundingDifference, currency))}
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button type="button" onClick={evaluate} disabled={!canEvaluate || evaluating}>
                {evaluating ? t.checking : t.checkAffordability}
              </Button>
            </div>
            {error && !evaluated ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {evaluated && account ? (
        <div className={cn(stale && "opacity-70")}>
          <AffordResults
            verdict={evaluated.verdict}
            recorded={evaluated.recorded}
            accountName={account.name}
            historyPeriods={historyPeriods}
            stale={stale}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
            onConfirm={confirm}
            onDiscard={resetAll}
            confirming={confirming}
            error={error}
            locale={locale}
          />
        </div>
      ) : null}
    </div>
  );
}
