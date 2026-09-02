"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
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
              <Input
                id={`income-${account.accountId}`}
                inputMode="decimal"
                className="font-mono text-right"
                value={account.incomeEntered}
                onChange={(event) => {
                  const parsed = Number(event.target.value.replace(/,/g, ""));
                  onChange(account.accountId, {
                    incomeEntered: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
                  });
                }}
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
