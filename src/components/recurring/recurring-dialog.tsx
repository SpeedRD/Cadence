"use client";

import { useState } from "react";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  GoalSelect,
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
  accountId?: string | null;
  goalId?: string | null;
  note?: string | null;
  active?: boolean;
}

export function RecurringDialog({
  categories,
  accounts,
  goals = [],
  values,
  trigger,
  open: controlledOpen,
  onOpenChange,
  locale,
}: {
  categories: Option[];
  accounts: Option[];
  /** Optional only for callers that can only ever create a subscription. */
  goals?: Option[];
  values: RecurringFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const editing = Boolean(values.id);
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;
  const [kind, setKind] = useState(values.kind ?? "SUBSCRIPTION");
  const isContribution = kind === "CONTRIBUTION";

  // Same controlled/uncontrolled resolution and reset-on-open dance as
  // TransactionDialog: the Kind <Select> is uncontrolled and remounts (back to
  // its defaultValue) every time the dialog re-opens, so `kind` must be reset
  // in lockstep or a cancelled "Contribution" pick would keep the goal field
  // showing while the Select says "Subscription".
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKind(values.kind ?? "SUBSCRIPTION");
  }

  // An existing item whose link is missing (or points at an account that is no
  // longer active) must show up as unset, never quietly fall back to the first
  // option - that is how the user notices it is not posting. Only a brand-new
  // item gets the first account as a convenience; a goal is always an
  // explicit choice.
  const knownAccount = accounts.some((account) => account.id === values.accountId);
  const accountDefault = knownAccount
    ? (values.accountId ?? undefined)
    : editing
      ? undefined
      : accounts[0]?.id;
  const goalDefault = goals.some((goal) => goal.id === values.goalId)
    ? (values.goalId ?? undefined)
    : undefined;

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
      onOpenChange={setOpen}
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
            onValueChange={setKind}
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
        <Field label={t.nextDue} htmlFor="recurring-next" hint={t.nextDueHint}>
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.account} htmlFor="recurring-account" hint={t.accountHint}>
          <AccountSelect
            id="recurring-account"
            name="accountId"
            accounts={accounts}
            defaultValue={accountDefault}
            common={common}
          />
        </Field>
        {isContribution ? (
          <Field
            label={t.goal}
            htmlFor="recurring-goal"
            hint={goals.length === 0 ? t.noGoalsYet : t.goalHint}
          >
            <GoalSelect
              id="recurring-goal"
              name="goalId"
              goals={goals}
              defaultValue={goalDefault}
              common={common}
            />
          </Field>
        ) : null}
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
