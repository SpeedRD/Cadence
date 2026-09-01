"use client";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { ConfirmDelete } from "@/components/form/confirm-delete";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteAccountAction } from "@/server/actions/accounts";

export function AccountRowActions({
  account,
}: {
  account: {
    id: string;
    name: string;
    type: string;
    currency: string;
    transactionCount: number;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${account.name}`}>
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
        <AccountDialog
          open
          onOpenChange={(next) => !next && setEditing(false)}
          values={{
            id: account.id,
            name: account.name,
            type: account.type,
            currency: account.currency,
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDelete
          open
          onOpenChange={(next) => !next && setDeleting(false)}
          id={account.id}
          action={deleteAccountAction}
          title={`Delete ${account.name}?`}
          description={
            account.transactionCount > 0
              ? `Its ${account.transactionCount} transaction${account.transactionCount === 1 ? "" : "s"} go with it, including both sides of any transfers.`
              : "This account has no transactions."
          }
          confirmLabel="Delete"
          keepLabel="Keep it"
          deletedMessage="Deleted"
        />
      ) : null}
    </>
  );
}
