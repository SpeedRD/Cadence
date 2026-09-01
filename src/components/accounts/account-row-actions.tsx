"use client";

import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
import {
  archiveAccountAction,
  deleteAccountAction,
  restoreAccountAction,
} from "@/server/actions/accounts";

export function AccountRowActions({
  account,
  locale,
}: {
  account: {
    id: string;
    name: string;
    type: string;
    status: string;
    currency: string;
    transactionCount: number;
  };
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isArchived = account.status === "ARCHIVED";

  async function runLifecycleAction(
    action: (state: null, formData: FormData) => Promise<{ ok: boolean; error?: string; message?: string } | null>,
    fallbackMessage: string,
  ) {
    const form = new FormData();
    form.set("id", account.id);
    const result = await action(null, form);
    if (result?.ok) toast.success(result.message ?? fallbackMessage);
    else if (result?.error) toast.error(result.error);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t.actionsFor(account.name)}>
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isArchived ? (
            <DropdownMenuItem
              onSelect={() => runLifecycleAction(restoreAccountAction, t.accountRestored)}
            >
              <ArchiveRestore className="size-3.5" />
              {t.restoreAccount}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                {common.edit}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => runLifecycleAction(archiveAccountAction, t.accountArchived)}
              >
                <Archive className="size-3.5" />
                {t.archiveAccount}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 className="size-3.5" />
            {isArchived ? t.deletePermanently : common.delete}
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
          confirmLabel={isArchived ? t.deletePermanently : common.delete}
          keepLabel={common.keepIt}
          deletedMessage={t.accountDeleted}
        />
      ) : null}
    </>
  );
}
