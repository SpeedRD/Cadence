"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

export function StepConfirm({
  incomeChanges,
  totalIncome,
  unallocated,
  cushion,
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
  /** What confirming does to the paycheck rows: new ones, ones this check-in recorded before updated, or removed at 0. */
  incomeChanges: { created: number; updated: number; removed: number };
  totalIncome: number;
  /** Available less the flexible rows: not written as a budget, carried to the next period. */
  unallocated: number;
  /** K4's cushion: what the accounts held before this pay, not counted in the plan. */
  cushion: number;
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
          <p>{t.confirmIncomeNote(incomeChanges, formatMoney(totalIncome, displayCurrency))}</p>
          <p>{t.confirmBudgetsNote(budgetCount)}</p>
          {unallocated > 0 ? <p>{t.confirmUnallocatedNote(formatMoney(unallocated, displayCurrency))}</p> : null}
          {cushion > 0 ? <p>{t.confirmCushionNote(formatMoney(cushion, displayCurrency))}</p> : null}
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
