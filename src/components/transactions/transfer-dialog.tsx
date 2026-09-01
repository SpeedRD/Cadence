"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import {
  AccountSelect,
  CurrencySelect,
  type Option,
} from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getDictionary, type Locale } from "@/lib/i18n";
import { saveTransferAction } from "@/server/actions/transactions";

export interface TransferFormValues {
  transferId?: string;
  date: string;
  amount?: number;
  currency?: string;
  fromAccountId?: string;
  toAccountId?: string;
  note?: string | null;
}

/** Writes both legs of the transfer in one database transaction. */
export function TransferDialog({
  accounts,
  values,
  trigger,
  open,
  onOpenChange,
  locale,
}: {
  accounts: Option[];
  values: TransferFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const editing = Boolean(values.transferId);

  return (
    <FormDialog
      title={editing ? t.editTransfer : t.moveMoney}
      description={t.transferDescription}
      action={saveTransferAction}
      submitLabel={editing ? t.saveChanges : t.recordTransfer}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.transferUpdated : t.transferRecorded}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.transferId ? (
        <input type="hidden" name="transferId" value={values.transferId} />
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label={t.from}>
          <AccountSelect
            name="fromAccountId"
            accounts={accounts}
            defaultValue={values.fromAccountId ?? accounts[0]?.id}
            common={common}
          />
        </Field>
        <Field label={t.to}>
          <AccountSelect
            name="toAccountId"
            accounts={accounts}
            defaultValue={values.toAccountId ?? accounts[1]?.id}
            common={common}
          />
        </Field>
      </div>

      <div className="grid grid-cols-[1fr_110px_150px] gap-3">
        <Field label={common.amount} htmlFor="transfer-amount">
          <Input
            id="transfer-amount"
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            className="font-mono"
            defaultValue={values.amount ?? ""}
            required
          />
        </Field>
        <Field label={common.currency}>
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
        <Field label={common.date} htmlFor="transfer-date">
          <Input
            id="transfer-date"
            type="date"
            name="date"
            defaultValue={values.date}
            required
          />
        </Field>
      </div>

      <Field label={common.note} htmlFor="transfer-note">
        <Textarea
          id="transfer-note"
          name="note"
          rows={2}
          placeholder={common.optional}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
