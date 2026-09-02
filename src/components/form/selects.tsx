import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CURRENCIES } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

export interface Option {
  id: string;
  name: string;
  color?: string | null;
  currency?: string;
}

export function AccountSelect({
  id,
  name,
  accounts,
  defaultValue,
  placeholder,
  common,
}: {
  /** Lets a <Field htmlFor> label the trigger button. */
  id?: string;
  name: string;
  accounts: Option[];
  defaultValue?: string;
  placeholder?: string;
  common: Pick<Dictionary["common"], "pickAnAccount" | "pickACategory" | "noCategory">;
}) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder ?? common.pickAnAccount} />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
            {account.currency ? (
              <span className="text-muted-foreground">{account.currency}</span>
            ) : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CategorySelect({
  id,
  name,
  categories,
  defaultValue,
  includeNone = true,
  common,
}: {
  id?: string;
  name: string;
  categories: Option[];
  defaultValue?: string;
  includeNone?: boolean;
  common: Pick<Dictionary["common"], "pickAnAccount" | "pickACategory" | "noCategory">;
}) {
  return (
    <Select name={name} defaultValue={defaultValue ?? (includeNone ? "none" : undefined)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={common.pickACategory} />
      </SelectTrigger>
      <SelectContent>
        {includeNone ? <SelectItem value="none">{common.noCategory}</SelectItem> : null}
        {categories.map((category) => (
          <SelectItem key={category.id} value={category.id}>
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: category.color ?? "var(--muted-foreground)" }}
            />
            {category.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CurrencySelect({
  id,
  name,
  defaultValue,
}: {
  id?: string;
  name: string;
  defaultValue?: string;
}) {
  return (
    <Select name={name} defaultValue={defaultValue ?? CURRENCIES[0]}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CURRENCIES.map((code) => (
          <SelectItem key={code} value={code}>
            {code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EnumSelect({
  id,
  name,
  options,
  labels,
  defaultValue,
  placeholder,
}: {
  id?: string;
  name: string;
  options: readonly string[];
  labels: Record<string, string>;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option] ?? option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
