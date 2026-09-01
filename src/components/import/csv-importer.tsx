"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import type { Option } from "@/components/form/selects";
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
import { importTransactionsAction } from "@/server/actions/import";
import { cn } from "@/lib/utils";

type SignMode = "signed" | "expenses" | "income";

const SIGN_LABELS: Record<SignMode, string> = {
  signed: "Signed - negative is spending",
  expenses: "Every row is spending",
  income: "Every row is income",
};

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
      <span className="figure text-xs text-primary">{index}</span>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

export function CsvImporter({
  accounts,
  categories,
  defaultCurrency,
}: {
  accounts: Option[];
  categories: Option[];
  defaultCurrency: string;
}) {
  const router = useRouter();
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

  const [state, formAction, pending] = useActionState(
    importTransactionsAction,
    null,
  );
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? "Imported");
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

  const payload = JSON.stringify({
    accountId,
    currency,
    rows: validRows.map((row) => ({
      date: toISODate(row.date as Date),
      amount: row.amount as number,
      type: row.type,
      note: row.note || null,
      categoryId: categoryId === "none" ? null : categoryId,
    })),
  });

  const columnOptions = Array.from({ length: columnCount }, (_, index) => ({
    value: String(index),
    label: hasHeader && headerCells[index] ? headerCells[index] : `Column ${index + 1}`,
  }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>
            <StepLabel index="01" title="Pick a file" />
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
              {fileName} · {rows.length} row{rows.length === 1 ? "" : "s"} read
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              A plain CSV export from your bank. Nothing is written until you
              review the preview below.
            </p>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <StepLabel index="02" title="Map the columns" />
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
                  First row is a header
                </Label>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Date column">
                  <ColumnSelect
                    options={columnOptions}
                    value={dateColumn}
                    onChange={setDateColumn}
                  />
                </Field>
                <Field label="Amount column">
                  <ColumnSelect
                    options={columnOptions}
                    value={amountColumn}
                    onChange={setAmountColumn}
                  />
                </Field>
                <Field label="Description column">
                  <ColumnSelect
                    options={columnOptions}
                    value={noteColumn}
                    onChange={setNoteColumn}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Date format" hint="How dates are written in your file">
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
                <Field label="Amount convention">
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
                <Field label="Import into account">
                  <PickerSelect
                    value={accountId}
                    onChange={setAccountId}
                    options={accounts.map((account) => ({
                      value: account.id,
                      label: account.name,
                    }))}
                  />
                </Field>
                <Field label="Currency">
                  <PickerSelect
                    value={currency}
                    onChange={setCurrency}
                    options={CURRENCIES.map((code) => ({
                      value: code,
                      label: code,
                    }))}
                  />
                </Field>
                <Field label="Category for every row">
                  <PickerSelect
                    value={categoryId}
                    onChange={setCategoryId}
                    options={[
                      { value: "none", label: "No category" },
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
                <StepLabel index="03" title="Review and import" />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground">{validRows.length}</span> row
                {validRows.length === 1 ? "" : "s"} ready
                {skipped > 0 ? (
                  <>
                    {" "}
                    · <span className="text-[var(--warning)]">{skipped}</span>{" "}
                    skipped because the date or amount could not be read
                  </>
                ) : null}
              </p>

              <div className="overflow-x-auto rounded-md border border-border/70">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-24">Type</TableHead>
                      <TableHead className="w-32 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.slice(0, PREVIEW_ROWS).map((row, index) => (
                      <TableRow
                        key={index}
                        className={cn(!row.valid && "opacity-50")}
                      >
                        <TableCell className="figure text-xs">
                          {row.date ? toISODate(row.date) : "unreadable"}
                        </TableCell>
                        <TableCell className="max-w-[22rem] truncate text-sm">
                          {row.note || "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.valid ? row.type.toLowerCase() : "skipped"}
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
                  Showing the first {PREVIEW_ROWS} of {parsed.length} rows.
                </p>
              ) : null}

              <form action={formAction} className="flex items-center gap-3">
                <input type="hidden" name="payload" value={payload} />
                <SubmitButton pending={pending}>
                  Import {validRows.length} transaction
                  {validRows.length === 1 ? "" : "s"}
                </SubmitButton>
                {state?.error ? (
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
