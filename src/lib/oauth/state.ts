import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

/**
 * CSRF guard for the OAuth redirect dance: the `state` value round-tripped
 * through the provider must match a short-lived, httpOnly cookie set right
 * before the redirect. One cookie per provider so a Gmail and Outlook connect
 * flow can be started back to back without clobbering each other.
 */
function cookieName(provider: string): string {
  return `cadence_oauth_state_${provider}`;
}

export function createOAuthState(): string {
  return randomUUID();
}

export function setOAuthStateCookie(
  response: NextResponse,
  provider: string,
  state: string,
): void {
  response.cookies.set(cookieName(provider), state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
}

export function consumeOAuthState(
  request: NextRequest,
  provider: string,
  receivedState: string | null,
): boolean {
  const expected = request.cookies.get(cookieName(provider))?.value;
  return Boolean(expected && receivedState && expected === receivedState);
}

export function clearOAuthState(response: NextResponse, provider: string): void {
  response.cookies.delete(cookieName(provider));
}
