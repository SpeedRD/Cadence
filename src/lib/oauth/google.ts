import type { NextRequest } from "next/server";

/**
 * Google OAuth 2.0 (gmail.readonly) via raw fetch - the project has no other
 * Google dependency, so pulling in `googleapis` for a handful of REST calls
 * would be a heavy addition for little benefit.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const CALLBACK_PATH = "/api/auth/gmail/callback";

/**
 * The redirect URI Google requires to be byte-identical between the
 * authorization request and the token exchange, and to exactly match an
 * Authorized redirect URI configured on the OAuth client. Vercel gives every
 * deployment (including previews) its own hostname, so deriving this from
 * the incoming request would produce a different, unregistered redirect_uri
 * per deployment - and would let a spoofed Host header pick the callback
 * origin. Production therefore requires APP_URL, a stable value set once in
 * Vercel project settings; local dev (where APP_URL is normally unset) falls
 * back to the request's own origin, e.g. http://localhost:3000.
 */
export function gmailRedirectUri(request: NextRequest): string {
  const appUrl = process.env.APP_URL;
  if (appUrl) return new URL(CALLBACK_PATH, appUrl).toString();
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_URL is not set - required for Gmail OAuth in production (see PHASE2.md)");
  }
  return new URL(CALLBACK_PATH, request.url).toString();
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function clientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID;
  if (!value) throw new Error("GOOGLE_CLIENT_ID is not set");
  return value;
}

function clientSecret(): string {
  const value = process.env.GOOGLE_CLIENT_SECRET;
  if (!value) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return value;
}

export function buildGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    // Forces Google to return a refresh_token even on a repeat connect.
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresInSeconds: data.expires_in,
  };
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
}

/** Best-effort - the connection row is deleted locally either way. */
export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
  }).catch(() => undefined);
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Could not read the Google account email: ${response.status}`);
  }
  const data = (await response.json()) as { email?: string };
  if (!data.email) throw new Error("Google did not return an email address");
  return data.email;
}
