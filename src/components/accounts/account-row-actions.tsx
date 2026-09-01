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
import { getDictionary, type Locale } from "@/lib/i18n";
import { deleteAccountAction } from "@/server/actions/accounts";

export function AccountRowActions({
  account,
  locale,
}: {
  account: {
    id: string;
    name: string;
    type: string;
    currency: string;
    transactionCount: number;
  };
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t.actionsFor(account.name)}>
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
        <AccountDialog
          open
          onOpenChange={(next) => !next && setEditing(false)}
          locale={locale}
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
          title={t.deleteAccountTitle(account.name)}
          description={
            account.transactionCount > 0
              ? t.transactionsGoWithIt(account.transactionCount)
              : t.noTransactions
          }
          confirmLabel={common.delete}
          keepLabel={common.keepIt}
          deletedMessage={t.accountDeleted}
        />
      ) : null}
    </>
  );
}
