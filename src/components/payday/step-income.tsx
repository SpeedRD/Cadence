"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/components/shell/locale-provider";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/date-format";
import { ledgerDepositsIssue, oneOffIncomeIssue } from "@/lib/period-income";
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
  onChange: (accountId: string, patch: { incomeEntered?: number; oneOffIncome?: number; incomeNote?: string }) => void;
  t: Dictionary["payday"];
}) {
  const locale = useLocale();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.step2Description}</p>
      {accounts.map((account) => {
        // The one-off part is validated as it is typed: 0 up to the income
        // (oneOffIncomeIssue, which the confirm's schema applies again).
        const oneOffTooHigh = oneOffIncomeIssue(account.incomeEntered, account.oneOffIncome) !== null;
        // The deposits the ledger already holds for this period are adopted
        // as they are, so the income cannot go below them (R1).
        const belowLedger =
          !account.readOnly && ledgerDepositsIssue(account.incomeEntered, account.ledgerDepositsTotal) !== null;
        return (
          <Card key={account.accountId} size="sm">
            <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_140px] sm:items-end">
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
                  invalid={belowLedger}
                  describedBy={
                    [
                      belowLedger ? `income-error-${account.accountId}` : null,
                      account.ledgerDeposits.length > 0 ? `ledger-deposits-${account.accountId}` : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                />
              </Field>
              <Field label={`${t.oneOffIncomeAmount} (${account.currency})`} htmlFor={`one-off-${account.accountId}`}>
                <PaydayAmountInput
                  id={`one-off-${account.accountId}`}
                  value={account.oneOffIncome}
                  onChange={(value) => onChange(account.accountId, { oneOffIncome: Math.max(0, value) })}
                  disabled={account.readOnly}
                  invalid={oneOffTooHigh}
                  describedBy={oneOffTooHigh ? `one-off-error-${account.accountId}` : undefined}
                />
              </Field>
              {belowLedger ? (
                <p
                  id={`income-error-${account.accountId}`}
                  className="text-xs text-[var(--critical)] sm:col-span-3 sm:text-right"
                  role="alert"
                >
                  {t.incomeBelowLedgerInline(formatMoney(account.ledgerDepositsTotal, account.currency))}
                </p>
              ) : null}
              {oneOffTooHigh ? (
                <p
                  id={`one-off-error-${account.accountId}`}
                  className="text-xs text-[var(--critical)] sm:col-span-3 sm:text-right"
                  role="alert"
                >
                  {t.oneOffIncomeTooHigh}
                </p>
              ) : null}
              {account.ledgerDeposits.length > 0 ? (
                <div id={`ledger-deposits-${account.accountId}`} className="min-w-0 space-y-1 text-xs text-muted-foreground sm:col-span-3">
                  <p className="font-medium">{t.ledgerDepositsHeading}</p>
                  <ul className="space-y-0.5">
                    {account.ledgerDeposits.map((deposit) => (
                      <li key={deposit.transactionId} className="flex justify-between gap-3">
                        <span className="min-w-0">
                          {formatDate(deposit.date, locale)}
                          {deposit.note ? ` · ${deposit.note}` : ""}
                          {deposit.earmarked > 0
                            ? ` · ${t.ledgerDepositEarmarked(formatMoney(deposit.earmarked, account.currency))}`
                            : ""}
                        </span>
                        <span className="figure shrink-0">{formatMoney(deposit.amount, account.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  <p>{t.ledgerDepositsHint}</p>
                </div>
              ) : null}
              {account.ledgerDepositsSetAside > 0 ? (
                <p className="text-xs text-muted-foreground sm:col-span-3">
                  {t.ledgerDepositsSetAside(account.ledgerDepositsSetAside)}
                </p>
              ) : null}
              <Input
                className="sm:col-span-3"
                aria-label={`${t.incomeNotePlaceholder} - ${account.name}`}
                placeholder={t.incomeNotePlaceholder}
                value={account.incomeNote}
                disabled={account.readOnly}
                onChange={(event) => onChange(account.accountId, { incomeNote: event.target.value })}
              />
            </CardContent>
          </Card>
        );
      })}
      <p className="text-sm">
        {t.totalIncome}:{" "}
        <span className="figure font-medium">{formatMoney(totalIncome, displayCurrency)}</span>
      </p>
    </div>
  );
}
