"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayCategoryDraft, SuggestionBasis } from "@/lib/data/payday";

function basisLabel(basis: SuggestionBasis, t: Dictionary["payday"]) {
  if (basis === "last_budget") return t.basisLastBudget;
  if (basis === "average") return t.basisAverage;
  return t.basisNone;
}

export function StepFlexible({
  categories,
  displayCurrency,
  available,
  daysRemaining,
  onChange,
  t,
}: {
  categories: PaydayCategoryDraft[];
  displayCurrency: string;
  available: number;
  daysRemaining: number;
  onChange: (categoryId: string, plannedAmount: number) => void;
  t: Dictionary["payday"];
}) {
  const allocated = round2(categories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const remaining = round2(available - allocated);
  const perDay = round2(Math.max(0, remaining) / Math.max(1, daysRemaining));

  return (
    <div className="space-y-3">
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noFlexibleCategoriesConfigured}</p>
      ) : (
        categories.map((category) => (
          <Card key={category.categoryId} size="sm">
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />
                  {category.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.suggested}: {formatMoney(category.suggestedAmount, displayCurrency)} (
                  {basisLabel(category.basis, t)})
                </p>
              </div>
              <PaydayAmountInput
                ariaLabel={category.name}
                className="w-32"
                value={category.plannedAmount}
                onChange={(value) => onChange(category.categoryId, Math.max(0, value))}
              />
            </CardContent>
          </Card>
        ))
      )}

      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span>{t.flexibleAllocated}</span>
            <span className="figure">{formatMoney(allocated, displayCurrency)}</span>
          </div>
          <div className="flex justify-between">
            <span>{t.flexibleUnallocated}</span>
            <span className="figure">{formatMoney(Math.max(0, remaining), displayCurrency)}</span>
          </div>
          <div className="flex justify-between border-t border-border/70 pt-1.5 font-medium">
            <span>{t.safeToSpendPerDayEstimate}</span>
            <span className="figure">{formatMoney(perDay, displayCurrency)}</span>
          </div>
          {remaining < 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t.flexibleOverallocated(formatMoney(Math.abs(remaining), displayCurrency))}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
