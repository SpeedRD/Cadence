import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { ActionButton } from "@/components/form/action-button";
import { PageHeader } from "@/components/page-header";
import { ProviderConnections } from "@/components/settings/provider-connections";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getAppContext } from "@/lib/data/context";
import { listConnections } from "@/lib/data/connections";
import { getDictionary } from "@/lib/i18n";
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
  const context = await getAppContext();
  const t = getDictionary(context.language).settingsPage;
  const common = getDictionary(context.language).common;
  const connections = await listConnections();
  const gmail = connections.filter((c) => c.provider === "GMAIL");
  const outlook = connections.filter((c) => c.provider === "OUTLOOK");

  const connected = single(params.connected);
  const error = single(params.error);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.connectionsTitle}
        description={t.connectionsDescription}
        actions={
          <>
            <ActionButton action={syncNowAction} size="sm">
              <RefreshCw className="size-3.5" />
              {t.syncNow}
            </ActionButton>
            <Link href="/review" className="text-sm text-muted-foreground hover:text-foreground">
              {t.reviewQueue}
            </Link>
          </>
        }
      />

      {connected ? (
        <Alert>
          <AlertDescription>{t.connectedTo(connected)}</AlertDescription>
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
          description={t.gmailDescription}
          connectHref="/api/auth/gmail/start"
          connections={gmail}
          t={t}
          common={common}
        />
        <ProviderConnections
          label="Outlook"
          description={t.outlookDescription}
          connectHref="/api/auth/outlook/start"
          connections={outlook}
          t={t}
          common={common}
        />
      </div>
    </div>
  );
}
