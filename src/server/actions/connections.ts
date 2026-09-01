"use server";

import { decrypt } from "@/lib/crypto";
import { runIngestion } from "@/lib/ingestion";
import { revokeGoogleToken } from "@/lib/oauth/google";
import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function disconnectEmailAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.nothingToDisconnect);

  const connection = await prisma.emailConnection.findUnique({ where: { id } });
  if (!connection) return fail(t.connectionNoLongerExists);

  if (connection.provider === "GMAIL") {
    // Best-effort - Google's token revocation has no strict server-side
    // requirement for us to succeed; the row is removed either way.
    await revokeGoogleToken(decrypt(connection.accessTokenEnc)).catch(() => undefined);
  }

  await prisma.emailConnection.delete({ where: { id } });

  revalidateApp();
  return done(t.disconnected(connection.emailAddress));
}

export async function syncNowAction(
  _previous: ActionState,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;

  const hasConnections = (await prisma.emailConnection.count()) > 0;
  if (!hasConnections) return fail(t.connectFirst);

  const result = await runIngestion();
  revalidateApp();
  return done(t.syncedResult(result.accountsSynced, result.staged));
}
