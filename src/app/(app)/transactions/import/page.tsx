import { ChevronLeft } from "lucide-react";
import Link from "next/link";

import { CsvImporter } from "@/components/import/csv-importer";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { getAppContext } from "@/lib/data/context";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Import CSV - Cadence" };

export default async function ImportPage() {
  const context = await getAppContext();
  const [accounts, categories] = await Promise.all([
    prisma.account.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/transactions">
          <ChevronLeft className="size-3.5" />
          Transactions
        </Link>
      </Button>

      <PageHeader
        title="Import CSV"
        description="Map three columns, check the preview, then commit. Imported rows are tagged with the CSV source."
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="Add an account first"
          description="Imported rows need an account to land in."
          action={
            <Button asChild size="sm">
              <Link href="/accounts">Go to accounts</Link>
            </Button>
          }
        />
      ) : (
        <CsvImporter
          accounts={accounts}
          categories={categories}
          defaultCurrency={accounts[0]?.currency ?? context.displayCurrency}
        />
      )}
    </div>
  );
}
