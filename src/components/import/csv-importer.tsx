"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import type { Option } from "@/components/form/selects";
import { ImportReview } from "@/components/import/import-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DATE_FORMATS,
  parseAmount,
  parseCsv,
  parseDateWithFormat,
  type DateFormat,
} from "@/lib/csv";
import { CURRENCIES, formatMoney } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  buildRowCategoryOverrides,
  detectImportGroups,
  type RowCategoryDecision,
} from "@/lib/import-grouping";
import { importTransactionsAction } from "@/server/actions/import";
import { cn } from "@/lib/utils";

type SignMode = "signed" | "expenses" | "income";

const PREVIEW_ROWS = 8;

interface ParsedRow {
  date: Date | null;
  amount: number | null;
  note: string;
  type: "EXPENSE" | "INCOME";
  valid: boolean;
}

function StepLabel({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="figure figure-sm text-xs text-primary">{index}</span>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

export function CsvImporter({
  accounts,
  categories,
  defaultCurrency,
  locale,
}: {
  accounts: Option[];
  categories: Option[];
  defaultCurrency: string;
  locale: Locale;
}) {
  const router = useRouter();
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const SIGN_LABELS: Record<SignMode, string> = {
    signed: t.signSigned,
    expenses: t.signExpenses,
    income: t.signIncome,
  };
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [dateColumn, setDateColumn] = useState(0);
  const [amountColumn, setAmountColumn] = useState(1);
  const [noteColumn, setNoteColumn] = useState(2);
  const [dateFormat, setDateFormat] = useState<DateFormat>("YYYY-MM-DD");
  const [signMode, setSignMode] = useState<SignMode>("signed");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [categoryId, setCategoryId] = useState("none");
  const [groupDecisions, setGroupDecisions] = useState<Record<string, string>>({});
  const [unknownRowDecisions, setUnknownRowDecisions] = useState<Record<number, string>>({});
  const [groupTypeDecisions, setGroupTypeDecisions] = useState<Record<string, string>>({});

  const [state, formAction, pending] = useActionState(
    importTransactionsAction,
    null,
  );
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? common.saved);
      router.push("/transactions");
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, router]);

  const headerCells = rows[0] ?? [];
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const dataRows = useMemo(
    () => (hasHeader ? rows.slice(1) : rows),
    [rows, hasHeader],
  );

  const parsed: ParsedRow[] = useMemo(() => {
    return dataRows.map((cells) => {
      const date = parseDateWithFormat(cells[dateColumn] ?? "", dateFormat);
      const rawAmount = parseAmount(cells[amountColumn] ?? "");
      const note = (cells[noteColumn] ?? "").trim();
      const type: "EXPENSE" | "INCOME" =
        signMode === "signed"
          ? (rawAmount ?? 0) < 0
            ? "EXPENSE"
            : "INCOME"
          : signMode === "expenses"
            ? "EXPENSE"
            : "INCOME";
      const amount =
        rawAmount === null ? null : Math.round(Math.abs(rawAmount) * 100) / 100;
      return {
        date,
        amount,
        note,
        type,
        valid: Boolean(date) && amount !== null && amount > 0,
      };
    });
  }, [dataRows, dateColumn, amountColumn, noteColumn, dateFormat, signMode]);

  const validRows = parsed.filter((row) => row.valid);
  const skipped = parsed.length - validRows.length;

  const { groups, unknownRowIndexes } = useMemo(
    () =>
      detectImportGroups(
        validRows.map((row, index) => ({
          index,
          date: row.date as Date,
          amount: row.amount as number,
          note: row.note,
          type: row.type,
        })),
      ),
    [validRows],
  );

  const rowCategoryOverrides = useMemo(() => {
    const decisions: RowCategoryDecision[] = groups
      .filter((group) => groupDecisions[group.id])
      .map((group) => ({ rowIndexes: group.rowIndexes, categoryId: groupDecisions[group.id] }));
    for (const [indexKey, decidedCategoryId] of Object.entries(unknownRowDecisions)) {
      decisions.push({ rowIndexes: [Number(indexKey)], categoryId: decidedCategoryId });
    }
    return buildRowCategoryOverrides(decisions);
  }, [groups, groupDecisions, unknownRowDecisions]);

  // "Mark as income" on an incoming transfer-shaped group overrides the
  // row's transaction type only - never its category (see import-review.tsx).
  // buildRowCategoryOverrides is a generic index -> value fan-out, reused
  // here for the same shape of decision.
  const rowTypeOverrides = useMemo(() => {
    const decisions: RowCategoryDecision[] = groups
      .filter((group) => groupTypeDecisions[group.id])
      .map((group) => ({ rowIndexes: group.rowIndexes, categoryId: groupTypeDecisions[group.id] }));
    return buildRowCategoryOverrides(decisions);
  }, [groups, groupTypeDecisions]);

  // A row whose type override is EXTERNAL_TRANSFER needs a direction too -
  // taken from the group's own detected direction (OUT groups are outgoing,
  // IN groups incoming), never invented independently of the group.
  const rowDirectionOverrides = useMemo(() => {
    const decisions: RowCategoryDecision[] = groups
      .filter((group) => groupTypeDecisions[group.id] === "EXTERNAL_TRANSFER" && group.transferDirection)
      .map((group) => ({ rowIndexes: group.rowIndexes, categoryId: group.transferDirection as string }));
    return buildRowCategoryOverrides(decisions);
  }, [groups, groupTypeDecisions]);

  // The Import button stays disabled while any detected transfer-shaped
  // group has neither a category decision (leave as expense/uncategorized)
  // nor a type decision (mark as income / record as external transfer) -
  // a transfer-shaped description alone must never silently import as
  // ordinary income or spending.
  const unresolvedTransferGroups = groups.filter(
    (group) =>
      group.kind === "transfer" &&
      groupDecisions[group.id] === undefined &&
      groupTypeDecisions[group.id] === undefined,
  );

  const payload = JSON.stringify({
    accountId,
    currency,
    rows: validRows.map((row, index) => {
      const type = rowTypeOverrides.get(index) ?? row.type;
      return {
        date: toISODate(row.date as Date),
        amount: row.amount as number,
        type,
        transferDirection: type === "EXTERNAL_TRANSFER" ? (rowDirectionOverrides.get(index) ?? null) : null,
        note: row.note || null,
        categoryId:
          type === "EXTERNAL_TRANSFER"
            ? null
            : (rowCategoryOverrides.get(index) ?? (categoryId === "none" ? null : categoryId)),
      };
    }),
  });

  const columnOptions = Array.from({ length: columnCount }, (_, index) => ({
    value: String(index),
    label: hasHeader && headerCells[index] ? headerCells[index] : t.column(index + 1),
  }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>
            <StepLabel index="01" title={t.step1} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="max-w-sm"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              const parsedRows = parseCsv(text);
              setRows(parsedRows);
              setFileName(file.name);
              setGroupDecisions({});
              setUnknownRowDecisions({});
              setGroupTypeDecisions({});
              const width = parsedRows.reduce(
                (max, row) => Math.max(max, row.length),
                0,
              );
              setDateColumn(0);
              setAmountColumn(Math.min(1, width - 1));
              setNoteColumn(Math.min(2, width - 1));
            }}
          />
          {fileName ? (
            <p className="text-sm text-muted-foreground">
              {t.rowsRead(fileName, rows.length)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.csvHint}
            </p>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <StepLabel index="02" title={t.step2} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  id="has-header"
                  checked={hasHeader}
                  onCheckedChange={setHasHeader}
                />
                <Label htmlFor="has-header" className="text-sm">
                  {t.firstRowHeader}
                </Label>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t.dateColumn}>
                  <ColumnSelect
                    options={columnOptions}
                    value={dateColumn}
                    onChange={setDateColumn}
                  />
                </Field>
                <Field label={t.amountColumn}>
                  <ColumnSelect
                    options={columnOptions}
                    value={amountColumn}
                    onChange={setAmountColumn}
                  />
                </Field>
                <Field label={t.descriptionColumn}>
                  <ColumnSelect
                    options={columnOptions}
                    value={noteColumn}
                    onChange={setNoteColumn}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t.dateFormat} hint={t.dateFormatHint}>
                  <Select
                    value={dateFormat}
                    onValueChange={(value) => setDateFormat(value as DateFormat)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DATE_FORMATS.map((format) => (
                        <SelectItem key={format} value={format}>
                          {format}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t.amountConvention}>
                  <Select
                    value={signMode}
                    onValueChange={(value) => setSignMode(value as SignMode)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SIGN_LABELS) as SignMode[]).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {SIGN_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t.importInto}>
                  <PickerSelect
                    value={accountId}
                    onChange={setAccountId}
                    options={accounts.map((account) => ({
                      value: account.id,
                      label: account.name,
                    }))}
                  />
                </Field>
                <Field label={common.currency}>
                  <PickerSelect
                    value={currency}
                    onChange={setCurrency}
                    options={CURRENCIES.map((code) => ({
                      value: code,
                      label: code,
                    }))}
                  />
                </Field>
                <Field label={t.categoryForEveryRow}>
                  <PickerSelect
                    value={categoryId}
                    onChange={setCategoryId}
                    options={[
                      { value: "none", label: t.noCategory },
                      ...categories.map((category) => ({
                        value: category.id,
                        label: category.name,
                      })),
                    ]}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <StepLabel index="03" title={t.step3} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t.rowsReady(validRows.length)}
                {skipped > 0 ? (
                  <>
                    {" "}
                    · <span className="text-[var(--warning)]">{skipped}</span>{" "}
                    {t.skippedSuffix}
                  </>
                ) : null}
              </p>

              <div className="overflow-x-auto rounded-md border border-border/70">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">{common.date}</TableHead>
                      <TableHead>{t.colDescription}</TableHead>
                      <TableHead className="w-24">{common.type}</TableHead>
                      <TableHead className="w-32 text-right">{common.amount}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.slice(0, PREVIEW_ROWS).map((row, index) => (
                      <TableRow
                        key={index}
                        className={cn(!row.valid && "opacity-50")}
                      >
                        <TableCell className="figure figure-sm text-xs">
                          {row.date ? toISODate(row.date) : t.unreadable}
                        </TableCell>
                        <TableCell className="max-w-[22rem] truncate text-sm">
                          {row.note || "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.valid ? row.type.toLowerCase() : t.skipped}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="figure text-sm">
                            {row.amount === null
                              ? "-"
                              : formatMoney(row.amount, currency)}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {parsed.length > PREVIEW_ROWS ? (
                <p className="text-xs text-muted-foreground">
                  {t.showingFirst(PREVIEW_ROWS, parsed.length)}
                </p>
              ) : null}

              <ImportReview
                groups={groups}
                unknownRowIndexes={unknownRowIndexes}
                rows={validRows.map((row) => ({
                  date: row.date as Date,
                  amount: row.amount as number,
                  note: row.note,
                  type: row.type,
                }))}
                categories={categories}
                accounts={accounts}
                currency={currency}
                accountId={accountId}
                locale={locale}
                decisions={groupDecisions}
                onDecideAction={(groupId, decision) =>
                  setGroupDecisions((previous) => {
                    if (decision === undefined) {
                      const { [groupId]: _removed, ...rest } = previous;
                      return rest;
                    }
                    return { ...previous, [groupId]: decision };
                  })
                }
                unknownDecisions={unknownRowDecisions}
                onDecideUnknownAction={(rowIndexes, decidedCategoryId) =>
                  setUnknownRowDecisions((previous) => {
                    const next = { ...previous };
                    for (const index of rowIndexes) next[index] = decidedCategoryId;
                    return next;
                  })
                }
                typeDecisions={groupTypeDecisions}
                onDecideTypeAction={(groupId, typeOverride) =>
                  setGroupTypeDecisions((previous) => {
                    if (typeOverride === undefined) {
                      const { [groupId]: _removed, ...rest } = previous;
                      return rest;
                    }
                    return { ...previous, [groupId]: typeOverride };
                  })
                }
              />

              <form action={formAction} className="flex items-center gap-3">
                <input type="hidden" name="payload" value={payload} />
                <SubmitButton pending={pending} disabled={unresolvedTransferGroups.length > 0}>
                  {t.importCount(validRows.length)}
                </SubmitButton>
                {unresolvedTransferGroups.length > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {t.resolveTransfersHint(unresolvedTransferGroups.length)}
                  </span>
                ) : state?.error ? (
                  <span className="text-sm text-destructive">{state.error}</span>
                ) : null}
              </form>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function PickerSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ColumnSelect({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <PickerSelect
      options={options}
      value={String(value)}
      onChange={(next) => onChange(Number(next))}
    />
  );
}
