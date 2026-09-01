import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildGoogleAuthUrl } from "@/lib/oauth/google";
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

  const redirectUri = new URL("/api/auth/gmail/callback", request.url).toString();
  const state = createOAuthState();
  const response = NextResponse.redirect(buildGoogleAuthUrl(redirectUri, state));
  setOAuthStateCookie(response, "gmail", state);
  return response;
}
