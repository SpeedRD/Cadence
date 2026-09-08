"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { CategorySelect } from "@/components/form/selects";
import { SubmitButton } from "@/components/form/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isUnused, type CategoryRow, type CategoryUsage } from "@/lib/categories";
import { getDictionary, type Locale } from "@/lib/i18n";
import { deleteCategoryAction, reassignCategoryAction } from "@/server/actions/categories";

/**
 * Removing a category is one dialog with two steps. A category nothing is
 * filed under gets a plain confirmation. One still in use gets the
 * reassignment step instead: each kind of row it still owns as its own line
 * with a count (the same grouped-review shape as the CSV import screen), a
 * picker for where the rows go, and one action that moves them and removes
 * the category together. The step is chosen from the counts the page
 * rendered with; if the plain delete comes back saying the category is in
 * use after all, the counts it returns switch the dialog to the second step.
 */
export function CategoryDeleteDialog({
  category,
  categories,
  open,
  onOpenChange,
  locale,
}: {
  category: CategoryRow;
  categories: CategoryRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).settingsPage;
  const common = getDictionary(locale).common;
  const [deleteState, deleteAction, deletePending] = useActionState(deleteCategoryAction, null);
  const [reassignState, reassignAction, reassignPending] = useActionState(
    reassignCategoryAction,
    null,
  );
  // The page's counts decide the step; a plain delete that comes back with
  // counts (the page was stale and the category is in use after all) takes
  // over, moving the dialog to the reassignment step.
  const usage: CategoryUsage = deleteState?.categoryUsage ?? category.usage;
  const reassigning = !isUnused(usage);
  const handledDelete = useRef<number | undefined>(undefined);
  const handledReassign = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!deleteState || deleteState.at === handledDelete.current) return;
    handledDelete.current = deleteState.at;
    if (deleteState.ok) {
      onOpenChange(false);
      toast.success(deleteState.message ?? t.categoryDeleted(category.name));
    }
  }, [deleteState, onOpenChange, t, category.name]);

  useEffect(() => {
    if (!reassignState || reassignState.at === handledReassign.current) return;
    handledReassign.current = reassignState.at;
    if (reassignState.ok) {
      onOpenChange(false);
      toast.success(reassignState.message ?? t.categoryDeleted(category.name));
    }
  }, [reassignState, onOpenChange, t, category.name]);

  const targets = categories.filter(
    (candidate) => candidate.id !== category.id && candidate.kind === category.kind,
  );
  const lines = [
    { key: "transactions", count: usage.transactions, label: t.usageTransactions(usage.transactions), moves: true },
    { key: "recurring", count: usage.recurringItems, label: t.usageRecurringItems(usage.recurringItems), moves: true },
    { key: "budgets", count: usage.budgets, label: t.usageBudgets(usage.budgets), moves: false },
  ].filter((line) => line.count > 0);
  const error = reassigning ? reassignState?.error : deleteState?.error;
  const pending = reassigning ? reassignPending : deletePending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={reassigning ? "sm:max-w-md" : "sm:max-w-sm"}>
        <form action={reassigning ? reassignAction : deleteAction} className="grid gap-5">
          <input type="hidden" name="id" value={category.id} />
          <DialogHeader>
            <DialogTitle>
              {reassigning ? t.reassignTitle(category.name) : t.deleteCategoryTitle(category.name)}
            </DialogTitle>
            <DialogDescription>
              {reassigning ? t.reassignDescription : t.deleteCategoryUnused}
            </DialogDescription>
          </DialogHeader>

          {reassigning ? (
            <div className="grid gap-4">
              <div className="space-y-2">
                {lines.map((line) => (
                  <div
                    key={line.key}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-3"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      {line.label}
                    </span>
                    <Badge variant={line.moves ? "secondary" : "outline"}>
                      {line.moves ? t.willMove : t.willBeCleared}
                    </Badge>
                  </div>
                ))}
                {usage.budgets > 0 ? (
                  <p className="text-xs text-muted-foreground">{t.budgetsClearedHint}</p>
                ) : null}
              </div>

              <Field label={t.moveTo} htmlFor="category-move-to">
                <CategorySelect
                  id="category-move-to"
                  name="moveToId"
                  categories={targets}
                  includeNone={false}
                  common={common}
                />
              </Field>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {common.keepIt}
            </Button>
            <SubmitButton pending={pending} variant="destructive">
              {reassigning ? t.moveAndRemove : t.removeCategory}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
