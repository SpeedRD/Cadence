"use client";

import { Fragment } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import type { AffordVerdict, PeriodVerdict } from "@/lib/afford";
import type { AffordRecordedPlan } from "@/lib/data/afford";

/** "before / after" pair: the before muted, the after coloured by whether it stayed on the right side of zero. Shared with the Recurring form's subscription room panel. */
export function BeforeAfter({
  before,
  after,
  currency,
  passes,
}: {
  before: number;
  after: number;
  currency: string;
  passes: boolean;
}) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="figure figure-sm text-[0.6875rem] text-muted-foreground">
        {formatMoney(before, currency)}
      </span>
      <span className={cn("figure", passes ? "text-[var(--good)]" : "text-[var(--critical)]")}>
        {formatMoney(after, currency)}
      </span>
    </span>
  );
}

function VerdictBadge({ passes, t }: { passes: boolean; t: ReturnType<typeof getDictionary>["afford"] }) {
  return passes ? (
    <Badge variant="secondary" className="text-[var(--good)]">
      {t.passes}
    </Badge>
  ) : (
    <Badge variant="destructive">{t.fails}</Badge>
  );
}

export function AffordResults({
  verdict,
  recorded,
  accountName,
  historyPeriods,
  stale,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  onDiscard,
  confirming,
  error,
  locale,
}: {
  verdict: AffordVerdict;
  recorded: AffordRecordedPlan;
  accountName: string;
  historyPeriods: number;
  /** The inputs changed since this verdict was computed - shown, but nothing can be recorded from it. */
  stale: boolean;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onConfirm: () => void;
  onDiscard: () => void;
  confirming: boolean;
  error: string | null;
  locale: Locale;
}) {
  const t = getDictionary(locale).afford;
  const canConfirm = !stale && (verdict.viable || acknowledged);
  const periodsWithoutHistory = verdict.periods.filter((period) => period.account.basis === "none");
  const accountCurrency = verdict.periods[0]?.account.currency ?? recorded.currency;
  const displayCurrency = verdict.periods[0]?.flexible.currency ?? recorded.currency;

  return (
    <div className="space-y-5">
      <Alert
        className={cn(
          verdict.viable ? "border-[var(--good)]/40" : "border-[var(--critical)]/40",
        )}
      >
        <AlertTitle className="flex items-center gap-2">
          <span
            className={cn(
              "figure text-base",
              verdict.viable ? "text-[var(--good)]" : "text-[var(--critical)]",
            )}
          >
            {verdict.viable ? t.verdictViable : t.verdictNotViable}
          </span>
        </AlertTitle>
        <AlertDescription>
          <p>
            {verdict.viable
              ? t.viableSummary(verdict.periods.length)
              : t.notViableSummary(verdict.failing.length)}
          </p>
          {stale ? <p className="text-[var(--warning)]">{t.resultsStale}</p> : null}
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columnPayment}</TableHead>
                <TableHead>{t.columnDate}</TableHead>
                <TableHead>{t.columnPeriod}</TableHead>
                <TableHead className="text-right">{t.columnAmount}</TableHead>
                {/* These two headings are sentences; letting them wrap keeps
                    the verdict column on screen at desktop widths instead of
                    pushing it into the horizontal scroll. */}
                <TableHead className="min-w-40 text-right whitespace-normal">
                  {t.columnAccountCheck(accountName)}
                  <span className="block text-[0.625rem] font-normal text-muted-foreground">
                    {t.columnBeforeAfter} · {accountCurrency}
                  </span>
                </TableHead>
                <TableHead className="min-w-40 text-right whitespace-normal">
                  {t.columnFlexibleCheck}
                  <span className="block text-[0.625rem] font-normal text-muted-foreground">
                    {t.columnBeforeAfter} · {displayCurrency}
                  </span>
                </TableHead>
                <TableHead>{t.columnVerdict}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verdict.periods.map((period) => (
                <Fragment key={period.key}>
                  {period.installments.map((installment, index) => (
                    <TableRow key={installment.index}>
                      <TableCell className="text-muted-foreground">
                        {t.paymentLabel(installment.index)}
                      </TableCell>
                      <TableCell>{formatDate(installment.date)}</TableCell>
                      <TableCell>
                        {period.period.label}
                        {index === 0 && period.installments.length > 1 ? (
                          <span className="block text-[0.625rem] text-muted-foreground">
                            {t.checkedTogether(period.installments.length)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="figure">{formatMoney(installment.amount, verdict.currency)}</span>
                      </TableCell>
                      {/* The checks are per period, so a period owed several
                          installments shows them once, spanning its rows. */}
                      {index === 0 ? (
                        <>
                          <TableCell rowSpan={period.installments.length} className="text-right align-middle">
                            <BeforeAfter
                              before={period.account.headroomBefore}
                              after={period.account.headroomAfter}
                              currency={period.account.currency}
                              passes={period.account.passes}
                            />
                          </TableCell>
                          <TableCell rowSpan={period.installments.length} className="text-right align-middle">
                            <BeforeAfter
                              before={period.flexible.availableBefore}
                              after={period.flexible.availableAfter}
                              currency={period.flexible.currency}
                              passes={period.flexible.passes}
                            />
                          </TableCell>
                          <TableCell rowSpan={period.installments.length} className="align-middle">
                            <VerdictBadge passes={period.passes} t={t} />
                          </TableCell>
                        </>
                      ) : null}
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {verdict.failing.length > 0 ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t.shortfallHeading}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-4 text-sm">
              {verdict.failing.flatMap((period: PeriodVerdict) => {
                const lines: { key: string; text: string }[] = [];
                if (!period.account.passes) {
                  lines.push({
                    key: `${period.key}-account`,
                    text: t.accountShortfall(
                      period.period.label,
                      period.account.name,
                      formatMoney(period.account.shortfall, period.account.currency),
                    ),
                  });
                }
                if (!period.flexible.passes) {
                  lines.push({
                    key: `${period.key}-flexible`,
                    text: t.flexibleShortfall(
                      period.period.label,
                      formatMoney(period.flexible.shortfall, period.flexible.currency),
                    ),
                  });
                }
                return lines;
              }).map((line) => (
                <li key={line.key}>{line.text}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.projectionHeading}</CardTitle>
          <CardDescription>{t.projectionDescription(historyPeriods, accountName)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columnPeriod}</TableHead>
                <TableHead colSpan={3} className="text-right">
                  {t.projectionAccountColumns(accountName)} · {accountCurrency}
                </TableHead>
                <TableHead colSpan={3} className="text-right">
                  {t.projectionPeriodColumns} · {displayCurrency}
                </TableHead>
              </TableRow>
              <TableRow>
                <TableHead />
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionIncome}
                </TableHead>
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionCommitted}
                </TableHead>
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionBuffer}
                </TableHead>
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionIncome}
                </TableHead>
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionCommitted}
                </TableHead>
                <TableHead className="text-right text-[0.625rem] font-normal text-muted-foreground">
                  {t.projectionBuffer}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verdict.periods.map((period) => (
                <TableRow key={period.key}>
                  <TableCell>{period.period.label}</TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.account.income, period.account.currency)}
                  </TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.account.committed, period.account.currency)}
                  </TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.account.buffer, period.account.currency)}
                  </TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.flexible.income, period.flexible.currency)}
                  </TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.flexible.committed, period.flexible.currency)}
                  </TableCell>
                  <TableCell className="figure text-right">
                    {formatMoney(period.flexible.buffer, period.flexible.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {periodsWithoutHistory.length > 0 ? (
            <p className="text-xs text-[var(--warning)]">
              {t.noHistoryForAccount(accountName, historyPeriods)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.recordHeading}</CardTitle>
          <CardDescription>
            {t.recordedNote(
              formatMoney(recorded.amount, recorded.currency),
              t.frequencyAdverb[recorded.frequency] ?? recorded.frequency,
              recorded.count,
              formatDate(recorded.firstDate),
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Same control and sibling Checkbox + Label arrangement as the
              payday check-in's zero-buffer acknowledgement: a statement being
              made, which unlocks the button below. */}
          {!verdict.viable ? (
            <div className="reveal-block">
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="afford-acknowledge"
                  className="mt-0.5"
                  checked={acknowledged}
                  disabled={stale}
                  onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
                />
                <Label htmlFor="afford-acknowledge" className="block text-sm leading-snug font-normal">
                  {t.acknowledgeLabel}
                </Label>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onDiscard} disabled={confirming}>
              {t.addLater}
            </Button>
            <Button type="button" onClick={onConfirm} disabled={!canConfirm || confirming}>
              {t.bought}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
