import { prisma } from "@/lib/prisma";

import type { EmailProvider } from "@/generated/prisma/enums";

export interface ConnectionRow {
  id: string;
  provider: EmailProvider;
  emailAddress: string;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

/** Never selects the encrypted token columns - this is read-only display data. */
export async function listConnections(): Promise<ConnectionRow[]> {
  return prisma.emailConnection.findMany({
    orderBy: [{ provider: "asc" }, { emailAddress: "asc" }],
    select: {
      id: true,
      provider: true,
      emailAddress: true,
      lastSyncedAt: true,
      createdAt: true,
    },
  });
}
