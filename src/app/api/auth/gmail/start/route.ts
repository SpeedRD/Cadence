import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildGoogleAuthUrl, gmailRedirectUri } from "@/lib/oauth/google";
import { createOAuthState, setOAuthStateCookie } from "@/lib/oauth/state";

export async function GET(request: NextRequest) {
  await requireAuth();

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    const url = new URL("/settings/connections", request.url);
    url.searchParams.set(
      "error",
      "Google OAuth isn't configured yet - set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see PHASE2.md)",
    );
    return NextResponse.redirect(url);
  }

  if (process.env.NODE_ENV === "production" && !process.env.APP_URL) {
    const url = new URL("/settings/connections", request.url);
    url.searchParams.set(
      "error",
      "Google OAuth isn't configured yet - set APP_URL (see PHASE2.md)",
    );
    return NextResponse.redirect(url);
  }

  const redirectUri = gmailRedirectUri(request);
  const state = createOAuthState();
  const response = NextResponse.redirect(buildGoogleAuthUrl(redirectUri, state));
  setOAuthStateCookie(response, "gmail", state);
  return response;
}
