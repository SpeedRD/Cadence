"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { setOpeningBalanceAction } from "@/server/actions/accounts";

export function OpeningBalanceDialog({
  accountId,
  accountName,
  amount,
  date,
  open,
  onOpenChange,
  locale,
}: {
  accountId: string;
  accountName: string;
  amount?: number;
  date: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const editing = amount !== undefined;

  return (
    <FormDialog
      title={t.openingBalanceDialogTitle(accountName)}
      description={t.openingBalanceDialogDescription}
      action={setOpeningBalanceAction}
      submitLabel={editing ? t.saveChanges : t.setOpeningBalance}
      cancelLabel={common.cancel}
      savedMessage={t.openingBalanceSaved}
      open={open}
      onOpenChange={onOpenChange}
    >
      <input type="hidden" name="accountId" value={accountId} />

      <Field label={t.openingBalanceAmountLabel} htmlFor="opening-balance-amount">
        <Input
          id="opening-balance-amount"
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          className="font-mono"
          defaultValue={amount ?? ""}
          required
        />
      </Field>

      <Field label={t.openingBalanceDateLabel} htmlFor="opening-balance-date">
        <Input id="opening-balance-date" type="date" name="date" defaultValue={date} required />
      </Field>
    </FormDialog>
  );
}
