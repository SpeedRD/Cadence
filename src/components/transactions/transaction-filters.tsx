"use client";

import { RotateCcw, Search, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/form/field";
import type { Option } from "@/components/form/selects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, fromISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { TRANSACTION_SOURCES, TRANSACTION_TYPES } from "@/lib/labels";

const ALL = "all";

const SELECT_KEYS = ["account", "category", "type", "source"] as const;
type SelectKey = (typeof SELECT_KEYS)[number];
/** The five controls a phone keeps in the Filters sheet (search stays out). */
type SheetKey = SelectKey | "from" | "to";
type SheetValues = Partial<Record<SheetKey, string>>;
const CLEARED: Record<SheetKey, undefined> = {
  account: undefined,
  category: undefined,
  type: undefined,
  source: undefined,
  from: undefined,
  to: undefined,
};

function FilterSelect({
  id,
  value,
  onValueChange,
  placeholder,
  allLabel,
  options,
  className,
}: {
  id?: string;
  value: string | undefined;
  onValueChange: (value: string) => void;
  placeholder: string;
  allLabel: string;
  options: { value: string; label: string }[];
  className: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={onValueChange}>
      <SelectTrigger id={id} size="sm" className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function TransactionFilters({
  accounts,
  categories,
  values,
  locale,
}: {
  accounts: Option[];
  categories: Option[];
  values: Record<string, string | undefined>;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(values.q ?? "");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState<SheetValues>({});

  const apply = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    const search = next.toString();
    router.push(search ? `${pathname}?${search}` : pathname);
  };

  const hasFilters = Array.from(searchParams.keys()).some(
    (key) => key !== "page",
  );

  const selects: Record<
    SelectKey,
    { placeholder: string; allLabel: string; options: { value: string; label: string }[] }
  > = {
    account: {
      placeholder: t.accountPlaceholder,
      allLabel: t.allAccounts,
      options: accounts.map((account) => ({ value: account.id, label: account.name })),
    },
    category: {
      placeholder: t.categoryPlaceholder,
      allLabel: t.allCategories,
      options: [
        { value: "none", label: t.uncategorized },
        ...categories.map((category) => ({ value: category.id, label: category.name })),
      ],
    },
    type: {
      placeholder: t.typePlaceholder,
      allLabel: t.allTypes,
      options: TRANSACTION_TYPES.map((type) => ({
        value: type,
        label: common.transactionTypeLabels[type],
      })),
    },
    source: {
      placeholder: t.sourcePlaceholder,
      allLabel: t.allSources,
      options: TRANSACTION_SOURCES.map((source) => ({
        value: source,
        label: common.sourceLabels[source],
      })),
    },
  };

  // What the phone shows as chips and counts on the Filters button: one per
  // sheet control in use, the date range counting once. Each chip clears
  // only its own URL parameters, through the same apply() as everything else.
  const isSet = (value: string | undefined) => !!value && value !== ALL;
  const formatDay = (value: string | undefined) => {
    if (!value) return undefined;
    const date = fromISODate(value);
    return date ? formatDate(date) : value;
  };
  const chips = [
    ...SELECT_KEYS.filter((key) => isSet(values[key])).map((key) => ({
      key,
      label:
        selects[key].options.find((option) => option.value === values[key])?.label ??
        selects[key].placeholder,
      clear: { [key]: undefined },
    })),
    ...(values.from || values.to
      ? [
          {
            key: "dates",
            label: t.dateRangeChip(formatDay(values.from), formatDay(values.to)),
            clear: { from: undefined, to: undefined },
          },
        ]
      : []),
  ];

  return (
    // Below sm: search and the Filters button share the first row and the
    // chips span the second; the inline selects and dates are hidden there,
    // their sheet copies taking over. The original flex row from sm up.
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ q: query });
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.searchNotes}
          className="w-full pl-8 sm:h-8 sm:w-44"
          aria-label={t.searchNotes}
        />
      </form>

      <FilterSelect
        {...selects.account}
        value={values.account}
        onValueChange={(value) => apply({ account: value })}
        className="max-sm:hidden sm:w-44"
      />

      <FilterSelect
        {...selects.category}
        value={values.category}
        onValueChange={(value) => apply({ category: value })}
        className="max-sm:hidden sm:w-44"
      />

      <FilterSelect
        {...selects.type}
        value={values.type}
        onValueChange={(value) => apply({ type: value })}
        className="max-sm:hidden sm:w-40"
      />

      <FilterSelect
        {...selects.source}
        value={values.source}
        onValueChange={(value) => apply({ source: value })}
        className="max-sm:hidden sm:w-40"
      />

      <div className="flex flex-wrap items-center gap-1.5 max-sm:hidden">
        <Input
          type="date"
          aria-label={t.fromDateAria}
          className="min-w-0 flex-1 sm:h-8 sm:w-[9.5rem] sm:flex-none"
          value={values.from ?? ""}
          onChange={(event) => apply({ from: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">{t.toSeparator}</span>
        <Input
          type="date"
          aria-label={t.toDateAria}
          className="min-w-0 flex-1 sm:h-8 sm:w-[9.5rem] sm:flex-none"
          value={values.to ?? ""}
          onChange={(event) => apply({ to: event.target.value })}
        />
      </div>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          className="max-sm:hidden"
          onClick={() => {
            setQuery("");
            router.push(pathname);
          }}
        >
          <RotateCcw className="size-3.5" />
          {t.clear}
        </Button>
      ) : null}

      {/* Phone only from here on, and after the inline controls so the
          Radix ids inside them keep their tree positions. The sheet edits a
          draft of the five controls; Apply and Clear hand it to apply(). */}
      <Dialog
        open={sheetOpen}
        onOpenChange={(open) => {
          if (open) {
            setPending({
              account: values.account,
              category: values.category,
              type: values.type,
              source: values.source,
              from: values.from,
              to: values.to,
            });
          }
          setSheetOpen(open);
        }}
      >
        <DialogTrigger asChild>
          <Button
            variant="outline"
            className="sm:hidden"
            aria-label={chips.length > 0 ? t.filtersActive(chips.length) : undefined}
          >
            {t.filters}
            {chips.length > 0 ? (
              <Badge variant="secondary" className="tnum">
                {chips.length}
              </Badge>
            ) : null}
          </Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t.filters}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            {SELECT_KEYS.map((key) => (
              <Field
                key={key}
                label={selects[key].placeholder}
                htmlFor={`transaction-filter-${key}`}
              >
                <FilterSelect
                  {...selects[key]}
                  id={`transaction-filter-${key}`}
                  value={pending[key]}
                  onValueChange={(value) =>
                    setPending((draft) => ({ ...draft, [key]: value }))
                  }
                  className="w-full"
                />
              </Field>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.fromDateAria} htmlFor="transaction-filter-from">
                <Input
                  id="transaction-filter-from"
                  type="date"
                  value={pending.from ?? ""}
                  onChange={(event) =>
                    setPending((draft) => ({ ...draft, from: event.target.value }))
                  }
                />
              </Field>
              <Field label={t.toDateAria} htmlFor="transaction-filter-to">
                <Input
                  id="transaction-filter-to"
                  type="date"
                  value={pending.to ?? ""}
                  onChange={(event) =>
                    setPending((draft) => ({ ...draft, to: event.target.value }))
                  }
                />
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                apply(CLEARED);
                setSheetOpen(false);
              }}
            >
              {t.clear}
            </Button>
            <Button
              onClick={() => {
                apply({ ...CLEARED, ...pending });
                setSheetOpen(false);
              }}
            >
              {t.applyFilters}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {chips.length > 0 ? (
        <div className="col-span-2 flex flex-wrap gap-x-2 gap-y-3 sm:hidden">
          {chips.map((chip) => (
            // The whole chip is the dismiss control: 32px tall, its hit area
            // stretched to 44px by the pseudo-element (7px, as its inset
            // starts inside Badge's 1px border; the row's 12px gap keeps two
            // wrapped rows' areas from overlapping).
            <Badge
              key={chip.key}
              asChild
              variant="secondary"
              className="relative h-8 max-w-full overflow-visible px-3 after:absolute after:inset-x-0 after:-inset-y-1.75"
            >
              <button
                type="button"
                aria-label={t.removeFilter(chip.label)}
                onClick={() => apply(chip.clear)}
              >
                <span className="min-w-0 truncate">{chip.label}</span>
                <XIcon data-icon="inline-end" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
