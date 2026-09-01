import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { exchangeMicrosoftCode, fetchMicrosoftEmail } from "@/lib/oauth/microsoft";
import { clearOAuthState, consumeOAuthState } from "@/lib/oauth/state";
import { prisma } from "@/lib/prisma";

function redirectWith(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/settings/connections", request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  clearOAuthState(response, "outlook");
  return response;
}

export async function GET(request: NextRequest) {
  await requireAuth();

  const { searchParams } = request.nextUrl;
  if (searchParams.get("error")) {
    return redirectWith(request, { error: "Microsoft sign-in was cancelled" });
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !consumeOAuthState(request, "outlook", state)) {
    return redirectWith(request, { error: "That sign-in link expired - try again" });
  }

  try {
    const redirectUri = new URL("/api/auth/outlook/callback", request.url).toString();
    const tokens = await exchangeMicrosoftCode(code, redirectUri);
    if (!tokens.refreshToken) {
      return redirectWith(request, {
        error: "Microsoft didn't grant offline access - try connecting again",
      });
    }

    const emailAddress = await fetchMicrosoftEmail(tokens.accessToken);
    const accessTokenExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000);

    await prisma.emailConnection.upsert({
      where: { provider_emailAddress: { provider: "OUTLOOK", emailAddress } },
      create: {
        provider: "OUTLOOK",
        emailAddress,
        accessTokenEnc: encrypt(tokens.accessToken),
        refreshTokenEnc: encrypt(tokens.refreshToken),
        accessTokenExpiresAt,
      },
      update: {
        accessTokenEnc: encrypt(tokens.accessToken),
        refreshTokenEnc: encrypt(tokens.refreshToken),
        accessTokenExpiresAt,
      },
    });

    return redirectWith(request, { connected: emailAddress });
  } catch (error) {
    console.error("Outlook OAuth callback failed:", error);
    return redirectWith(request, { error: "Could not connect that Outlook account" });
  }
}
