import { AffordCalculator } from "@/components/afford/afford-calculator";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { getAppContext } from "@/lib/data/context";
import { HISTORY_PERIODS } from "@/lib/data/payday";
import { toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Afford - Cadence" };

/**
 * A pure calculator until its last step: nothing on this page writes until
 * "I bought this", which creates one self-limiting recurring subscription -
 * see confirmAffordPurchase in src/lib/data/afford.ts.
 */
export default async function AffordPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).afford;
  const accounts = await prisma.account.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, currency: true },
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t.title} description={t.description} />
      {accounts.length === 0 ? (
        <EmptyState title={t.noAccountsTitle} description={t.noAccountsDescription} />
      ) : (
        <AffordCalculator
          accounts={accounts}
          defaultCurrency={context.displayCurrency}
          today={toISODate(context.today)}
          historyPeriods={HISTORY_PERIODS}
          locale={context.language}
        />
      )}
    </div>
  );
}
