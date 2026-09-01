"use client";

import { LoaderCircle, Pencil } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { Option } from "@/components/form/selects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { approveStagedAction, rejectStagedAction } from "@/server/actions/review";

import type { StagedRow } from "@/lib/data/staged";

const STATUS_BADGE: Record<string, { label: string; variant: "secondary" | "destructive" }> = {
  APPROVED: { label: "Approved", variant: "secondary" },
  REJECTED: { label: "Rejected", variant: "destructive" },
};

export function ReviewRow({
  row,
  accounts,
  categories,
  onEdit,
}: {
  row: StagedRow;
  accounts: Option[];
  categories: Option[];
  onEdit: () => void;
}) {
  const [accountId, setAccountId] = useState(row.accountId ?? "");
  const [categoryId, setCategoryId] = useState(row.suggestedCategoryId ?? "none");
  const [pending, startTransition] = useTransition();
  const reviewed = row.status !== "PENDING";

  const approve = () => {
    if (!accountId) {
      toast.error("Pick an account before approving");
      return;
    }
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", row.id);
      formData.set("date", toISODate(row.date));
      formData.set("amount", String(row.amount));
      formData.set("currency", row.currency);
      formData.set("rawDescription", row.rawDescription);
      formData.set("accountId", accountId);
      formData.set("categoryId", categoryId === "none" ? "" : categoryId);
      const result = await approveStagedAction(null, formData);
      if (result?.error) toast.error(result.error);
      else toast.success(result?.message ?? "Approved");
    });
  };

  const reject = () => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", row.id);
      const result = await rejectStagedAction(null, formData);
      if (result?.error) toast.error(result.error);
      else toast.success(result?.message ?? "Rejected");
    });
  };

  return (
    <TableRow>
      <TableCell className="figure text-xs text-muted-foreground">
        {toISODate(row.date)}
      </TableCell>
      <TableCell className="max-w-[18rem] truncate text-sm">
        {row.rawDescription}
      </TableCell>
      <TableCell className="text-right">
        <span className="figure text-sm">{formatMoney(row.amount, row.currency)}</span>
      </TableCell>
      <TableCell className="w-40">
        {reviewed ? (
          <span className="text-sm text-muted-foreground">
            {accounts.find((a) => a.id === row.accountId)?.name ?? "-"}
          </span>
        ) : (
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder="Pick an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell className="w-40">
        {reviewed ? (
          <span className="text-sm text-muted-foreground">
            {categories.find((c) => c.id === row.suggestedCategoryId)?.name ?? "-"}
          </span>
        ) : (
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No category</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell className="w-56">
        {reviewed ? (
          <Badge variant={STATUS_BADGE[row.status]?.variant ?? "outline"}>
            {STATUS_BADGE[row.status]?.label ?? row.status}
          </Badge>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-xs" aria-label="Edit" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={reject}>
              Reject
            </Button>
            <Button size="sm" disabled={pending} onClick={approve}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              Approve
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
