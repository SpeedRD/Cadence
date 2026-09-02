"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { StepBalances } from "@/components/payday/step-balances";
import { StepCommitments } from "@/components/payday/step-commitments";
import { StepConfirm } from "@/components/payday/step-confirm";
import { StepFlexible } from "@/components/payday/step-flexible";
import { StepIncome } from "@/components/payday/step-income";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { convert, type RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";
import { round2 } from "@/lib/money";
import { availableForFlexibleCategories } from "@/lib/payday";
import { confirmPaydayCheckinAction } from "@/server/actions/payday";

const STEP_COUNT = 5;

export function PaydayCheckinDialog({
  draft,
  rates,
  locale,
  open,
  onOpenChange,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getDictionary(locale).payday;
  const common = getDictionary(locale).common;
  const [step, setStep] = useState(1);
  const [plan, setPlan] = useState<PaydayCheckinDraft>(draft);
  const [acknowledgedDeficit, setAcknowledgedDeficit] = useState(false);
  const [acknowledgedZeroBuffer, setAcknowledgedZeroBuffer] = useState(false);
  const [state, formAction, pending] = useActionState(confirmPaydayCheckinAction, null);
  const handled = useRef<number | undefined>(undefined);

  // Re-seed from the freshest server-loaded draft every time the dialog
  // opens. Adjusting state during render (rather than in an effect) avoids
  // an extra committed render with stale values - see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPlan(draft);
      setStep(1);
      setAcknowledgedDeficit(false);
      setAcknowledgedZeroBuffer(false);
    }
  }

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? t.checkinConfirmed);
      onOpenChange(false);
    }
  }, [state, onOpenChange, t.checkinConfirmed]);

  const totalIncome = round2(
    plan.accounts.reduce(
      (sum, a) => sum + convert(a.incomeEntered, a.currency, plan.displayCurrency, rates),
      0,
    ),
  );
  // Goal planned amounts are already in plan.displayCurrency (PaydayGoalDraft).
  const goalPlanTotal = round2(plan.goals.reduce((sum, g) => sum + g.plannedAmount, 0));
  const essentialFixedTotal = round2(plan.essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const flexibleTotal = round2(plan.flexibleCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover: plan.includedCarryover,
    subscriptions: plan.subscriptionsTotal,
    recurringContributions: plan.contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: plan.plannedBuffer,
  });
  const needsDeficitAck = available < 0 || flexibleTotal > Math.max(0, available);
  const needsZeroBufferAck = plan.plannedBuffer <= 0;
  const incomeTransactionCount = plan.accounts.filter((a) => a.incomeEntered > 0).length;
  const budgetCount = plan.essentialCategories.length + plan.flexibleCategories.length;
  const allocatedCategoryCount = [...plan.essentialCategories, ...plan.flexibleCategories].filter(
    (c) => c.plannedAmount > 0,
  ).length;
  const stepTitles = [t.step1Title, t.step2Title, t.step3Title, t.step4Title, t.step5Title];

  function updateAccount(accountId: string, patch: Partial<PaydayCheckinDraft["accounts"][number]>) {
    setPlan((prev) => ({
      ...prev,
      accounts: prev.accounts.map((a) => (a.accountId === accountId ? { ...a, ...patch } : a)),
    }));
  }
  function updateGoal(goalId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      goals: prev.goals.map((g) => (g.goalId === goalId ? { ...g, plannedAmount } : g)),
    }));
  }
  function updateEssential(categoryId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      essentialCategories: prev.essentialCategories.map((c) =>
        c.categoryId === categoryId ? { ...c, plannedAmount } : c,
      ),
    }));
  }
  function updateFlexible(categoryId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      flexibleCategories: prev.flexibleCategories.map((c) =>
        c.categoryId === categoryId ? { ...c, plannedAmount } : c,
      ),
    }));
  }

  const canConfirm =
    (!needsDeficitAck || acknowledgedDeficit) && (!needsZeroBufferAck || acknowledgedZeroBuffer);

  const payload = JSON.stringify({
    year: plan.periodRef.year,
    month: plan.periodRef.month,
    period: plan.periodRef.period,
    accounts: plan.accounts.map((a) => ({
      accountId: a.accountId,
      reportedBalance: a.reportedBalance,
      incomeEntered: a.incomeEntered,
      incomeNote: a.incomeNote || null,
    })),
    goals: plan.goals.map((g) => ({ goalId: g.goalId, plannedAmount: g.plannedAmount })),
    essentialCategories: plan.essentialCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.plannedAmount,
    })),
    flexibleCategories: plan.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.plannedAmount,
    })),
    buffer: plan.plannedBuffer,
    includedCarryover: plan.includedCarryover,
    acknowledgedDeficit,
    acknowledgedZeroBuffer,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.wizardTitle(plan.periodLabel)}</DialogTitle>
          <DialogDescription>
            {t.stepOf(step, STEP_COUNT)} · {stepTitles[step - 1]}
          </DialogDescription>
        </DialogHeader>

        <form
          action={formAction}
          className="flex min-h-0 flex-1 flex-col gap-4"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || step >= STEP_COUNT) return;
            if (event.nativeEvent.isComposing) return;
            if ((event.target as HTMLElement).closest("button")) return;
            event.preventDefault();
          }}
        >
          <input type="hidden" name="payload" value={payload} />
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {step === 1 ? (
              <StepBalances
                accounts={plan.accounts}
                onChange={(accountId, reportedBalance) => updateAccount(accountId, { reportedBalance })}
                t={t}
              />
            ) : null}
            {step === 2 ? (
              <StepIncome
                accounts={plan.accounts}
                totalIncome={totalIncome}
                displayCurrency={plan.displayCurrency}
                onChange={updateAccount}
                t={t}
              />
            ) : null}
            {step === 3 ? (
              <StepCommitments
                subscriptions={plan.subscriptions}
                contributions={plan.contributions}
                goals={plan.goals}
                essentialCategories={plan.essentialCategories}
                displayCurrency={plan.displayCurrency}
                bufferFloor={plan.bufferFloor}
                suggestedBuffer={plan.suggestedBuffer}
                plannedBuffer={plan.plannedBuffer}
                availableCarryover={plan.availableCarryover}
                carryoverBasis={plan.carryoverBasis}
                includedCarryover={plan.includedCarryover}
                totalIncome={totalIncome}
                subscriptionsTotal={plan.subscriptionsTotal}
                contributionsTotal={plan.contributionsTotal}
                goalPlanTotal={goalPlanTotal}
                essentialFixedTotal={essentialFixedTotal}
                available={available}
                onGoalChange={updateGoal}
                onEssentialChange={updateEssential}
                onBufferChange={(value) => setPlan((prev) => ({ ...prev, plannedBuffer: value }))}
                onCarryoverChange={(value) =>
                  setPlan((prev) => ({ ...prev, includedCarryover: value }))
                }
                t={t}
              />
            ) : null}
            {step === 4 ? (
              <StepFlexible
                categories={plan.flexibleCategories}
                displayCurrency={plan.displayCurrency}
                available={available}
                daysRemaining={plan.daysRemainingInPlanPeriod}
                onChange={updateFlexible}
                t={t}
              />
            ) : null}
            {step === 5 ? (
              <StepConfirm
                incomeTransactionCount={incomeTransactionCount}
                totalIncome={totalIncome}
                budgetCount={budgetCount}
                allocatedCategoryCount={allocatedCategoryCount}
                displayCurrency={plan.displayCurrency}
                needsDeficitAck={needsDeficitAck}
                acknowledgedDeficit={acknowledgedDeficit}
                onAcknowledgeDeficitChange={setAcknowledgedDeficit}
                needsZeroBufferAck={needsZeroBufferAck}
                acknowledgedZeroBuffer={acknowledgedZeroBuffer}
                onAcknowledgeZeroBufferChange={setAcknowledgedZeroBuffer}
                isEditingConfirmed={plan.isEditingConfirmed}
                formError={state?.error ?? null}
                t={t}
              />
            ) : null}
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <div className="flex gap-2">
              {step > 1 ? (
                <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)}>
                  {t.back}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {common.cancel}
                </Button>
              )}
            </div>
            {step < STEP_COUNT ? (
              <Button type="button" onClick={() => setStep((s) => s + 1)}>
                {t.next}
              </Button>
            ) : (
              <SubmitButton pending={pending} disabled={!canConfirm}>
                {t.confirmPlan}
              </SubmitButton>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
