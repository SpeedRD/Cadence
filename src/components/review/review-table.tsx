"use client";

import { useState } from "react";

import type { Option } from "@/components/form/selects";
import { ReviewEditDialog } from "@/components/review/review-edit-dialog";
import { ReviewRow } from "@/components/review/review-row";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { StagedRow } from "@/lib/data/staged";

export function ReviewTable({
  rows,
  accounts,
  categories,
}: {
  rows: StagedRow[];
  accounts: Option[];
  categories: Option[];
}) {
  const [editing, setEditing] = useState<StagedRow | null>(null);

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[104px]">Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="w-56">Actions</TableHead>
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
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {editing ? (
        <ReviewEditDialog
          row={editing}
          accounts={accounts}
          categories={categories}
          open
          onOpenChange={(next) => !next && setEditing(null)}
        />
      ) : null}
    </>
  );
}
