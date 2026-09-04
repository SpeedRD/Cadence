"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

export function StepConfirm({
  incomeTransactionCount,
  totalIncome,
  budgetCount,
  allocatedCategoryCount,
  displayCurrency,
  needsDeficitAck,
  acknowledgedDeficit,
  onAcknowledgeDeficitChange,
  needsZeroBufferAck,
  acknowledgedZeroBuffer,
  onAcknowledgeZeroBufferChange,
  isEditingConfirmed,
  formError,
  t,
}: {
  incomeTransactionCount: number;
  totalIncome: number;
  budgetCount: number;
  /** Categories with a planned amount above zero - when none, say where budgets can be set later. */
  allocatedCategoryCount: number;
  displayCurrency: string;
  needsDeficitAck: boolean;
  acknowledgedDeficit: boolean;
  onAcknowledgeDeficitChange: (value: boolean) => void;
  needsZeroBufferAck: boolean;
  acknowledgedZeroBuffer: boolean;
  onAcknowledgeZeroBufferChange: (value: boolean) => void;
  isEditingConfirmed: boolean;
  formError: string | null;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-3">
      {isEditingConfirmed ? (
        <Alert>
          <AlertDescription>{t.editConfirmedPlanNote}</AlertDescription>
        </Alert>
      ) : null}
      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>{t.confirmSnapshotsNote}</p>
          <p>{t.confirmIncomeNote(incomeTransactionCount, formatMoney(totalIncome, displayCurrency))}</p>
          <p>{t.confirmBudgetsNote(budgetCount)}</p>
          {budgetCount > 0 && allocatedCategoryCount === 0 ? (
            <p>{t.confirmNoAllocationsNote}</p>
          ) : null}
          <p>{t.confirmReservedNote}</p>
        </CardContent>
      </Card>

      {/* These two are what unlock a disabled Confirm on a plan the user is
          knowingly underfunding, so they get the app's own control rather than
          the browser's - same ring and focus treatment as every other input in
          the wizard. Checkbox and Label are siblings, not nested: the Radix
          root is a button, and htmlFor is what makes the text clickable. */}
      {needsDeficitAck ? (
        <div className="reveal-block">
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="acknowledge-deficit"
              className="mt-0.5"
              checked={acknowledgedDeficit}
              onCheckedChange={(checked) => onAcknowledgeDeficitChange(checked === true)}
            />
            <Label htmlFor="acknowledge-deficit" className="block text-sm leading-snug font-normal">
              {t.acknowledgeDeficitLabel}
            </Label>
          </div>
        </div>
      ) : null}
      {needsZeroBufferAck ? (
        <div className="reveal-block">
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="acknowledge-zero-buffer"
              className="mt-0.5"
              checked={acknowledgedZeroBuffer}
              onCheckedChange={(checked) => onAcknowledgeZeroBufferChange(checked === true)}
            />
            <Label
              htmlFor="acknowledge-zero-buffer"
              className="block text-sm leading-snug font-normal"
            >
              {t.acknowledgeZeroBufferLabel}
            </Label>
          </div>
        </div>
      ) : null}

      {formError ? (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
