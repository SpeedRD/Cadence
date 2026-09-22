"use client";

import Link from "next/link";
import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayAccountDraft } from "@/lib/data/payday";

export function StepBalances({
  accounts,
  onChange,
  t,
}: {
  accounts: PaydayAccountDraft[];
  onChange: (accountId: string, reportedBalance: number) => void;
  t: Dictionary["payday"];
}) {
  const [meaningOpen, setMeaningOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t.step1Description}</p>
        <Link href="/accounts" className="shrink-0 text-xs text-muted-foreground underline">
          {t.manageAccountsLink}
        </Link>
      </div>
      {/* What the figure means, because the ledger figure below already leaves
          this check-in's own income out: reopening days after payday must not
          invite typing the account's current balance, which would count that
          income twice in Step 3's reconciliation. On a phone it folds behind
          a disclosure so the first field is not a paragraph away, but stays
          one tap from every visit; above sm it is always shown. */}
      <button
        type="button"
        data-checkin-disclosure
        aria-expanded={meaningOpen}
        aria-controls="checkin-balance-meaning"
        onClick={() => setMeaningOpen((open) => !open)}
        className="flex min-h-11 w-full items-center text-left text-xs text-muted-foreground underline sm:hidden"
      >
        {t.balanceMeaningDisclosure}
      </button>
      <p
        id="checkin-balance-meaning"
        className={cn("text-xs text-muted-foreground", !meaningOpen && "max-sm:hidden")}
      >
        {t.step1BalanceMeaning}
      </p>
      {accounts.map((account) => {
        const difference = round2(account.reportedBalance - account.expectedLedgerBalance);
        return (
          <Card key={account.accountId} size="sm">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{account.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.ledgerBalance}: {formatMoney(account.expectedLedgerBalance, account.currency)}
                  {account.readOnly ? ` · ${t.archivedAccountNote}` : ""}
                </p>
              </div>
              <div className="w-40">
                <Field label={t.reportedBalance} htmlFor={`balance-${account.accountId}`}>
                  <PaydayAmountInput
                    id={`balance-${account.accountId}`}
                    value={account.reportedBalance}
                    onChange={(value) => onChange(account.accountId, value)}
                    allowNegative
                    disabled={account.readOnly}
                  />
                </Field>
              </div>
              <p
                className={
                  difference === 0
                    ? "text-xs text-muted-foreground"
                    : difference > 0
                      ? "text-xs text-[var(--good)]"
                      : "text-xs text-[var(--critical)]"
                }
              >
                {difference === 0
                  ? t.matchesLedger
                  : difference > 0
                    ? t.aboveLedger(formatMoney(difference, account.currency))
                    : t.belowLedger(formatMoney(Math.abs(difference), account.currency))}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
