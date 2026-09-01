"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CURRENCIES, CURRENCY_LABELS } from "@/lib/currency";
import { updateDisplayCurrencyAction } from "@/server/actions/settings";
import { cn } from "@/lib/utils";

/** Sets the currency every figure in the app is converted into. */
export function CurrencySwitcher({ value }: { value: string }) {
  const [pending, startTransition] = useTransition();

  const select = (code: string) => {
    if (code === value) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("displayCurrency", code);
      const result = await updateDisplayCurrencyAction(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} className="font-mono">
          {value}
          <ChevronsUpDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Display currency</DropdownMenuLabel>
        {CURRENCIES.map((code) => (
          <DropdownMenuItem key={code} onSelect={() => select(code)}>
            <Check
              className={cn("size-3.5", code === value ? "opacity-100" : "opacity-0")}
            />
            <span className="font-mono">{code}</span>
            <span className="text-muted-foreground">{CURRENCY_LABELS[code]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
