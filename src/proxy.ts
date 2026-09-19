import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

const PUBLIC_PATHS = new Set(["/login"]);

/**
 * Routes with their own non-session auth (a bearer secret checked inside the
 * route handler) instead of the PIN session - Vercel Cron and the GitHub
 * Actions scraper never carry our session cookie.
 */
const BEARER_AUTH_PATHS = new Set([
  "/api/cron/ingest",
  "/api/cron/recurring",
  "/api/cron/bpd-rate",
  "/api/cron/bpd-rate/ingest",
]);

/**
 * Gate every route behind the PIN session. This is the optimistic check - each
 * protected page and every server action also calls requireAuth().
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (BEARER_AUTH_PATHS.has(pathname)) return NextResponse.next();

  const isPublic = PUBLIC_PATHS.has(pathname);
  const authenticated = verifySessionToken(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  if (!authenticated && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (authenticated && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, static files, and the installability
    // routes (src/app/manifest.ts, icon.tsx, apple-icon.tsx): a browser
    // installing the app fetches those without a session, and a redirect to
    // /login would leave it with no manifest and a screenshot for an icon.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon/|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};
