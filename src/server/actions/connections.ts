"use server";

import { decrypt } from "@/lib/crypto";
import { runIngestion } from "@/lib/ingestion";
import { revokeGoogleToken } from "@/lib/oauth/google";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function disconnectEmailAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Nothing to disconnect");

  const connection = await prisma.emailConnection.findUnique({ where: { id } });
  if (!connection) return fail("That connection no longer exists");

  if (connection.provider === "GMAIL") {
    // Best-effort - Google's token revocation has no strict server-side
    // requirement for us to succeed; the row is removed either way.
    await revokeGoogleToken(decrypt(connection.accessTokenEnc)).catch(() => undefined);
  }

  await prisma.emailConnection.delete({ where: { id } });

  revalidateApp();
  return done(`Disconnected ${connection.emailAddress}`);
}

export async function syncNowAction(
  _previous: ActionState,
): Promise<ActionState> {
  await requireAuth();

  const hasConnections = (await prisma.emailConnection.count()) > 0;
  if (!hasConnections) return fail("Connect a Gmail or Outlook account first");

  const result = await runIngestion();
  revalidateApp();
  return done(
    `Synced ${result.accountsSynced} account${result.accountsSynced === 1 ? "" : "s"} - ${result.staged} new item${result.staged === 1 ? "" : "s"} staged`,
  );
}
