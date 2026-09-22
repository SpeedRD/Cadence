"use client";

import { useState } from "react";

import type { Option } from "@/components/form/selects";
import { ReviewEditDialog } from "@/components/review/review-edit-dialog";
import { initialPicks, ReviewCard, ReviewRow } from "@/components/review/review-row";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { getDictionary, type Locale } from "@/lib/i18n";
import type { StagedRow } from "@/lib/data/staged";

export function ReviewTable({
  rows,
  accounts,
  categories,
  locale,
}: {
  rows: StagedRow[];
  accounts: Option[];
  categories: Option[];
  locale: Locale;
}) {
  const t = getDictionary(locale).review;
  const common = getDictionary(locale).common;
  const [editing, setEditing] = useState<StagedRow | null>(null);
  // The reviewer's account/category picks, shared by the table row and the
  // phone card so a pick survives a rotation across the breakpoint.
  const [picks, setPicks] = useState<Record<string, { accountId: string; categoryId: string }>>({});
  const picksFor = (row: StagedRow) => {
    const current = picks[row.id] ?? initialPicks(row);
    return {
      accountId: current.accountId,
      categoryId: current.categoryId,
      onAccountChange: (accountId: string) =>
        setPicks((all) => ({ ...all, [row.id]: { ...current, ...all[row.id], accountId } })),
      onCategoryChange: (categoryId: string) =>
        setPicks((all) => ({ ...all, [row.id]: { ...current, ...all[row.id], categoryId } })),
    };
  };

  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[104px]">{common.date}</TableHead>
              <TableHead>{common.description}</TableHead>
              <TableHead className="text-right">{common.amount}</TableHead>
              <TableHead>{common.account}</TableHead>
              <TableHead>{common.category}</TableHead>
              <TableHead className="w-56">{t.colActions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ReviewRow
                key={row.id}
                row={row}
                accounts={accounts}
                categories={categories}
                onEdit={() => setEditing(row)}
                locale={locale}
                {...picksFor(row)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y border-t sm:hidden">
        {rows.map((row) => (
          <ReviewCard
            key={row.id}
            row={row}
            accounts={accounts}
            categories={categories}
            onEdit={() => setEditing(row)}
            locale={locale}
            {...picksFor(row)}
          />
        ))}
      </ul>

      {editing ? (
        <ReviewEditDialog
          row={editing}
          accounts={accounts}
          categories={categories}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          locale={locale}
        />
      ) : null}
    </>
  );
}
