"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { CurrencySelect } from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { saveGoalAction } from "@/server/actions/goals";

export interface GoalFormValues {
  id?: string;
  name?: string;
  targetAmount?: number;
  currency?: string;
  targetDate?: string | null;
}

export function GoalDialog({
  values,
  trigger,
  open,
  onOpenChange,
  locale,
}: {
  values: GoalFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? t.editGoal : t.newGoal}
      description={t.goalDialogDescription}
      action={saveGoalAction}
      submitLabel={editing ? t.saveChanges : t.createGoal}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.goalUpdated : t.goalCreated}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Field label={common.name} htmlFor="goal-name">
        <Input
          id="goal-name"
          name="name"
          defaultValue={values.name ?? ""}
          placeholder={t.namePlaceholder}
          required
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={t.targetAmount} htmlFor="goal-target">
          <Input
            id="goal-target"
            name="targetAmount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            defaultValue={values.targetAmount ?? ""}
            required
          />
        </Field>
        <Field label={common.currency} htmlFor="goal-currency">
          <CurrencySelect id="goal-currency" name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <Field
        label={t.targetDateLabel}
        htmlFor="goal-date"
        hint={t.targetDateHint}
      >
        <Input
          id="goal-date"
          type="date"
          name="targetDate"
          defaultValue={values.targetDate ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
