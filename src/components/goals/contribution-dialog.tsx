"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { markGoalAchieved } from "@/components/goals/goal-achieved";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getDictionary, type Locale } from "@/lib/i18n";
import { addContributionAction } from "@/server/actions/goals";

/** Contributions are recorded in the goal's own currency. */
export function ContributionDialog({
  goalId,
  goalName,
  currency,
  defaultDate,
  trigger,
  locale,
}: {
  goalId: string;
  goalName: string;
  currency: string;
  defaultDate: string;
  trigger: React.ReactNode;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;

  return (
    <FormDialog
      title={t.addTo(goalName)}
      description={t.contributionDialogDescription}
      action={addContributionAction}
      submitLabel={t.logContribution}
      cancelLabel={common.cancel}
      savedMessage={t.contributionLogged}
      trigger={trigger}
      onSuccess={(state) => {
        // Only ever set on the contribution that crossed the target.
        if (state.achievedGoalId) markGoalAchieved(state.achievedGoalId);
      }}
    >
      <input type="hidden" name="goalId" value={goalId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.amountWithCurrency(currency)} htmlFor="contribution-amount">
          <Input
            id="contribution-amount"
            name="amount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            required
          />
        </Field>
        <Field label={common.date} htmlFor="contribution-date">
          <Input
            id="contribution-date"
            type="date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </Field>
      </div>

      <Field label={common.note} htmlFor="contribution-note">
        <Textarea
          id="contribution-note"
          name="note"
          rows={2}
          placeholder={common.optional}
        />
      </Field>
    </FormDialog>
  );
}
