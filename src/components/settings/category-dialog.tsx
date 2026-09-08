"use client";

import { useState } from "react";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { EnumSelect } from "@/components/form/selects";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { CATEGORY_KINDS, labelFor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { saveCategoryAction } from "@/server/actions/categories";

/** The seed palette, offered as one-click swatches beside the free picker. */
const PALETTE = [
  "#199e70",
  "#d95926",
  "#3987e5",
  "#7c5cff",
  "#d55181",
  "#c98500",
  "#e66767",
  "#0f9d9d",
  "#7a8590",
  "#008300",
] as const;

export interface CategoryFormValues {
  id?: string;
  name?: string;
  kind?: string;
  color?: string;
  /** Transactions filed under the category; a kind change is refused while any exist. */
  transactionCount?: number;
}

export function CategoryDialog({
  values,
  trigger,
  open,
  onOpenChange,
  locale,
}: {
  values: CategoryFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const editing = Boolean(values.id);
  const t = getDictionary(locale).settingsPage;
  const common = getDictionary(locale).common;
  const kind = values.kind ?? "EXPENSE";
  const kindLocked = editing && (values.transactionCount ?? 0) > 0;
  const [color, setColor] = useState(values.color ?? PALETTE[0]);

  // Reset the swatch state each time the dialog opens, mirroring the
  // uncontrolled inputs which remount with their defaultValue.
  const [wasOpen, setWasOpen] = useState(open ?? false);
  if (open !== undefined && open !== wasOpen) {
    setWasOpen(open);
    if (open) setColor(values.color ?? PALETTE[0]);
  }

  return (
    <FormDialog
      title={editing ? t.editCategory : t.newCategory}
      action={saveCategoryAction}
      submitLabel={editing ? t.saveCategory : t.addCategory}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.categoryUpdated(values.name ?? "") : t.categoryCreated("")}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <input type="hidden" name="color" value={color} />

      <Field
        label={common.name}
        htmlFor="category-name"
        hint={editing ? t.renameHint : undefined}
      >
        <Input
          id="category-name"
          name="name"
          defaultValue={values.name ?? ""}
          placeholder={t.categoryNamePlaceholder}
          maxLength={40}
          required
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t.categoryKind}
          htmlFor="category-kind"
          hint={kindLocked ? t.kindLockedHint(values.transactionCount ?? 0) : undefined}
        >
          {kindLocked ? (
            <>
              {/* A disabled select submits nothing, so the kind travels as a
                  hidden field and the row shows what it is fixed to. */}
              <input type="hidden" name="kind" value={kind} />
              <div id="category-kind" className="flex h-9 items-center">
                <Badge variant="outline">{labelFor(common.categoryKindLabels, kind)}</Badge>
              </div>
            </>
          ) : (
            <EnumSelect
              id="category-kind"
              name="kind"
              options={CATEGORY_KINDS}
              labels={common.categoryKindLabels}
              defaultValue={kind}
            />
          )}
        </Field>

        <Field label={t.categoryColor} htmlFor="category-color">
          <div className="flex flex-wrap items-center gap-1.5">
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                aria-pressed={color === swatch}
                onClick={() => setColor(swatch)}
                className={cn(
                  "size-6 rounded-full border-2 transition-transform hover:scale-110",
                  color === swatch ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
            <input
              id="category-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="size-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
            />
          </div>
        </Field>
      </div>
    </FormDialog>
  );
}
