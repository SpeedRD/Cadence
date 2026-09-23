"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

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
      <span className="figure figure-sm text-hint text-muted-foreground">
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

/**
 * Wraps a Table whose content may be wider than its box and fades whichever
 * edge has more table beyond it (the .scroll-fade rule in globals.css), so a
 * sideways scroll is visible instead of silent. Nothing changes while the
 * table fits.
 */
function ScrollFade({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!scroller) return;
    const update = () => {
      const overflow = scroller.scrollWidth - scroller.clientWidth;
      const start = overflow > 1 && scroller.scrollLeft > 1;
      const end = overflow > 1 && scroller.scrollLeft < overflow - 1;
      setEdges((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="scroll-fade"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
    >
      {children}
    </div>
  );
}

/**
 * "Record it": the acknowledgement a failing verdict needs and the two
 * decisions. Rendered twice, one copy per presentation: at the foot of the
 * results from `sm`, and on a phone directly under the verdict (in flow, not
 * docked), so the verdict and what to do about it share one screen. Both
 * copies drive the same state, so a resize never loses a tick.
 */
function RecordCard({
  variant,
  className,
  verdict,
  recorded,
  stale,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  onDiscard,
  confirming,
  canConfirm,
  error,
  t,
}: {
  variant: "desktop" | "phone";
  className?: string;
  verdict: AffordVerdict;
  recorded: AffordRecordedPlan;
  stale: boolean;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  onConfirm: () => void;
  onDiscard: () => void;
  confirming: boolean;
  canConfirm: boolean;
  error: string | null;
  t: ReturnType<typeof getDictionary>["afford"];
}) {
  const phone = variant === "phone";
  const checkboxId = phone ? "afford-acknowledge-phone" : "afford-acknowledge";
  const acknowledgement = (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={checkboxId}
        // On a phone the hit area grows to 44 x 44 around the 16px box. The
        // insets are measured from the 14px padding box inside its 1px
        // border. The left side stops at the card's edge (12px of padding,
        // and the card clips), so the extra width goes right, onto this
        // checkbox's own label.
        className={cn(
          "mt-0.5",
          phone && "after:-top-3.75 after:-right-4.25 after:-bottom-3.75 after:-left-3.25",
        )}
        checked={acknowledged}
        disabled={stale}
        onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
      />
      <Label htmlFor={checkboxId} className="block text-sm leading-snug font-normal">
        {t.acknowledgeLabel}
      </Label>
    </div>
  );

  return (
    <Card size="sm" className={className}>
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
            made, which unlocks the button below. On a phone it arrives with
            the scroll that brings the verdict into view, so it is not also
            revealed (the reveal would change the group's height after the
            scroll has measured it, and its clipping would cut the hit
            area). */}
        {!verdict.viable ? (
          phone ? acknowledgement : <div className="reveal-block">{acknowledgement}</div>
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
  // Periods with no confirmed check-in whose commitments carry an estimate of
  // what they will put toward goals - marked in both tables and spelled out
  // under the projection, goal by goal, so the estimate is never mistaken for
  // a confirmed figure.
  const periodsWithEstimate = verdict.periods.filter((period) => period.estimatedGoals.length > 0);
  const accountCurrency = verdict.periods[0]?.account.currency ?? recorded.currency;
  const displayCurrency = verdict.periods[0]?.flexible.currency ?? recorded.currency;
  const recordProps = {
    verdict,
    recorded,
    stale,
    acknowledged,
    onAcknowledgedChange,
    onConfirm,
    onDiscard,
    confirming,
    canConfirm,
    error,
    t,
  };

  // On a phone the verdict lands below a long form, so each new one (a new
  // object per evaluation) is brought into view with its decision.
  // "nearest" moves the least: the group's foot just clears the tab bar, or,
  // if it is taller than the screen, its head sits under the header.
  const verdictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia("(width < 40rem)").matches) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    verdictRef.current?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [verdict]);

  return (
    <div className="space-y-5">
      {/* The verdict and, on a phone, the decision it asks for: one group,
          scrolled into view together when a verdict arrives. The scroll
          margins keep it clear of the sticky chrome with a 1rem gap: the
          header is h-14 plus its 1px border-b, the tab bar 49px of tabs plus
          its 1px border-t plus the home-indicator inset. */}
      <div
        ref={verdictRef}
        className="max-sm:scroll-mt-[calc(3.5rem+1px+1rem)] max-sm:scroll-mb-[calc(50px+env(safe-area-inset-bottom)+1rem)]"
      >
        <Alert
          aria-live="polite"
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

        <RecordCard {...recordProps} variant="phone" className="mt-5 sm:hidden" />
      </div>

      <Card>
        <CardContent>
          <div className="hidden sm:block">
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
                    <span className="block text-badge font-normal text-muted-foreground">
                      {t.columnBeforeAfter} · {accountCurrency}
                    </span>
                  </TableHead>
                  <TableHead className="min-w-40 text-right whitespace-normal">
                    {t.columnFlexibleCheck}
                    <span className="block text-badge font-normal text-muted-foreground">
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
                            <span className="block text-badge text-muted-foreground">
                              {t.checkedTogether(period.installments.length)}
                            </span>
                          ) : null}
                          {index === 0 && period.estimatedGoals.length > 0 ? (
                            <span className="block text-badge text-muted-foreground">
                              {t.estimatedInCommitments}
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
          </div>

          {/* On a phone (below `sm`) one card per pay period: the period and
              its verdict, the installments it owes, then the two checks as
              labelled before/after lines. */}
          <ul className="divide-y sm:hidden">
            {verdict.periods.map((period) => (
              <li key={period.key} className="space-y-3 py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{period.period.label}</p>
                    {period.installments.length > 1 ? (
                      <p className="text-badge text-muted-foreground">
                        {t.checkedTogether(period.installments.length)}
                      </p>
                    ) : null}
                    {period.estimatedGoals.length > 0 ? (
                      <p className="text-badge text-muted-foreground">{t.estimatedInCommitments}</p>
                    ) : null}
                  </div>
                  <VerdictBadge passes={period.passes} t={t} />
                </div>
                <ul className="space-y-1">
                  {period.installments.map((installment) => (
                    <li key={installment.index} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <span className="text-muted-foreground">{t.paymentLabel(installment.index)}</span>
                        {" · "}
                        {formatDate(installment.date)}
                      </span>
                      <span className="figure">{formatMoney(installment.amount, verdict.currency)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <dt className="min-w-0 text-sm">
                      {t.columnAccountCheck(accountName)}
                      <span className="block text-badge text-muted-foreground">
                        {t.columnBeforeAfter} · {period.account.currency}
                      </span>
                    </dt>
                    <dd>
                      <BeforeAfter
                        before={period.account.headroomBefore}
                        after={period.account.headroomAfter}
                        currency={period.account.currency}
                        passes={period.account.passes}
                      />
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="min-w-0 text-sm">
                      {t.columnFlexibleCheck}
                      <span className="block text-badge text-muted-foreground">
                        {t.columnBeforeAfter} · {period.flexible.currency}
                      </span>
                    </dt>
                    <dd>
                      <BeforeAfter
                        before={period.flexible.availableBefore}
                        after={period.flexible.availableAfter}
                        currency={period.flexible.currency}
                        passes={period.flexible.passes}
                      />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
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

      {/* The last card on a phone: the desktop Record card after it is only
          hidden there, so space-y would still give this one its gap. */}
      <Card size="sm" className="max-sm:mb-0">
        <CardHeader>
          <CardTitle>{t.projectionHeading}</CardTitle>
          <CardDescription>{t.projectionDescription(historyPeriods, accountName)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ScrollFade>
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
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
                    {t.projectionIncome}
                  </TableHead>
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
                    {t.projectionCommitted}
                  </TableHead>
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
                    {t.projectionBuffer}
                  </TableHead>
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
                    {t.projectionIncome}
                  </TableHead>
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
                    {t.projectionCommitted}
                  </TableHead>
                  <TableHead className="text-right text-badge font-normal text-muted-foreground">
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
                      {period.estimatedGoals.length > 0 ? <span className="text-muted-foreground"> *</span> : null}
                    </TableCell>
                    <TableCell className="figure text-right">
                      {formatMoney(period.account.buffer, period.account.currency)}
                    </TableCell>
                    <TableCell className="figure text-right">
                      {formatMoney(period.flexible.income, period.flexible.currency)}
                    </TableCell>
                    <TableCell className="figure text-right">
                      {formatMoney(period.flexible.committed, period.flexible.currency)}
                      {period.estimatedGoals.length > 0 ? <span className="text-muted-foreground"> *</span> : null}
                    </TableCell>
                    <TableCell className="figure text-right">
                      {formatMoney(period.flexible.buffer, period.flexible.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollFade>
          {periodsWithEstimate.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {periodsWithEstimate.map((period) => (
                <li key={period.key}>
                  {t.estimatedGoalFunding(
                    period.period.label,
                    period.estimatedGoals.map((goal) =>
                      t.estimatedGoalItem(formatMoney(goal.amount, period.flexible.currency), goal.name),
                    ),
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {periodsWithoutHistory.length > 0 ? (
            <p className="text-xs text-[var(--warning)]">
              {t.noHistoryForAccount(accountName, historyPeriods)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <RecordCard {...recordProps} variant="desktop" className="max-sm:hidden" />
    </div>
  );
}
