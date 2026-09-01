"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import {
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  type Option,
} from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FREQUENCY_LABELS,
  RECURRING_FREQUENCIES,
  RECURRING_KINDS,
  RECURRING_KIND_LABELS,
} from "@/lib/labels";
import { saveRecurringAction } from "@/server/actions/recurring";

export interface RecurringFormValues {
  id?: string;
  name?: string;
  amount?: number;
  currency?: string;
  frequency?: string;
  kind?: string;
  nextDate: string;
  categoryId?: string | null;
  note?: string | null;
  active?: boolean;
}

export function RecurringDialog({
  categories,
  values,
  trigger,
  open,
  onOpenChange,
}: {
  categories: Option[];
  values: RecurringFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? "Edit recurring item" : "New recurring item"}
      description="Subscriptions are bills going out. Contributions are money you put into something."
      action={saveRecurringAction}
      submitLabel={editing ? "Save changes" : "Add item"}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <input
        type="hidden"
        name="active"
        value={values.active === false ? "false" : "true"}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" htmlFor="recurring-name" className="col-span-2">
          <Input
            id="recurring-name"
            name="name"
            defaultValue={values.name ?? ""}
            placeholder="Netflix"
            required
          />
        </Field>
        <Field label="Kind">
          <EnumSelect
            name="kind"
            options={RECURRING_KINDS}
            labels={RECURRING_KIND_LABELS}
            defaultValue={values.kind ?? "SUBSCRIPTION"}
          />
        </Field>
        <Field label="Frequency">
          <EnumSelect
            name="frequency"
            options={RECURRING_FREQUENCIES}
            labels={FREQUENCY_LABELS}
            defaultValue={values.frequency ?? "MONTHLY"}
          />
        </Field>
      </div>

      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Amount" htmlFor="recurring-amount">
          <Input
            id="recurring-amount"
            name="amount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            defaultValue={values.amount ?? ""}
            required
          />
        </Field>
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Next due" htmlFor="recurring-next">
          <Input
            id="recurring-next"
            type="date"
            name="nextDate"
            defaultValue={values.nextDate}
            required
          />
        </Field>
        <Field label="Category">
          <CategorySelect
            name="categoryId"
            categories={categories}
            defaultValue={values.categoryId ?? "none"}
          />
        </Field>
      </div>

      <Field label="Note" htmlFor="recurring-note">
        <Textarea
          id="recurring-note"
          name="note"
          rows={2}
          placeholder="Optional"
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
