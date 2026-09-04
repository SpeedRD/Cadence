"use client";

import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import type { Option } from "@/components/form/selects";
import { RecurringDialog } from "@/components/recurring/recurring-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatMoney } from "@/lib/currency";
import { formatDate, formatRelativeDays, toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";
import {
  deleteRecurringAction,
  toggleRecurringAction,
} from "@/server/actions/recurring";
import { cn } from "@/lib/utils";

import type { RecurringRow } from "@/lib/data/recurring";

export function RecurringList({
  rows,
  categories,
  accounts,
  goals,
  displayCurrency,
  today,
  locale,
}: {
  rows: RecurringRow[];
  categories: Option[];
  accounts: Option[];
  goals: Option[];
  displayCurrency: string;
  today: Date;
  locale: Locale;
}) {
  const [editing, setEditing] = useState<RecurringRow | null>(null);
  const [deleting, setDeleting] = useState<RecurringRow | null>(null);
  const [togglePending, startTransition] = useTransition();
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;

  const toggle = (row: RecurringRow) => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", row.id);
      const result = await toggleRecurringAction(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
    });
  };

  return (
    <>
      <ul className="divide-y divide-border/70">
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(
              "flex items-center gap-3 py-3 first:pt-0 last:pb-0",
              !row.active && "opacity-55",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{row.name}</span>
                {!row.active ? (
                  <span className="rounded-full bg-foreground/8 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                    {t.paused}
                  </span>
                ) : null}
                {row.active && row.needs ? (
                  <span
                    className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-destructive"
                    title={t.needsHint}
                  >
                    {row.needs === "account" ? t.needsAccount : t.needsGoal}
                  </span>
                ) : null}
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                {labelFor(common.frequencyLabels, row.frequency)} · {t.nextLabel}{" "}
                {formatDate(row.nextDate)}
                {row.active ? ` (${formatRelativeDays(today, row.nextDate, common)})` : ""}
                {row.categoryName ? ` · ${row.categoryName}` : ""}
                {row.accountName ? ` · ${row.accountName}` : ""}
                {row.goalName ? ` · ${row.goalName}` : ""}
              </p>
            </div>

            <div className="text-right">
              <p className="figure text-sm">
                {formatMoney(row.displayAmount, displayCurrency)}
              </p>
              {row.currency !== displayCurrency ? (
                <p className="figure figure-sm text-[0.6875rem] text-muted-foreground">
                  {formatMoney(row.amount, row.currency)}
                </p>
              ) : null}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t.actionsFor(row.name)}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(row)}>
                  <Pencil className="size-3.5" />
                  {common.edit}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={togglePending} onSelect={() => toggle(row)}>
                  {row.active ? (
                    <>
                      <Pause className="size-3.5" />
                      {t.pause}
                    </>
                  ) : (
                    <>
                      <Play className="size-3.5" />
                      {t.resume}
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleting(row)}
                >
                  <Trash2 className="size-3.5" />
                  {common.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>

      {editing ? (
        <RecurringDialog
          categories={categories}
          accounts={accounts}
          goals={goals}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          locale={locale}
          values={{
            id: editing.id,
            name: editing.name,
            amount: editing.amount,
            currency: editing.currency,
            frequency: editing.frequency,
            kind: editing.kind,
            nextDate: toISODate(editing.nextDate),
            updatedAt: editing.updatedAt.toISOString(),
            categoryId: editing.categoryId ?? "none",
            accountId: editing.accountId,
            goalId: editing.goalId,
            note: editing.note,
            active: editing.active,
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDelete
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          id={deleting.id}
          action={deleteRecurringAction}
          title={t.deleteItemTitle(deleting.name)}
          description={t.stopsCounting}
          confirmLabel={common.delete}
          keepLabel={common.keepIt}
          deletedMessage={t.itemDeleted}
        />
      ) : null}
    </>
  );
}
