"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

export function StepConfirm({
  incomeTransactionCount,
  totalIncome,
  budgetCount,
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
          <p>{t.confirmReservedNote}</p>
        </CardContent>
      </Card>

      {needsDeficitAck ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledgedDeficit}
            onChange={(event) => onAcknowledgeDeficitChange(event.target.checked)}
          />
          {t.acknowledgeDeficitLabel}
        </label>
      ) : null}
      {needsZeroBufferAck ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledgedZeroBuffer}
            onChange={(event) => onAcknowledgeZeroBufferChange(event.target.checked)}
          />
          {t.acknowledgeZeroBufferLabel}
        </label>
      ) : null}

      {formError ? (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
