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
import { getDictionary, type Locale } from "@/lib/i18n";
import { RECURRING_FREQUENCIES, RECURRING_KINDS } from "@/lib/labels";
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
  locale,
}: {
  categories: Option[];
  values: RecurringFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const editing = Boolean(values.id);
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;

  return (
    <FormDialog
      title={editing ? t.editItem : t.newItemTitle}
      description={t.itemDescription}
      action={saveRecurringAction}
      submitLabel={editing ? t.saveChanges : t.addItem}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.itemUpdated : t.itemAdded}
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.name} htmlFor="recurring-name" className="sm:col-span-2">
          <Input
            id="recurring-name"
            name="name"
            defaultValue={values.name ?? ""}
            placeholder={t.namePlaceholder}
            required
          />
        </Field>
        <Field label={t.kind} htmlFor="recurring-kind">
          <EnumSelect
            id="recurring-kind"
            name="kind"
            options={RECURRING_KINDS}
            labels={common.recurringKindLabels}
            defaultValue={values.kind ?? "SUBSCRIPTION"}
          />
        </Field>
        <Field label={t.frequency} htmlFor="recurring-frequency">
          <EnumSelect
            id="recurring-frequency"
            name="frequency"
            options={RECURRING_FREQUENCIES}
            labels={common.frequencyLabels}
            defaultValue={values.frequency ?? "MONTHLY"}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={common.amount} htmlFor="recurring-amount">
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
        <Field label={common.currency} htmlFor="recurring-currency">
          <CurrencySelect id="recurring-currency" name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.nextDue} htmlFor="recurring-next">
          <Input
            id="recurring-next"
            type="date"
            name="nextDate"
            defaultValue={values.nextDate}
            required
          />
        </Field>
        <Field label={common.category} htmlFor="recurring-category">
          <CategorySelect
            id="recurring-category"
            name="categoryId"
            categories={categories}
            defaultValue={values.categoryId ?? "none"}
            common={common}
          />
        </Field>
      </div>

      <Field label={common.note} htmlFor="recurring-note">
        <Textarea
          id="recurring-note"
          name="note"
          rows={2}
          placeholder={common.optional}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
