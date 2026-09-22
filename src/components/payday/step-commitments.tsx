"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatMoney } from "@/lib/currency";
import { formatDayMonth } from "@/lib/date";
import { round2 } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Dictionary } from "@/lib/i18n";
import type {
  AccountBufferBreakdown,
  CoverShortfallSuggestion,
  GoalFundingRow,
  ResolvedGoalFunding,
} from "@/lib/payday";
import type {
  CarryoverBasis,
  PaydayAccountDraft,
  PaydayCategoryDraft,
  PaydayCommittedDraft,
  PaydayGoalDraft,
} from "@/lib/data/payday";

function AlreadyLoggedBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="text-[0.6875rem] font-normal text-muted-foreground">
      {label}
    </Badge>
  );
}

function AmountInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  return (
    <PaydayAmountInput
      ariaLabel={ariaLabel}
      className="w-32"
      value={value}
      onChange={(next) => onChange(Math.max(0, next))}
    />
  );
}

/**
 * One due subscription inside its account's buffer block. The account picker
 * writes RecurringItem.accountId through the same action the Recurring page
 * uses, so the change outlives this wizard.
 */
function SubscriptionRow({
  item,
  accounts,
  pending,
  onReassign,
  pickAnAccountLabel,
  className,
  t,
}: {
  item: PaydayCommittedDraft;
  accounts: PaydayAccountDraft[];
  pending: boolean;
  onReassign: (recurringItemId: string, accountId: string) => void;
  pickAnAccountLabel: string;
  className?: string;
  t: Dictionary["payday"];
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 text-sm", className)}>
      <span className="min-w-0 flex-1">
        {item.name}{" "}
        <span className="text-xs text-muted-foreground">
          {formatDayMonth(item.nextDate)}
          {item.occurrenceCount > 1
            ? ` · ${t.chargesThisPeriod(item.occurrenceCount, formatMoney(item.perOccurrenceAmount, item.currency))}`
            : ""}
        </span>
      </span>
      {/* Wraps on a phone: badge + amount + a fixed-width account picker is
          wider than the buffer block at 375px if this row cannot break. */}
      <span className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:flex-nowrap">
        {item.overdue ? <AlreadyLoggedBadge label={t.overdueBadge} /> : null}
        {item.alreadyLogged ? <AlreadyLoggedBadge label={t.alreadyPaidThisPeriod} /> : null}
        <span className="figure">{formatMoney(item.nativeAmount, item.currency)}</span>
        <Select
          value={item.accountId ?? undefined}
          onValueChange={(accountId) => onReassign(item.recurringItemId, accountId)}
          disabled={pending}
        >
          <SelectTrigger
            size="sm"
            className="w-full min-w-0 sm:w-36"
            aria-label={t.subscriptionAccountLabel(item.name)}
          >
            <SelectValue placeholder={pickAnAccountLabel} />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.accountId} value={account.accountId}>
                {account.name}
                <span className="ml-1.5 text-muted-foreground">{account.currency}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </div>
  );
}

/**
 * One account inside a goal's funding block: what it has to spare and the
 * draw planned from it, editable in the account's own currency with the
 * recommendation kept in view - the same shape as a subscription row inside
 * its account's buffer block above.
 */
function GoalFundingRowView({
  goalName,
  row,
  headroomBeforeGoals,
  onChange,
  className,
  t,
}: {
  goalName: string;
  row: GoalFundingRow;
  /** The account's headroom before any goal drew on it (the buffer view's figure). */
  headroomBeforeGoals: number;
  onChange: (value: number) => void;
  className?: string;
  t: Dictionary["payday"];
}) {
  const sharePercent = Math.round(row.share * 100);
  const reason =
    row.headroom <= 0
      ? t.goalFundingNoRoomLeft
      : row.headroom < headroomBeforeGoals
        ? t.goalFundingRoomAfterEarlierGoals(formatMoney(row.headroom, row.currency), sharePercent)
        : t.goalFundingRoom(formatMoney(row.headroom, row.currency), sharePercent);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 text-sm", className)}>
      <span className="min-w-0 flex-1">
        {row.name}
        <span className="block text-xs text-muted-foreground">{reason}</span>
      </span>
      <Field
        label={`${t.plannedAmount} (${row.currency})`}
        hint={
          <>
            {t.goalFundingRecommended}:{" "}
            <span className="figure">{formatMoney(row.recommendedAmount, row.currency)}</span>
          </>
        }
      >
        <AmountInput
          value={row.plannedAmount}
          onChange={onChange}
          ariaLabel={t.goalFundingAccountLabel(goalName, row.name)}
        />
      </Field>
    </div>
  );
}

