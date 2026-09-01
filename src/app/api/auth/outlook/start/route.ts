import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { buildMicrosoftAuthUrl } from "@/lib/oauth/microsoft";
import { createOAuthState, setOAuthStateCookie } from "@/lib/oauth/state";

export async function GET(request: NextRequest) {
  await requireAuth();

  if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
    const url = new URL("/settings/connections", request.url);
    url.searchParams.set(
      "error",
      "Microsoft OAuth isn't configured yet - set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (see PHASE2.md)",
    );
    return NextResponse.redirect(url);
  }

  const redirectUri = new URL("/api/auth/outlook/callback", request.url).toString();
  const state = createOAuthState();
  const response = NextResponse.redirect(buildMicrosoftAuthUrl(redirectUri, state));
  setOAuthStateCookie(response, "outlook", state);
  return response;
}
