"use client";

import { LoaderCircle, Pencil } from "lucide-react";
import { useId, useTransition } from "react";
import { toast } from "sonner";

import type { Option } from "@/components/form/selects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { getDictionary, type Locale } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";
import { approveStagedAction, rejectStagedAction } from "@/server/actions/review";

import type { StagedRow } from "@/lib/data/staged";

type ReviewDictionary = ReturnType<typeof getDictionary>["review"];

function StatusBadge({ status, t }: { status: string; t: ReviewDictionary }) {
  const STATUS_BADGE: Record<string, { label: string; variant: "secondary" | "destructive" }> = {
    APPROVED: { label: t.approved, variant: "secondary" },
    REJECTED: { label: t.rejected, variant: "destructive" },
  };
  return (
    <Badge variant={STATUS_BADGE[status]?.variant ?? "outline"}>
      {STATUS_BADGE[status]?.label ?? status}
    </Badge>
  );
}

/** Approve and reject for one staged row, with the account and category the reviewer picked. */
function useReviewActions(row: StagedRow, t: ReviewDictionary, accountId: string, categoryId: string) {
  const [pending, startTransition] = useTransition();

  const approve = () => {
    if (!accountId) {
      toast.error(t.pickAccountFirst);
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
      else toast.success(result?.message ?? t.approvedToast);
    });
  };

  const reject = () => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", row.id);
      const result = await rejectStagedAction(null, formData);
      if (result?.error) toast.error(result.error);
      else toast.success(result?.message ?? t.rejectedToast);
    });
  };

  return { pending, approve, reject };
}

/** The picks a row starts from; ReviewTable keeps any change the reviewer makes. */
export function initialPicks(row: StagedRow) {
  return { accountId: row.accountId ?? "", categoryId: row.suggestedCategoryId ?? "none" };
}

type PickProps = {
  accountId: string;
  categoryId: string;
  onAccountChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
};

function AccountPicker({
  id,
  accounts,
  value,
  onChange,
  t,
  size,
}: {
  id?: string;
  accounts: Option[];
  value: string;
  onChange: (value: string) => void;
  t: ReviewDictionary;
  size: "sm" | "default";
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size={size} className="w-full">
        <SelectValue placeholder={t.pickAnAccount} />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CategoryPicker({
  id,
  categories,
  value,
  onChange,
  t,
  placeholder,
  size,
}: {
  id?: string;
  categories: Option[];
  value: string;
  onChange: (value: string) => void;
  t: ReviewDictionary;
  placeholder: string;
  size: "sm" | "default";
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} size={size} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t.noCategory}</SelectItem>
        {categories.map((category) => (
          <SelectItem key={category.id} value={category.id}>
            {category.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ReviewRow({
  row,
  accounts,
  categories,
  onEdit,
  locale,
  accountId,
  categoryId,
  onAccountChange,
  onCategoryChange,
}: {
  row: StagedRow;
  accounts: Option[];
  categories: Option[];
  onEdit: () => void;
  locale: Locale;
} & PickProps) {
  const t = getDictionary(locale).review;
  const common = getDictionary(locale).common;
  const { pending, approve, reject } = useReviewActions(row, t, accountId, categoryId);
  const reviewed = row.status !== "PENDING";

  return (
    <TableRow>
      <TableCell className="figure figure-sm text-xs text-muted-foreground">
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
          <AccountPicker accounts={accounts} value={accountId} onChange={onAccountChange} t={t} size="sm" />
        )}
      </TableCell>
      <TableCell className="w-40">
        {reviewed ? (
          <span className="text-sm text-muted-foreground">
            {categories.find((c) => c.id === row.suggestedCategoryId)?.name ?? "-"}
          </span>
        ) : (
          <CategoryPicker
            categories={categories}
            value={categoryId}
            onChange={onCategoryChange}
            t={t}
            placeholder={common.category}
            size="sm"
          />
        )}
      </TableCell>
      <TableCell className="w-56">
        {reviewed ? (
          <StatusBadge status={row.status} t={t} />
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-xs" aria-label={t.editAria} onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={reject}>
              {t.reject}
            </Button>
            <Button size="sm" disabled={pending} onClick={approve}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {t.approve}
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * The phone presentation of one staged row (below `sm`): description and
 * amount, then date and source, the two pickers at full width, and Reject /
 * Approve along the card's foot where the thumb is.
 */
export function ReviewCard({
  row,
  accounts,
  categories,
  onEdit,
  locale,
  accountId,
  categoryId,
  onAccountChange,
  onCategoryChange,
}: {
  row: StagedRow;
  accounts: Option[];
  categories: Option[];
  onEdit: () => void;
  locale: Locale;
} & PickProps) {
  const t = getDictionary(locale).review;
  const common = getDictionary(locale).common;
  const { pending, approve, reject } = useReviewActions(row, t, accountId, categoryId);
  const reviewed = row.status !== "PENDING";
  const fieldId = useId();

  return (
    <li className="space-y-3 px-4 py-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
        <p className="text-sm break-words">{row.rawDescription}</p>
        <span className="figure text-right text-sm">{formatMoney(row.amount, row.currency)}</span>
        <p className="col-span-2 text-[0.6875rem] text-muted-foreground">
          <span className="figure figure-sm">{toISODate(row.date)}</span>
          {" · "}
          {labelFor(common.sourceLabels, row.source)}
        </p>
      </div>

      {reviewed ? (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{common.account}</dt>
            <dd className="break-words">
              {accounts.find((a) => a.id === row.accountId)?.name ?? "-"}
            </dd>
            <dt className="text-muted-foreground">{common.category}</dt>
            <dd className="break-words">
              {categories.find((c) => c.id === row.suggestedCategoryId)?.name ?? "-"}
            </dd>
          </dl>
          <StatusBadge status={row.status} t={t} />
        </>
      ) : (
        <>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-account`} className="text-xs font-normal text-muted-foreground">
                {common.account}
              </Label>
              <AccountPicker
                id={`${fieldId}-account`}
                accounts={accounts}
                value={accountId}
                onChange={onAccountChange}
                t={t}
                size="default"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${fieldId}-category`} className="text-xs font-normal text-muted-foreground">
                {common.category}
              </Label>
              <CategoryPicker
                id={`${fieldId}-category`}
                categories={categories}
                value={categoryId}
                onChange={onCategoryChange}
                t={t}
                placeholder={common.category}
                size="default"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-xs" aria-label={t.editAria} onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="flex-1" disabled={pending} onClick={reject}>
              {t.reject}
            </Button>
            <Button size="sm" className="flex-1" disabled={pending} onClick={approve}>
              {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {t.approve}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
