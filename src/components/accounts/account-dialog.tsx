"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { CurrencySelect, EnumSelect } from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { ACCOUNT_TYPES } from "@/lib/labels";
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
  locale,
}: {
  values: AccountFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const editing = Boolean(values.id);

  return (
    <FormDialog
      title={editing ? t.editAccount : t.newAccountTitle}
      action={saveAccountAction}
      submitLabel={editing ? t.saveChanges : t.addAccount}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.accountUpdated : t.accountAdded}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <Field label={common.name} htmlFor="account-name">
        <Input
          id="account-name"
          name="name"
          defaultValue={values.name ?? ""}
          placeholder={t.namePlaceholder}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={common.type}>
          <EnumSelect
            name="type"
            options={ACCOUNT_TYPES}
            labels={common.accountTypeLabels}
            defaultValue={values.type ?? "CHECKING"}
          />
        </Field>
        <Field label={common.currency}>
          <CurrencySelect name="currency" defaultValue={values.currency} />
        </Field>
      </div>
    </FormDialog>
  );
}
