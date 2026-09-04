"use client";

import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import type { Dictionary } from "@/lib/i18n";
import type { AccountBufferBreakdown } from "@/lib/payday";
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
  t,
}: {
  item: PaydayCommittedDraft;
  accounts: PaydayAccountDraft[];
  pending: boolean;
  onReassign: (recurringItemId: string, accountId: string) => void;
  pickAnAccountLabel: string;
  t: Dictionary["payday"];
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>
        {item.name}{" "}
        <span className="text-xs text-muted-foreground">{formatDayMonth(item.nextDate)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        {item.alreadyLogged ? <AlreadyLoggedBadge label={t.alreadyPaidThisPeriod} /> : null}
        <span className="figure">{formatMoney(item.nativeAmount, item.currency)}</span>
        <Select
          value={item.accountId ?? undefined}
          onValueChange={(accountId) => onReassign(item.recurringItemId, accountId)}
          disabled={pending}
        >
          <SelectTrigger size="sm" className="w-36" aria-label={t.subscriptionAccountLabel(item.name)}>
            <SelectValue placeholder={pickAnAccountLabel} />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.accountId} value={account.accountId}>
                {account.name}
                <span className="text-muted-foreground">{account.currency}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </div>
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
  onGoalChange,
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
  onGoalChange: (goalId: string, plannedAmount: number) => void;
  onEssentialChange: (categoryId: string, plannedAmount: number) => void;
  onCarryoverChange: (value: number) => void;
  pickAnAccountLabel: string;
  t: Dictionary["payday"];
}) {
  const subscriptionById = new Map(subscriptions.map((item) => [item.recurringItemId, item]));
  const unfundedSubscriptions = bufferPlan.unassignedRecurringItemIds
    .map((id) => subscriptionById.get(id))
    .filter((item) => item !== undefined);

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
              return (
                <div key={plan.accountId} className="space-y-2 rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{plan.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.accountSuggestedBuffer}:{" "}
                      <span className="figure">{formatMoney(plan.suggestedBuffer, plan.currency)}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
                  </div>
                  {items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t.accountNoSubscriptionsDue}</p>
                  ) : (
                    items.map((item) => (
                      <SubscriptionRow
                        key={item.recurringItemId}
                        item={item}
                        accounts={accounts}
                        pending={reassigningItemId === item.recurringItemId}
                        onReassign={onReassignSubscription}
                        pickAnAccountLabel={pickAnAccountLabel}
                        t={t}
                      />
                    ))
                  )}
                  {plan.belowBuffer ? (
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
            <Alert variant="destructive">
              <AlertDescription>{t.bufferZeroWarning}</AlertDescription>
            </Alert>
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
        </CardHeader>
        <CardContent className="space-y-3">
          {goals.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noGoalsWithTarget}</p>
          ) : (
            goals.map((goal) => {
              const variance = round2(goal.plannedAmount - goal.recommendedAmount);
              return (
                <div key={goal.goalId} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{goal.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.roadmapAmount}: {formatMoney(goal.recommendedAmount, displayCurrency)}
                      </p>
                    </div>
                    <Field label={`${t.plannedAmount} (${displayCurrency})`}>
                      <AmountInput
                        value={goal.plannedAmount}
                        onChange={(value) => onGoalChange(goal.goalId, value)}
                        ariaLabel={`${t.plannedAmount} - ${goal.name}`}
                      />
                    </Field>
                  </div>
                  <p className={variance >= 0 ? "text-xs text-[var(--good)]" : "text-xs text-[var(--critical)]"}>
                    {variance === 0
                      ? t.goalOnTrack
                      : variance > 0
                        ? t.goalAhead(formatMoney(variance, displayCurrency))
                        : t.goalBehind(formatMoney(Math.abs(variance), displayCurrency))}
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
