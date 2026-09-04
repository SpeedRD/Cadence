"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayAccountDraft } from "@/lib/data/payday";

export function StepIncome({
  accounts,
  totalIncome,
  displayCurrency,
  onChange,
  t,
}: {
  accounts: PaydayAccountDraft[];
  totalIncome: number;
  displayCurrency: string;
  onChange: (accountId: string, patch: { incomeEntered?: number; incomeNote?: string }) => void;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.step2Description}</p>
      {accounts.map((account) => (
        <Card key={account.accountId} size="sm">
          <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)] sm:items-end">
            <p className="text-sm font-medium">
              {account.name}
              {account.readOnly ? (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {t.archivedAccountNote}
                </span>
              ) : null}
            </p>
            <Field label={`${t.incomeAmount} (${account.currency})`} htmlFor={`income-${account.accountId}`}>
              <PaydayAmountInput
                id={`income-${account.accountId}`}
                value={account.incomeEntered}
                onChange={(value) => onChange(account.accountId, { incomeEntered: Math.max(0, value) })}
                disabled={account.readOnly}
              />
            </Field>
            <Input
              aria-label={`${t.incomeNotePlaceholder} - ${account.name}`}
              placeholder={t.incomeNotePlaceholder}
              value={account.incomeNote}
              disabled={account.readOnly}
              onChange={(event) => onChange(account.accountId, { incomeNote: event.target.value })}
            />
          </CardContent>
        </Card>
      ))}
      <p className="text-sm">
        {t.totalIncome}:{" "}
        <span className="figure font-medium">{formatMoney(totalIncome, displayCurrency)}</span>
      </p>
    </div>
  );
}