/**
 * Below sm each account and goal block folds to its header and its verdict
 * (the buffer status, a goal's pace, any warning) and opens on a tap to the
 * rows and inputs that change them - the trade M3 names against "don't hide
 * content behind taps", because unfolded Step 3 runs to seven phone screens.
 * The header row is the toggle: a transparent button laid over it and out
 * over the block's padding by the same 12px, so a one-line header is a 44px
 * target without restyling it. The chevron at its right edge is what says
 * the header opens at all, swapped down/up with the state the way the
 * Recurring page's "Show charges" toggle does, in the Select trigger's size
 * and colour; the header keeps clear of it with its own right padding.
 * Above sm nothing folds and the button is display:none.
 */
function BlockToggle({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-checkin-disclosure
      aria-label={label}
      aria-expanded={expanded}
      onClick={onToggle}
      className="absolute -inset-3 flex items-center justify-end rounded-lg px-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:hidden"
    >
      {expanded ? (
        <ChevronUp className="size-4 text-muted-foreground" aria-hidden />
      ) : (
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

export function StepCommitments({
  accounts,
  subscriptions,
  contributions,
  goals,
  essentialCategories,
  displayCurrency,
  bufferPlan,
  plannedBuffer,
  reassigningItemId,
  onReassignSubscription,
  availableCarryover,
  carryoverBasis,
  includedCarryover,
  totalIncome,
  subscriptionsTotal,
  contributionsTotal,
  goalPlanTotal,
  essentialFixedTotal,
  available,
  goalFunding,
  onGoalFundingChange,
  coverShortfallByAccount,
  onCoverShortfall,
  onEssentialChange,
  onCarryoverChange,
  pickAnAccountLabel,
  t,
}: {
  accounts: PaydayAccountDraft[];
  subscriptions: PaydayCommittedDraft[];
  contributions: PaydayCommittedDraft[];
  goals: PaydayGoalDraft[];
  essentialCategories: PaydayCategoryDraft[];
  displayCurrency: string;
  bufferPlan: AccountBufferBreakdown;
  plannedBuffer: number;
  /** The subscription whose account write is still in flight - its picker stays disabled until it lands. */
  reassigningItemId: string | null;
  onReassignSubscription: (recurringItemId: string, accountId: string) => void;
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  totalIncome: number;
  subscriptionsTotal: number;
  contributionsTotal: number;
  goalPlanTotal: number;
  essentialFixedTotal: number;
  available: number;
  /** Each goal's per-account rows, keyed by goal, derived live in the dialog from the buffer view's headroom. */
  goalFunding: Map<string, ResolvedGoalFunding>;
  /** One account's draw for one goal, in that account's own currency. */
  onGoalFundingChange: (goalId: string, accountId: string, plannedAmount: number) => void;
  /** Which other account to draw from to close a flagged account's reconciliation gap - see suggestCoverShortfall. Keyed by the flagged account; an account with nothing safe to draw from has no entry. */
  coverShortfallByAccount: Map<string, CoverShortfallSuggestion>;
  /** Opens the Transfer dialog pre-filled with the suggestion; nothing here creates a transfer. */
  onCoverShortfall: (suggestion: CoverShortfallSuggestion) => void;
  onEssentialChange: (categoryId: string, plannedAmount: number) => void;
  onCarryoverChange: (value: number) => void;
  pickAnAccountLabel: string;
  t: Dictionary["payday"];
}) {
  const subscriptionById = new Map(subscriptions.map((item) => [item.recurringItemId, item]));
  // An account's room before any goal drew on it, to tell "to spare after its
  // subscriptions and buffer" from "still to spare after the goals above".
  const headroomByAccount = new Map(bufferPlan.accounts.map((plan) => [plan.accountId, plan.headroom]));
  const unfundedSubscriptions = bufferPlan.unassignedRecurringItemIds
    .map((id) => subscriptionById.get(id))
    .filter((item) => item !== undefined);
  // Which blocks the user has opened on a phone (see BlockToggle). Display
  // only: every row stays mounted either way, so nothing here feeds a figure.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const folded = (key: string) => (expanded.has(key) ? undefined : "max-sm:hidden");

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.bufferByAccountHeading}</CardTitle>
          <CardDescription>{t.bufferByAccountDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {bufferPlan.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noIncomeAccountsYet}</p>
          ) : (
            bufferPlan.accounts.map((plan) => {
              const items = plan.recurringItemIds
                .map((id) => subscriptionById.get(id))
                .filter((item) => item !== undefined);
              const key = `account:${plan.accountId}`;
              return (
                <div key={plan.accountId} className="space-y-2 rounded-lg border border-border/70 p-3">
                  <div className="relative flex flex-wrap items-baseline justify-between gap-2 max-sm:pr-5">
                    <p className="text-sm font-medium">{plan.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.accountSuggestedBuffer}:{" "}
                      <span className="figure">{formatMoney(plan.suggestedBuffer, plan.currency)}</span>
                    </p>
                    <BlockToggle label={plan.name} expanded={expanded.has(key)} onToggle={() => toggle(key)} />
                  </div>
                  <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground", folded(key))}>
                    <span>
                      {t.accountIncomeReceived}:{" "}
                      <span className="figure">{formatMoney(plan.income, plan.currency)}</span>
                    </span>
                    <span>
                      {t.accountSubscriptionsDue}:{" "}
                      <span className="figure">-{formatMoney(plan.subscriptionsTotal, plan.currency)}</span>
                    </span>
                    <span>
                      {t.accountLeftAfterSubscriptions}:{" "}
                      <span className="figure">{formatMoney(plan.remaining, plan.currency)}</span>
                    </span>
                    {plan.reportedSupports !== null ? (
                      <span>
                        {t.accountReportedSupports}:{" "}
                        <span className="figure">{formatMoney(plan.reportedSupports, plan.currency)}</span>
                      </span>
                    ) : null}
                  </div>
                  {plan.belowReported ? (
                    // Advisory only: it never feeds the plan's figures and never
                    // asks for an acknowledgement, unlike the buffer breach below.
                    <div className="reveal-block space-y-2">
                      <Alert>
                        <AlertDescription>
                          {t.accountReportedBelowProjection(formatMoney(plan.reportedGap, plan.currency))}
                        </AlertDescription>
                      </Alert>
                      {(() => {
                        const cover = coverShortfallByAccount.get(plan.accountId);
                        if (!cover) return null;
                        const amount = formatMoney(cover.amount, cover.sourceCurrency);
                        return (
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="text-muted-foreground">
                              {cover.fullyCovers
                                ? t.coverShortfallSuggestion(amount, cover.sourceAccountName)
                                : t.coverShortfallPartialSuggestion(amount, cover.sourceAccountName)}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => onCoverShortfall(cover)}
                            >
                              {t.coverShortfallButton}
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                  {items.length === 0 ? (
                    <p className={cn("text-xs text-muted-foreground", folded(key))}>
                      {t.accountNoSubscriptionsDue}
                    </p>
                  ) : (
                    items.map((item) => (
                      <SubscriptionRow
                        key={item.recurringItemId}
                        item={item}
                        accounts={accounts}
                        pending={reassigningItemId === item.recurringItemId}
                        onReassign={onReassignSubscription}
                        pickAnAccountLabel={pickAnAccountLabel}
                        className={folded(key)}
                        t={t}
                      />
                    ))
                  )}
                  {plan.belowBuffer ? (
                    <div className="reveal-block">
                      <Alert variant="destructive">
                        <AlertDescription>
                          {plan.suggestedAccountName
                            ? t.accountBelowBufferWithAlternative(
                                formatMoney(plan.shortfall, plan.currency),
                                plan.suggestedAccountName,
                              )
                            : t.accountBelowBuffer(formatMoney(plan.shortfall, plan.currency))}
                        </AlertDescription>
                      </Alert>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--good)]">
                      {t.accountAboveBuffer(formatMoney(plan.headroom, plan.currency))}
                    </p>
                  )}
                </div>
              );
            })
          )}

          {unfundedSubscriptions.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border/70 p-3">
              <div>
                <p className="text-sm font-medium">{t.unfundedSubscriptionsHeading}</p>
                <p className="text-xs text-muted-foreground">{t.unfundedSubscriptionsDescription}</p>
              </div>
              {unfundedSubscriptions.map((item) => (
                <SubscriptionRow
                  key={item.recurringItemId}
                  item={item}
                  accounts={accounts}
                  pending={reassigningItemId === item.recurringItemId}
                  onReassign={onReassignSubscription}
                  pickAnAccountLabel={pickAnAccountLabel}
                  t={t}
                />
              ))}
            </div>
          ) : null}

          {subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noSubscriptionsDue}</p>
          ) : null}

          {plannedBuffer <= 0 ? (
            <div className="reveal-block">
              <Alert variant="destructive">
                <AlertDescription>{t.bufferZeroWarning}</AlertDescription>
              </Alert>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.contributionsDue}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {contributions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noContributionsDue}</p>
          ) : (
            contributions.map((item) => (
              <div key={item.recurringItemId} className="flex items-center justify-between text-sm">
                <span>
                  {item.name}{" "}
                  <span className="text-xs text-muted-foreground">{formatDayMonth(item.nextDate)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {item.overdue ? <AlreadyLoggedBadge label={t.overdueBadge} /> : null}
                  {item.alreadyLogged ? <AlreadyLoggedBadge label={t.alreadyPaidThisPeriod} /> : null}
                  <span className="figure">{formatMoney(item.amount, displayCurrency)}</span>
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.goalsHeading}</CardTitle>
          <CardDescription>{t.goalsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {goals.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noGoalsToReserve}</p>
          ) : (
            goals.map((goal) => {
              const funding = goalFunding.get(goal.goalId);
              const rows = funding?.rows ?? [];
              const total = funding?.total ?? 0;
              const variance = round2(total - goal.recommendedAmount);
              // The account taking the larger share, when the goal is split at all.
              const sharing = rows.filter((row) => row.share > 0).sort((a, b) => b.share - a.share);
              const lead = sharing.length > 1 && sharing[0].share > sharing[1].share ? sharing[0] : null;
              const key = `goal:${goal.goalId}`;
              return (
                <div key={goal.goalId} className="space-y-2 rounded-lg border border-border/70 p-3">
                  <div className="relative flex flex-wrap items-baseline justify-between gap-2 max-sm:pr-5">
                    <p className="text-sm font-medium">{goal.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.goalPlannedTotal}:{" "}
                      <span className="figure">{formatMoney(total, displayCurrency)}</span>
                    </p>
                    <BlockToggle label={goal.name} expanded={expanded.has(key)} onToggle={() => toggle(key)} />
                  </div>
                  {/* A dated goal shows its pace; an undated one has none, so
                      its figure is the whole remaining balance, recommended in
                      full as far as the accounts' room allows. */}
                  {goal.targetDate ? (
                    <p className={cn("text-xs text-muted-foreground", folded(key))}>
                      {t.roadmapAmount}:{" "}
                      <span className="figure">{formatMoney(goal.recommendedAmount, displayCurrency)}</span>
                    </p>
                  ) : (
                    <p className={cn("text-xs text-muted-foreground", folded(key))}>
                      {t.remainingBalanceNoDate}:{" "}
                      <span className="figure">{formatMoney(goal.recommendedAmount, displayCurrency)}</span>
                      {" · "}
                      {t.remainingBalanceNoDateHint}
                    </p>
                  )}
                  {rows.length === 0 ? (
                    <p className={cn("text-xs text-muted-foreground", folded(key))}>{t.goalFundingNoRoom}</p>
                  ) : (
                    rows.map((row) => (
                      <GoalFundingRowView
                        key={row.accountId}
                        goalName={goal.name}
                        row={row}
                        headroomBeforeGoals={headroomByAccount.get(row.accountId) ?? row.headroom}
                        onChange={(value) => onGoalFundingChange(goal.goalId, row.accountId, value)}
                        className={folded(key)}
                        t={t}
                      />
                    ))
                  )}
                  {lead ? (
                    <p className={cn("text-xs text-muted-foreground", folded(key))}>
                      {t.goalFundingLeadAccount(lead.name)}
                    </p>
                  ) : null}
                  {funding && funding.shortfall > 0 ? (
                    <div className="reveal-block">
                      <Alert variant="destructive">
                        <AlertDescription>
                          {t.goalFundingShortfall(
                            formatMoney(funding.recommendedTotal, displayCurrency),
                            formatMoney(funding.shortfall, displayCurrency),
                          )}
                        </AlertDescription>
                      </Alert>
                    </div>
                  ) : null}
                  <p className={variance >= 0 ? "text-xs text-[var(--good)]" : "text-xs text-[var(--critical)]"}>
                    {goal.targetDate
                      ? variance === 0
                        ? t.goalOnTrack
                        : variance > 0
                          ? t.goalAhead(formatMoney(variance, displayCurrency))
                          : t.goalBehind(formatMoney(Math.abs(variance), displayCurrency))
                      : variance === 0
                        ? t.goalRemainingFunded
                        : variance > 0
                          ? t.goalRemainingOver(formatMoney(variance, displayCurrency))
                          : t.goalRemainingLeft(formatMoney(Math.abs(variance), displayCurrency))}
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.essentialCategoriesHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {essentialCategories.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noEssentialCategoriesConfigured}</p>
          ) : (
            essentialCategories.map((category) => (
              <div key={category.categoryId} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm">
                  <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />
                  {category.name}
                </span>
                <AmountInput
                  value={category.plannedAmount}
                  onChange={(value) => onEssentialChange(category.categoryId, value)}
                  ariaLabel={category.name}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.carryoverHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {carryoverBasis === "prior_period_budget"
              ? t.carryoverAvailable(formatMoney(availableCarryover, displayCurrency))
              : t.carryoverUnavailable}
          </p>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch
              checked={includedCarryover > 0}
              onCheckedChange={(checked) => onCarryoverChange(checked ? availableCarryover : 0)}
            />
            {t.carryoverIncluded}
          </label>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span>{t.summaryIncome}</span>
            <span className="figure">{formatMoney(totalIncome, displayCurrency)}</span>
          </div>
          <div className="flex justify-between">
            <span>{t.summaryCarryover}</span>
            <span className="figure">{formatMoney(includedCarryover, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summarySubscriptions}</span>
            <span className="figure">-{formatMoney(subscriptionsTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryContributions}</span>
            <span className="figure">-{formatMoney(contributionsTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryGoals}</span>
            <span className="figure">-{formatMoney(goalPlanTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryEssential}</span>
            <span className="figure">-{formatMoney(essentialFixedTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryBuffer}</span>
            <span className="figure">-{formatMoney(plannedBuffer, displayCurrency)}</span>
          </div>
          {bufferPlan.reconciliationGap > 0 ? (
            // The origin of a capped figure stays visible: the gap the buffer
            // card flagged above is the last line taken off before "available".
            <div className="flex justify-between text-muted-foreground">
              <span>{t.summaryReconciliationCap}</span>
              <span className="figure">-{formatMoney(bufferPlan.reconciliationGap, displayCurrency)}</span>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border/70 pt-1.5 font-medium">
            <span>{t.summaryAvailable}</span>
            <span className={available < 0 ? "figure text-[var(--critical)]" : "figure"}>
              {formatMoney(available, displayCurrency)}
            </span>
          </div>
          {available < 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t.deficitWarning(formatMoney(Math.abs(available), displayCurrency))}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
