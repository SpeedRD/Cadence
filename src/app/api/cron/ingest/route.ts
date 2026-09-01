import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { runIngestion } from "@/lib/ingestion";

// Each candidate email is one LLM call; give a full sync run room to finish.
// Lower this (and MAX_CANDIDATES_PER_ACCOUNT in lib/ingestion.ts) if your
// Vercel plan caps function duration below this.
export const maxDuration = 60;

/**
 * Triggered by Vercel Cron (see the `crons` entry in vercel.json) or manually:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/ingest
 *
 * Not session-gated (Vercel Cron sends no session cookie) - CRON_SECRET is the
 * only guard, so it must be set in production.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runIngestion();
  return NextResponse.json(result);
}
