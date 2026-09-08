"use client";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { GoalDialog } from "@/components/goals/goal-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  deleteGoalAction,
  deleteContributionAction,
  updateRecurringContributionAction,
} from "@/server/actions/goals";

/** The only destination deleteGoalAction will redirect to; see that action. */
export const GOALS_LIST_PATH = "/goals";

export function GoalActions({
  goal,
  redirectAfterDelete = false,
  locale,
}: {
  goal: {
    id: string;
    name: string;
    targetAmount: number;
    currency: string;
    targetDate: string | null;
  };
  redirectAfterDelete?: boolean;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t.actionsFor(goal.name)}>
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            {common.edit}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 className="size-3.5" />
            {common.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <GoalDialog
          open
          onOpenChange={(next) => !next && setEditing(false)}
          locale={locale}
          values={{
            id: goal.id,
            name: goal.name,
            targetAmount: goal.targetAmount,
            currency: goal.currency,
            targetDate: goal.targetDate,
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDelete
          open
          onOpenChange={(next) => !next && setDeleting(false)}
          id={goal.id}
          action={deleteGoalAction}
          title={t.deleteGoalTitle(goal.name)}
          description={
            redirectAfterDelete
              ? t.goalAndHistoryRemoved
              : t.historyGoesWithIt
          }
          confirmLabel={common.delete}
          keepLabel={common.keepIt}
          deletedMessage={t.goalDeleted}
          // The detail page belongs to the goal just removed: the action sends
          // the user to the list instead of leaving this page to 404 on its
          // next render (a client-side push would run too late - the
          // revalidated 404 replaces this dialog before its effect fires).
          fields={redirectAfterDelete ? { redirectTo: GOALS_LIST_PATH } : undefined}
        />
      ) : null}
    </>
  );
}

export function ContributionDeleteButton({
  id,
  amount,
  locale,
}: {
  id: string;
  amount: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;

  return (
    <ConfirmDelete
      id={id}
      action={deleteContributionAction}
      title={t.removeContributionTitle}
      description={t.comesOffProgress(amount)}
      confirmLabel={common.delete}
      keepLabel={common.keepIt}
      deletedMessage={t.contributionRemoved}
      trigger={
        <Button variant="ghost" size="icon-xs" aria-label={t.removeContributionAria}>
          <Trash2 className="size-3.5" />
        </Button>
      }
    />
  );
}

/**
 * Corrects one contribution recurring posting wrote (its amount, in the
 * goal's currency) together with the ledger row beside it. Manual
 * contributions are not edited this way: they are removed and logged again.
 */
export function ContributionEditButton({
  id,
  amount,
  currency,
  locale,
}: {
  id: string;
  amount: number;
  currency: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;

  return (
    <FormDialog
      title={t.editContributionTitle}
      description={t.editContributionDescription}
      action={updateRecurringContributionAction}
      submitLabel={common.save}
      cancelLabel={common.cancel}
      savedMessage={t.contributionUpdated}
      trigger={
        <Button variant="ghost" size="icon-xs" aria-label={t.editContributionAria}>
          <Pencil className="size-3.5" />
        </Button>
      }
    >
      <input type="hidden" name="id" value={id} />
      <Field label={t.amountWithCurrency(currency)} htmlFor={`contribution-amount-${id}`}>
        <Input
          id={`contribution-amount-${id}`}
          name="amount"
          inputMode="decimal"
          className="font-mono"
          defaultValue={amount}
          required
        />
      </Field>
    </FormDialog>
  );
}
