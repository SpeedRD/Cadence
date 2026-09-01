import Link from "next/link";

import { EmptyState } from "@/components/stat";
import { PageHeader } from "@/components/page-header";
import { ReviewTable } from "@/components/review/review-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listStagedTransactions } from "@/lib/data/staged";
import { labelFor, SOURCE_LABELS } from "@/lib/labels";
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
        title="Review queue"
        description={`${pendingCount} pending item${pendingCount === 1 ? "" : "s"} from connected inboxes.`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={showReviewed ? "/review" : "/review?reviewed=1"}>
              {showReviewed ? "Hide reviewed" : "Show reviewed"}
            </Link>
          </Button>
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="Add an account first"
          description="Approving a staged item needs somewhere to put it."
          action={
            <Button asChild size="sm">
              <Link href="/accounts">Go to accounts</Link>
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing to review"
          description={
            showReviewed
              ? "No staged items yet - connect an inbox and sync to get started."
              : "No pending items. Approved and rejected items stay hidden - use “Show reviewed” to see them."
          }
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/connections">Manage connections</Link>
            </Button>
          }
        />
      ) : (
        [...bySource.entries()].map(([source, sourceRows]) => (
          <Card key={source} className="py-0">
            <CardHeader className="pt-5">
              <CardTitle>
                {labelFor(SOURCE_LABELS, source)}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({sourceRows.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ReviewTable rows={sourceRows} accounts={accounts} categories={categories} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
