"use client";

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
}

export function TransactionDialog({
  accounts,
  categories,
  values,
  trigger,
  open,
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
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.type} htmlFor="transaction-type">
          <EnumSelect
            id="transaction-type"
            name="type"
            options={["EXPENSE", "INCOME"]}
            labels={common.transactionTypeLabels}
            defaultValue={values.type ?? "EXPENSE"}
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
        <Field label={common.category} htmlFor="transaction-category">
          <CategorySelect
            id="transaction-category"
            name="categoryId"
            categories={categories}
            defaultValue={values.categoryId ?? "none"}
            common={common}
          />
        </Field>
      </div>

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
