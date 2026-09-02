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
          <CardContent className="grid grid-cols-[1fr_140px_1fr] items-end gap-3">
            <p className="text-sm font-medium">{account.name}</p>
            <Field label={`${t.incomeAmount} (${account.currency})`} htmlFor={`income-${account.accountId}`}>
              <PaydayAmountInput
                id={`income-${account.accountId}`}
                value={account.incomeEntered}
                onChange={(value) => onChange(account.accountId, { incomeEntered: Math.max(0, value) })}
              />
            </Field>
            <Input
              placeholder={t.incomeNotePlaceholder}
              value={account.incomeNote}
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
