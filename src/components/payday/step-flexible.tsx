"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
import { flexibleStepNote } from "@/lib/payday";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayCategoryDraft, SuggestionBasis } from "@/lib/data/payday";

function basisLabel(basis: SuggestionBasis, t: Dictionary["payday"]) {
  if (basis === "last_budget") return t.basisLastBudget;
  if (basis === "average") return t.basisAverage;
  return t.basisNone;
}

export function StepFlexible({
  categories,
  rawSuggestions,
  displayCurrency,
  available,
  cushion,
  onChange,
  t,
}: {
  /** The rows as resolved against `available`: each suggestion already scaled to it. */
  categories: PaydayCategoryDraft[];
  /** The same rows' raw suggestions, before scaling: history exists even when every scaled one is 0. */
  rawSuggestions: readonly { suggestedAmount: number }[];
  displayCurrency: string;
  available: number;
  /** K4's cushion: shown beside the plan, never added to it. */
  cushion: number;
  onChange: (categoryId: string, plannedAmount: number) => void;
  t: Dictionary["payday"];
}) {
  const allocated = round2(categories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const remaining = round2(available - allocated);
  const note = flexibleStepNote(rawSuggestions, categories, available);

  return (
    <div className="space-y-3">
      {/* No history is one thing; history scaled to nothing because the plan
          has no room left (B40) is another, and says so. */}
      {note === "no_history" ? <p className="text-sm text-muted-foreground">{t.noSuggestionsYetNote}</p> : null}
      {note === "deficit" ? <p className="text-sm text-muted-foreground">{t.flexibleDeficitNote}</p> : null}
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
          {/* What the unallocated money is (D23): not a budget, nor money to
              spend per day - it carries to the next period's check-in. */}
          <div className="border-t border-border/70 pt-1.5">
            <div className="flex justify-between font-medium">
              <span>{t.flexibleUnallocated}</span>
              <span className="figure">{formatMoney(Math.max(0, remaining), displayCurrency)}</span>
            </div>
            <p className="text-xs text-muted-foreground">{t.flexibleUnallocatedCarries}</p>
          </div>
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>
              {t.summaryCushion}
              <span className="block text-xs">{t.summaryCushionHint}</span>
            </span>
            <span className="figure">{formatMoney(cushion, displayCurrency)}</span>
          </div>
          {remaining < 0 ? (
            <div className="reveal-block">
              <Alert variant="destructive">
                <AlertDescription>
                  {t.flexibleOverallocated(formatMoney(Math.abs(remaining), displayCurrency))}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
