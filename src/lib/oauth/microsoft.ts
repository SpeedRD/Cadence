/**
 * Microsoft identity platform OAuth 2.0 (Mail.Read) via raw fetch, mirroring
 * google.ts - no `@azure/msal-node` dependency for a handful of REST calls.
 */
const TENANT = process.env.MICROSOFT_TENANT_ID || "common";
const AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const ME_URL = "https://graph.microsoft.com/v1.0/me";

export const OUTLOOK_SCOPES = [
  "offline_access",
  "Mail.Read",
  "User.Read",
].join(" ");

function clientId(): string {
  const value = process.env.MICROSOFT_CLIENT_ID;
  if (!value) throw new Error("MICROSOFT_CLIENT_ID is not set");
  return value;
}

function clientSecret(): string {
  const value = process.env.MICROSOFT_CLIENT_SECRET;
  if (!value) throw new Error("MICROSOFT_CLIENT_SECRET is not set");
  return value;
}

export function buildMicrosoftAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface MicrosoftTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export async function exchangeMicrosoftCode(
  code: string,
  redirectUri: string,
): Promise<MicrosoftTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: OUTLOOK_SCOPES,
    }),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token exchange failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
  };
}

/** Microsoft rotates the refresh token on most refreshes - always store the new one. */
export async function refreshMicrosoftAccessToken(
  refreshToken: string,
): Promise<MicrosoftTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
      scope: OUTLOOK_SCOPES,
    }),
  });
  if (!response.ok) {
    throw new Error(`Microsoft token refresh failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresInSeconds: data.expires_in,
  };
}

export async function fetchMicrosoftEmail(accessToken: string): Promise<string> {
  const response = await fetch(`${ME_URL}?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Could not read the Microsoft account email: ${response.status}`);
  }
  const data = (await response.json()) as {
    mail?: string | null;
    userPrincipalName?: string;
  };
  const email = data.mail || data.userPrincipalName;
  if (!email) throw new Error("Microsoft did not return an email address");
  return email;
}
