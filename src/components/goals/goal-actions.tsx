"use client";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import { GoalDialog } from "@/components/goals/goal-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteGoalAction, deleteContributionAction } from "@/server/actions/goals";

export function GoalActions({
  goal,
  redirectAfterDelete = false,
}: {
  goal: {
    id: string;
    name: string;
    targetAmount: number;
    currency: string;
    targetDate: string | null;
  };
  redirectAfterDelete?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${goal.name}`}>
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <GoalDialog
          open
          onOpenChange={(next) => !next && setEditing(false)}
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
          title={`Delete ${goal.name}?`}
          description={
            redirectAfterDelete
              ? "The goal and its contribution history are removed."
              : "Its contribution history goes with it."
          }
          confirmLabel="Delete"
          keepLabel="Keep it"
          deletedMessage="Deleted"
        />
      ) : null}
    </>
  );
}

export function ContributionDeleteButton({
  id,
  amount,
}: {
  id: string;
  amount: string;
}) {
  return (
    <ConfirmDelete
      id={id}
      action={deleteContributionAction}
      title="Remove this contribution?"
      description={`${amount} comes back off the goal's progress.`}
      confirmLabel="Delete"
      keepLabel="Keep it"
      deletedMessage="Deleted"
      trigger={
        <Button variant="ghost" size="icon-xs" aria-label="Remove contribution">
          <Trash2 className="size-3.5" />
        </Button>
      }
    />
  );
}
