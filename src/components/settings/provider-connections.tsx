import { Mail, Plug } from "lucide-react";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { disconnectEmailAction } from "@/server/actions/connections";

import type { ConnectionRow } from "@/lib/data/connections";

function formatSyncedAt(date: Date | null): string {
  if (!date) return "Never synced";
  return `Last synced ${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ProviderConnections({
  label,
  description,
  connectHref,
  connections,
}: {
  label: string;
  description: string;
  connectHref: string;
  connections: ConnectionRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No account connected yet.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {connection.emailAddress}
                  </p>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    {formatSyncedAt(connection.lastSyncedAt)}
                  </p>
                </div>
                <ConfirmDelete
                  id={connection.id}
                  action={disconnectEmailAction}
                  title={`Disconnect ${connection.emailAddress}?`}
                  description="Cadence stops syncing this mailbox. Transactions already staged or approved from it are kept."
                  confirmLabel="Disconnect"
                  keepLabel="Keep it"
                  deletedMessage="Disconnected"
                  trigger={
                    <Button variant="ghost" size="sm">
                      Disconnect
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}

        <Button asChild variant="outline" size="sm">
          <a href={connectHref}>
            <Plug className="size-3.5" />
            Connect {label} account
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
