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
}: {
  accounts: Option[];
  values: TransferFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const editing = Boolean(values.transferId);

  return (
    <FormDialog
      title={editing ? "Edit transfer" : "Move money"}
      description="Between your own accounts. Transfers never count as income or spending."
      action={saveTransferAction}
      submitLabel={editing ? "Save changes" : "Record transfer"}
      cancelLabel="Cancel"
      savedMessage="Saved"
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.transferId ? (
        <input type="hidden" name="transferId" value={values.transferId} />
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <AccountSelect
            name="fromAccountId"
            accounts={accounts}
            defaultValue={values.fromAccountId ?? accounts[0]?.id}
          />
        </Field>
        <Field label="To">
          <AccountSelect
            name="toAccountId"
            accounts={accounts}
            defaultValue={values.toAccountId ?? accounts[1]?.id}
          />
        </Field>
      </div>

      <div className="grid grid-cols-[1fr_110px_150px] gap-3">
        <Field label="Amount" htmlFor="transfer-amount">
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
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
        <Field label="Date" htmlFor="transfer-date">
          <Input
            id="transfer-date"
            type="date"
            name="date"
            defaultValue={values.date}
            required
          />
        </Field>
      </div>

      <Field label="Note" htmlFor="transfer-note">
        <Textarea
          id="transfer-note"
          name="note"
          rows={2}
          placeholder="Optional"
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
