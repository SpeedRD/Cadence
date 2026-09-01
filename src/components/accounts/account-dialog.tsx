"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { CurrencySelect, EnumSelect } from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS } from "@/lib/labels";
import { saveAccountAction } from "@/server/actions/accounts";

export interface AccountFormValues {
  id?: string;
  name?: string;
  currency?: string;
  type?: string;
}

export function AccountDialog({
  values,
  trigger,
  open,
  onOpenChange,
}: {
  values: AccountFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? "Edit account" : "New account"}
      action={saveAccountAction}
      submitLabel={editing ? "Save changes" : "Add account"}
      cancelLabel="Cancel"
      savedMessage="Saved"
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Field label="Name" htmlFor="account-name">
        <Input
          id="account-name"
          name="name"
          defaultValue={values.name ?? ""}
          placeholder="Everyday checking"
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <EnumSelect
            name="type"
            options={ACCOUNT_TYPES}
            labels={ACCOUNT_TYPE_LABELS}
            defaultValue={values.type ?? "CHECKING"}
          />
        </Field>
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
      </div>
    </FormDialog>
  );
}
