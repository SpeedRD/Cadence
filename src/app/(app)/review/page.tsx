import Link from "next/link";

import { EmptyState } from "@/components/stat";
import { PageHeader } from "@/components/page-header";
import { ReviewTable } from "@/components/review/review-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { listStagedTransactions } from "@/lib/data/staged";
import { getDictionary } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Review - Cadence" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value || undefined;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const context = await getAppContext();
  const t = getDictionary(context.language).review;
  const common = getDictionary(context.language).common;

  const params = await searchParams;
  const showReviewed = single(params.reviewed) === "1";

  const [rows, accounts, categories] = await Promise.all([
    listStagedTransactions({ includeReviewed: showReviewed }),
    prisma.account.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  const bySource = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySource.get(row.source) ?? [];
    list.push(row);
    bySource.set(row.source, list);
  }
  const pendingCount = rows.filter((row) => row.status === "PENDING").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.pendingItems(pendingCount)}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={showReviewed ? "/review" : "/review?reviewed=1"}>
              {showReviewed ? t.hideReviewed : t.showReviewed}
            </Link>
          </Button>
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          title={t.addAccountFirstTitle}
          description={t.needAccountDescription}
          action={
            <Button asChild size="sm">
              <Link href="/accounts">{t.goToAccounts}</Link>
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t.nothingToReviewTitle}
          description={showReviewed ? t.noStagedYet : t.noPendingItems}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/connections">{t.manageConnections}</Link>
            </Button>
          }
        />
      ) : (
        [...bySource.entries()].map(([source, sourceRows]) => (
          <Card key={source} className="py-0">
            <CardHeader className="pt-5">
              <CardTitle>
                {labelFor(common.sourceLabels, source)}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({sourceRows.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ReviewTable
                rows={sourceRows}
                accounts={accounts}
                categories={categories}
                locale={context.language}
              />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
