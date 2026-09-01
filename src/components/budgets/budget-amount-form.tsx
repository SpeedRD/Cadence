"use client";

import { Check } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveBudgetAction } from "@/server/actions/budgets";
import { cn } from "@/lib/utils";

/**
 * One inline form per budget cell. Clearing the field deletes that budget.
 * The overall budget passes an empty categoryId.
 */
export function BudgetAmountForm({
  year,
  month,
  period,
  categoryId,
  amount,
  currency,
  label,
  size = "sm",
}: {
  year: number;
  month: number;
  period: string;
  categoryId: string | null;
  amount: number | null;
  currency: string;
  label: string;
  size?: "sm" | "lg";
}) {
  const [state, formAction, pending] = useActionState(saveBudgetAction, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) toast.success(state.message ?? "Saved");
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form
      action={formAction}
      className={cn(
        "flex items-center gap-1",
        size === "lg" ? "justify-start" : "justify-end",
      )}
    >
      <input type="hidden" name="year" value={year} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="period" value={period} />
      <input type="hidden" name="categoryId" value={categoryId ?? ""} />
      <input type="hidden" name="currency" value={currency} />
      <div className="relative">
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-muted-foreground",
            size === "lg" ? "text-sm" : "text-xs",
          )}
        >
          {currency}
        </span>
        <Input
          name="amount"
          inputMode="decimal"
          aria-label={label}
          defaultValue={amount ?? ""}
          placeholder="0.00"
          className={cn(
            "pl-11 text-right font-mono",
            size === "lg" ? "h-9 w-40 text-base" : "h-7 w-32 text-sm",
          )}
        />
      </div>
      <Button
        type="submit"
        variant="ghost"
        size={size === "lg" ? "icon-sm" : "icon-xs"}
        disabled={pending}
        aria-label={`Save ${label}`}
      >
        <Check className="size-3.5" />
      </Button>
    </form>
  );
}
