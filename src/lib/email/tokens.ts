import { decrypt, encrypt } from "@/lib/crypto";
import { refreshGoogleAccessToken } from "@/lib/oauth/google";
import { refreshMicrosoftAccessToken } from "@/lib/oauth/microsoft";
import { prisma } from "@/lib/prisma";

import type { EmailConnection } from "@/generated/prisma/client";

/** Refresh a bit before the real expiry so a slow request doesn't land mid-call. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * Returns a live access token for the connection, refreshing and persisting a
 * new one first if the stored token is at or past its safety margin.
 */
export async function getValidAccessToken(
  connection: EmailConnection,
): Promise<string> {
  const stillFresh =
    connection.accessTokenExpiresAt.getTime() - EXPIRY_SAFETY_MARGIN_MS >
    Date.now();
  if (stillFresh) {
    return decrypt(connection.accessTokenEnc);
  }

  const refreshToken = decrypt(connection.refreshTokenEnc);

  if (connection.provider === "GMAIL") {
    const tokens = await refreshGoogleAccessToken(refreshToken);
    await prisma.emailConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: encrypt(tokens.accessToken),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      },
    });
    return tokens.accessToken;
  }

  const tokens = await refreshMicrosoftAccessToken(refreshToken);
  await prisma.emailConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: encrypt(tokens.refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
    },
  });
  return tokens.accessToken;
}
