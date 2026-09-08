"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { correctStartingBalanceAction } from "@/server/actions/accounts";

/**
 * The guided path once an account's opening balance is locked by history:
 * the amount that was already in the account, recorded as an incoming
 * external transfer dated at the start (see correctStartingBalance).
 */
export function StartingBalanceCorrectionDialog({
  accountId,
  accountName,
  currency,
  date,
  open,
  onOpenChange,
  locale,
}: {
  accountId: string;
  accountName: string;
  currency: string;
  date: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;

  return (
    <FormDialog
      title={t.correctStartingBalanceTitle(accountName)}
      description={t.correctStartingBalanceDescription}
      action={correctStartingBalanceAction}
      submitLabel={t.correctStartingBalance}
      cancelLabel={common.cancel}
      savedMessage={t.startingBalanceCorrected}
      open={open}
      onOpenChange={onOpenChange}
    >
      <input type="hidden" name="accountId" value={accountId} />

      <Field
        label={t.correctionAmountLabel(currency)}
        htmlFor="starting-balance-amount"
        hint={t.correctionAmountHint}
      >
        <Input
          id="starting-balance-amount"
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          className="font-mono"
          required
        />
      </Field>

      <Field label={t.openingBalanceDateLabel} htmlFor="starting-balance-date" hint={t.correctionDateHint}>
        <Input id="starting-balance-date" type="date" name="date" defaultValue={date} required />
      </Field>
    </FormDialog>
  );
}
