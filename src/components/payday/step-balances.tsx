"use client";

import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
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
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t.step1Description}</p>
        <Link href="/accounts" className="shrink-0 text-xs text-muted-foreground underline">
          {t.manageAccountsLink}
        </Link>
      </div>
      {accounts.map((account) => {
        const difference = round2(account.reportedBalance - account.expectedLedgerBalance);
        return (
          <Card key={account.accountId} size="sm">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{account.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.ledgerBalance}: {formatMoney(account.expectedLedgerBalance, account.currency)}
                </p>
              </div>
              <div className="w-40">
                <Field label={t.reportedBalance} htmlFor={`balance-${account.accountId}`}>
                  <Input
                    id={`balance-${account.accountId}`}
                    inputMode="decimal"
                    className="font-mono text-right"
                    value={account.reportedBalance}
                    onChange={(event) => {
                      const parsed = Number(event.target.value.replace(/,/g, ""));
                      onChange(account.accountId, Number.isFinite(parsed) ? parsed : 0);
                    }}
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
