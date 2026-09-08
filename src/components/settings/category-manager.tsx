"use client";

import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { CategoryDeleteDialog } from "@/components/settings/category-delete-dialog";
import { CategoryDialog } from "@/components/settings/category-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isUnused, type CategoryRow } from "@/lib/categories";
import { getDictionary, type Locale } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";

export function CategoryManager({
  categories,
  locale,
}: {
  categories: CategoryRow[];
  locale: Locale;
}) {
  const t = getDictionary(locale).settingsPage;
  const common = getDictionary(locale).common;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  const usageSummary = (row: CategoryRow) => {
    if (isUnused(row.usage)) return t.notInUse;
    return [
      row.usage.transactions > 0 ? t.usageTransactions(row.usage.transactions) : null,
      row.usage.recurringItems > 0 ? t.usageRecurringItems(row.usage.recurringItems) : null,
      row.usage.budgets > 0 ? t.usageBudgets(row.usage.budgets) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          {t.newCategory}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/70">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{common.name}</TableHead>
              <TableHead className="hidden sm:table-cell">{t.categoryKind}</TableHead>
              <TableHead className="hidden md:table-cell">{t.inUse}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="font-medium">{row.name}</span>
                    {row.protectedBy ? (
                      <Badge
                        variant="outline"
                        title={
                          row.protectedBy === "subscription"
                            ? t.protectedSubscriptionHint(row.name)
                            : t.protectedSavingsHint(row.name)
                        }
                      >
                        {t.protectedBadge}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground md:hidden">{usageSummary(row)}</p>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant="outline">{labelFor(common.categoryKindLabels, row.kind)}</Badge>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {usageSummary(row)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={t.categoryActionsFor(row.name)}>
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(row)}>
                        <Pencil className="size-3.5" />
                        {common.edit}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={row.protectedBy !== null}
                        onSelect={() => setDeleting(row)}
                      >
                        <Trash2 className="size-3.5" />
                        {t.removeCategory}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <CategoryDialog
        values={{}}
        open={creating}
        onOpenChange={setCreating}
        locale={locale}
      />

      {editing ? (
        <CategoryDialog
          values={{
            id: editing.id,
            name: editing.name,
            kind: editing.kind,
            color: editing.color,
            transactionCount: editing.usage.transactions,
          }}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          locale={locale}
        />
      ) : null}

      {deleting ? (
        <CategoryDeleteDialog
          key={deleting.id}
          category={deleting}
          categories={categories}
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
