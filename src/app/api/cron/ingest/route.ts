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
 *
 * Answers 500 when any connection failed to sync or any message could not be
 * parsed (the counts are in the body), so a monitor sees a partial sync. The
 * work that did succeed is kept either way, and the next run reads what failed
 * again.
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
  const failed = result.accountsFailed > 0 || result.messagesFailed > 0;
  const summary = `[ingest] ${result.accountsSynced} account(s) synced, ${result.accountsFailed} failed; ${result.staged} staged; ${result.messagesFailed} message(s) could not be parsed`;
  if (failed) console.error(summary);
  else console.log(summary);
  return NextResponse.json({ ok: !failed, ...result }, { status: failed ? 500 : 200 });
}
