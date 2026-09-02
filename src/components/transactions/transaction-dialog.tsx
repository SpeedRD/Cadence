"use client";

import { useState } from "react";

import { FormDialog } from "@/components/form/form-dialog";
import { Field } from "@/components/form/field";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  type Option,
} from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getDictionary, type Locale } from "@/lib/i18n";
import { saveTransactionAction } from "@/server/actions/transactions";

export interface TransactionFormValues {
  id?: string;
  date: string;
  amount?: number;
  currency?: string;
  type?: string;
  accountId?: string;
  categoryId?: string | null;
  note?: string | null;
  transferDirection?: string | null;
}

export function TransactionDialog({
  accounts,
  categories,
  values,
  trigger,
  open: controlledOpen,
  onOpenChange,
  locale,
}: {
  accounts: Option[];
  categories: Option[];
  values: TransactionFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const editing = Boolean(values.id);
  const [type, setType] = useState(values.type ?? "EXPENSE");
  const isExternalTransfer = type === "EXTERNAL_TRANSFER";

  // Mirrors FormDialog's own controlled/uncontrolled resolution so this
  // component can see the effective open state even for the "New
  // transaction" trigger, which never passes `open`/`onOpenChange` and so
  // is uncontrolled from here down.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  // The "New transaction" dialog is a single long-lived instance (the page
  // only mounts it once), so this component's own state does NOT reset
  // just because the dialog closes. The Type <Select> below is uncontrolled
  // and DOES get remounted (and visually reset to its defaultValue) each
  // time Radix re-opens the dialog's content. Without this, cancelling out
  // of an External transfer selection and reopening the dialog left `type`
  // stuck at EXTERNAL_TRANSFER while the Select visibly showed "Expense"
  // again - hiding the category field and silently forcing categoryId to
  // null on the next save. Reset `type` in lockstep with the same open
  // transition that resets the Select - adjusted during render (React's
  // documented pattern for this), not in an effect, to avoid an extra
  // render pass.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setType(values.type ?? "EXPENSE");
    }
  }

  return (
    <FormDialog
      title={editing ? t.editTransaction : t.newTransaction}
      description={
        editing ? undefined : t.manualDescription
      }
      action={saveTransactionAction}
      submitLabel={editing ? t.saveChanges : t.addTransaction}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.transactionUpdated : t.transactionAdded}
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.type} htmlFor="transaction-type">
          <EnumSelect
            id="transaction-type"
            name="type"
            options={["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]}
            labels={common.transactionTypeLabels}
            defaultValue={values.type ?? "EXPENSE"}
            onValueChange={setType}
          />
        </Field>
        <Field label={common.date} htmlFor="transaction-date">
          <Input
            id="transaction-date"
            type="date"
            name="date"
            defaultValue={values.date}
            required
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={common.amount} htmlFor="transaction-amount">
          <Input
            id="transaction-amount"
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            className="font-mono"
            defaultValue={values.amount ?? ""}
            required
          />
        </Field>
        <Field label={common.currency} htmlFor="transaction-currency">
          <CurrencySelect id="transaction-currency" name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.account} htmlFor="transaction-account">
          <AccountSelect
            id="transaction-account"
            name="accountId"
            accounts={accounts}
            defaultValue={values.accountId ?? accounts[0]?.id}
            common={common}
          />
        </Field>
        {isExternalTransfer ? (
          <Field label={t.direction} htmlFor="transaction-direction">
            <EnumSelect
              id="transaction-direction"
              name="transferDirection"
              options={["OUT", "IN"]}
              labels={{ OUT: t.directionOut, IN: t.directionIn }}
              defaultValue={values.transferDirection ?? "OUT"}
            />
          </Field>
        ) : (
          <Field label={common.category} htmlFor="transaction-category">
            <CategorySelect
              id="transaction-category"
              name="categoryId"
              categories={categories}
              defaultValue={values.categoryId ?? "none"}
              common={common}
            />
          </Field>
        )}
      </div>

      {/* categoryId is always submitted, even when the category field is
          hidden for EXTERNAL_TRANSFER - transactionSchema forces it to null
          for that type either way, but the field must still be present in
          the FormData or validation rejects the row as missing categoryId. */}
      {isExternalTransfer ? <input type="hidden" name="categoryId" value="none" /> : null}

      <Field label={common.note} htmlFor="transaction-note">
        <Textarea
          id="transaction-note"
          name="note"
          rows={2}
          placeholder={t.notePlaceholder}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
