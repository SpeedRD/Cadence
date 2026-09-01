"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { CurrencySelect } from "@/components/form/selects";
import { Input } from "@/components/ui/input";
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
}: {
  values: GoalFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? "Edit goal" : "New goal"}
      description="A target date turns the goal into a per-pay-period number."
      action={saveGoalAction}
      submitLabel={editing ? "Save changes" : "Create goal"}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Field label="Name" htmlFor="goal-name">
        <Input
          id="goal-name"
          name="name"
          defaultValue={values.name ?? ""}
          placeholder="Emergency fund"
          required
        />
      </Field>

      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Target amount" htmlFor="goal-target">
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
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <Field
        label="Target date"
        htmlFor="goal-date"
        hint="Optional. Without one, Cadence projects from your pace."
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
