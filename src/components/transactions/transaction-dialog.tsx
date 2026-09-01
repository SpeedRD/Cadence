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
import { TRANSACTION_TYPE_LABELS } from "@/lib/labels";
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
}: {
  accounts: Option[];
  categories: Option[];
  values: TransactionFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? "Edit transaction" : "New transaction"}
      description={
        editing ? undefined : "Logged manually - source stays as Manual."
      }
      action={saveTransactionAction}
      submitLabel={editing ? "Save changes" : "Add transaction"}
      cancelLabel="Cancel"
      savedMessage="Saved"
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <EnumSelect
            name="type"
            options={["EXPENSE", "INCOME"]}
            labels={TRANSACTION_TYPE_LABELS}
            defaultValue={values.type ?? "EXPENSE"}
          />
        </Field>
        <Field label="Date" htmlFor="transaction-date">
          <Input
            id="transaction-date"
            type="date"
            name="date"
            defaultValue={values.date}
            required
          />
        </Field>
      </div>

      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Amount" htmlFor="transaction-amount">
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
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <AccountSelect
            name="accountId"
            accounts={accounts}
            defaultValue={values.accountId ?? accounts[0]?.id}
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

      <Field label="Note" htmlFor="transaction-note">
        <Textarea
          id="transaction-note"
          name="note"
          rows={2}
          placeholder="What was it for?"
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
