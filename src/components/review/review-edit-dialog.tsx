"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  type Option,
} from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { updateStagedAction } from "@/server/actions/review";

import type { StagedRow } from "@/lib/data/staged";

export function ReviewEditDialog({
  row,
  accounts,
  categories,
  open,
  onOpenChange,
  locale,
}: {
  row: StagedRow;
  accounts: Option[];
  categories: Option[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).review;
  const common = getDictionary(locale).common;
  return (
    <FormDialog
      title={t.editStagedTitle}
      description={t.editStagedDescription}
      action={updateStagedAction}
      submitLabel={common.save}
      cancelLabel={common.cancel}
      savedMessage={t.stagedSaved}
      open={open}
      onOpenChange={onOpenChange}
    >
      <input type="hidden" name="id" value={row.id} />

      <div className="grid grid-cols-2 gap-3">
        <Field label={common.date} htmlFor="staged-date">
          <Input
            id="staged-date"
            type="date"
            name="date"
            defaultValue={toISODate(row.date)}
            required
          />
        </Field>
        <Field label={common.currency}>
          <CurrencySelect name="currency" defaultValue={row.currency} />
        </Field>
      </div>

      <Field label={common.amount} htmlFor="staged-amount">
        <Input
          id="staged-amount"
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          className="font-mono"
          defaultValue={row.amount}
          required
        />
      </Field>

      <Field label={common.description} htmlFor="staged-description">
        <Input
          id="staged-description"
          name="rawDescription"
          defaultValue={row.rawDescription}
          maxLength={200}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={common.account}>
          <AccountSelect
            name="accountId"
            accounts={accounts}
            defaultValue={row.accountId ?? undefined}
            common={common}
          />
        </Field>
        <Field label={common.category}>
          <CategorySelect
            name="categoryId"
            categories={categories}
            defaultValue={row.suggestedCategoryId ?? "none"}
            common={common}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
