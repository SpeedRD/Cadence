"use client";

import { RotateCcw, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { Option } from "@/components/form/selects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getDictionary, type Locale } from "@/lib/i18n";
import { TRANSACTION_SOURCES, TRANSACTION_TYPES } from "@/lib/labels";

const ALL = "all";

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

  return (
    <div className="flex flex-wrap items-center gap-2">
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
          className="h-8 w-44 pl-8"
          aria-label={t.searchNotes}
        />
      </form>

      <Select
        value={values.account ?? ALL}
        onValueChange={(value) => apply({ account: value })}
      >
        <SelectTrigger size="sm" className="w-36">
          <SelectValue placeholder={t.accountPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t.allAccounts}</SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={values.category ?? ALL}
        onValueChange={(value) => apply({ category: value })}
      >
        <SelectTrigger size="sm" className="w-36">
          <SelectValue placeholder={t.categoryPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t.allCategories}</SelectItem>
          <SelectItem value="none">{t.uncategorized}</SelectItem>
          {categories.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={values.type ?? ALL}
        onValueChange={(value) => apply({ type: value })}
      >
        <SelectTrigger size="sm" className="w-32">
          <SelectValue placeholder={t.typePlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t.allTypes}</SelectItem>
          {TRANSACTION_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {common.transactionTypeLabels[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={values.source ?? ALL}
        onValueChange={(value) => apply({ source: value })}
      >
        <SelectTrigger size="sm" className="w-32">
          <SelectValue placeholder={t.sourcePlaceholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t.allSources}</SelectItem>
          {TRANSACTION_SOURCES.map((source) => (
            <SelectItem key={source} value={source}>
              {common.sourceLabels[source]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          type="date"
          aria-label={t.fromDateAria}
          className="h-8 w-[9.5rem] max-w-full"
          value={values.from ?? ""}
          onChange={(event) => apply({ from: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">{t.toSeparator}</span>
        <Input
          type="date"
          aria-label={t.toDateAria}
          className="h-8 w-[9.5rem] max-w-full"
          value={values.to ?? ""}
          onChange={(event) => apply({ to: event.target.value })}
        />
      </div>

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQuery("");
            router.push(pathname);
          }}
        >
          <RotateCcw className="size-3.5" />
          {t.clear}
        </Button>
      ) : null}
    </div>
  );
}
