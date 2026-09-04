import { decrypt, encrypt } from "@/lib/crypto";
import { refreshGoogleAccessToken } from "@/lib/oauth/google";
import { refreshMicrosoftAccessToken } from "@/lib/oauth/microsoft";
import { prisma } from "@/lib/prisma";

import type { EmailConnection } from "@/generated/prisma/client";

/** Refresh a bit before the real expiry so a slow request doesn't land mid-call. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function isStillFresh(expiresAt: Date): boolean {
  return expiresAt.getTime() - EXPIRY_SAFETY_MARGIN_MS > Date.now();
}

/**
 * Stores a freshly refreshed token pair, but only if nothing else refreshed this
 * connection in the meantime. The cron run and a manual "Sync now" can overlap,
 * and Microsoft rotates the refresh token on use: whoever refreshes second is
 * holding a token the provider has already retired, so letting it write would
 * leave the row with a dead refresh token and break the mailbox until the user
 * reconnects.
 *
 * `accessTokenExpiresAt` is the compare-and-swap key. Every refresh rewrites it,
 * and it is the one column that can be compared, since `encrypt()` uses a random
 * IV and so never produces the same ciphertext twice for the same token.
 *
 * Returns the access token the caller should use: its own when the swap landed,
 * otherwise the one the winner stored.
 */
async function persistRefreshedTokens(
  connection: EmailConnection,
  tokens: { accessToken: string; refreshToken?: string; expiresInSeconds: number },
): Promise<string> {
  const { count } = await prisma.emailConnection.updateMany({
    where: {
      id: connection.id,
      // The expiry as it was read before the refresh call went out. A concurrent
      // refresh has already moved it, so the slower writer updates no rows.
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
    },
    data: {
      accessTokenEnc: encrypt(tokens.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      ...(tokens.refreshToken
        ? { refreshTokenEnc: encrypt(tokens.refreshToken) }
        : {}),
    },
  });
  if (count > 0) {
    return tokens.accessToken;
  }

  // Lost the race, so this call writes nothing. The winner's access token is the
  // one that matches the stored refresh token, so prefer it; fall back to the
  // token this call just obtained, which is live either way, if the row somehow
  // holds nothing usable.
  const winner = await prisma.emailConnection.findUnique({
    where: { id: connection.id },
  });
  return winner && isStillFresh(winner.accessTokenExpiresAt)
    ? decrypt(winner.accessTokenEnc)
    : tokens.accessToken;
}

/**
 * Returns a live access token for the connection, refreshing and persisting a
 * new one first if the stored token is at or past its safety margin.
 */
export async function getValidAccessToken(
  connection: EmailConnection,
): Promise<string> {
  if (isStillFresh(connection.accessTokenExpiresAt)) {
    return decrypt(connection.accessTokenEnc);
  }

  const refreshToken = decrypt(connection.refreshTokenEnc);

  if (connection.provider === "GMAIL") {
    // Google keeps the refresh token valid across refreshes, so only the access
    // token is written - but through the same compare-and-swap, so two
    // overlapping runs cannot leave the row holding the older of two tokens.
    const tokens = await refreshGoogleAccessToken(refreshToken);
    return persistRefreshedTokens(connection, {
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
    });
  }

  const tokens = await refreshMicrosoftAccessToken(refreshToken);
  return persistRefreshedTokens(connection, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresInSeconds: tokens.expiresInSeconds,
  });
}
