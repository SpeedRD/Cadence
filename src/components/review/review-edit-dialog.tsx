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
import { updateStagedAction } from "@/server/actions/review";

import type { StagedRow } from "@/lib/data/staged";

export function ReviewEditDialog({
  row,
  accounts,
  categories,
  open,
  onOpenChange,
}: {
  row: StagedRow;
  accounts: Option[];
  categories: Option[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <FormDialog
      title="Edit staged item"
      description="Changes are saved but stay pending until you approve."
      action={updateStagedAction}
      submitLabel="Save"
      cancelLabel="Cancel"
      savedMessage="Saved"
      open={open}
      onOpenChange={onOpenChange}
    >
      <input type="hidden" name="id" value={row.id} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor="staged-date">
          <Input
            id="staged-date"
            type="date"
            name="date"
            defaultValue={toISODate(row.date)}
            required
          />
        </Field>
        <Field label="Currency">
          <CurrencySelect name="currency" defaultValue={row.currency} />
        </Field>
      </div>

      <Field label="Amount" htmlFor="staged-amount">
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

      <Field label="Description" htmlFor="staged-description">
        <Input
          id="staged-description"
          name="rawDescription"
          defaultValue={row.rawDescription}
          maxLength={200}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <AccountSelect
            name="accountId"
            accounts={accounts}
            defaultValue={row.accountId ?? undefined}
          />
        </Field>
        <Field label="Category">
          <CategorySelect
            name="categoryId"
            categories={categories}
            defaultValue={row.suggestedCategoryId ?? "none"}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
