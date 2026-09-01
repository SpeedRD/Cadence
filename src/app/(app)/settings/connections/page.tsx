import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { ActionButton } from "@/components/form/action-button";
import { PageHeader } from "@/components/page-header";
import { ProviderConnections } from "@/components/settings/provider-connections";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { listConnections } from "@/lib/data/connections";
import { syncNowAction } from "@/server/actions/connections";

export const metadata = { title: "Connections - Cadence" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value || undefined;
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const connections = await listConnections();
  const gmail = connections.filter((c) => c.provider === "GMAIL");
  const outlook = connections.filter((c) => c.provider === "OUTLOOK");

  const connected = single(params.connected);
  const error = single(params.error);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connections"
        description="Gmail and Outlook accounts Cadence pulls transactional emails from."
        actions={
          <>
            <ActionButton action={syncNowAction} size="sm">
              <RefreshCw className="size-3.5" />
              Sync now
            </ActionButton>
            <Link href="/review" className="text-sm text-muted-foreground hover:text-foreground">
              Review queue
            </Link>
          </>
        }
      />

      {connected ? (
        <Alert>
          <AlertDescription>Connected {connected}.</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <ProviderConnections
          label="Gmail"
          description="Reads receipts, invoices and subscription emails (gmail.readonly)."
          connectHref="/api/auth/gmail/start"
          connections={gmail}
        />
        <ProviderConnections
          label="Outlook"
          description="Reads the same kinds of emails via Microsoft Graph (Mail.Read)."
          connectHref="/api/auth/outlook/start"
          connections={outlook}
        />
      </div>
    </div>
  );
}
