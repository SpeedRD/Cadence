import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { today } from "@/lib/date";
import {
  describeRecurringPosting,
  postDueRecurringItems,
} from "@/lib/recurring-posting";

/**
 * Posts every recurring item that is due (or overdue) as real transactions and
 * goal contributions - see src/lib/recurring-posting.ts. Triggered daily by
 * Vercel Cron (see the `crons` entry in vercel.json) or manually:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/recurring
 *
 * Not session-gated (Vercel Cron sends no session cookie) - CRON_SECRET is the
 * only guard, so it must be set in production. Opening the app runs the very
 * same function as a catch-up (getAppContext), so a missed cron day is never
 * lost and the two can't double-post.
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

  const result = await postDueRecurringItems(today());
  const message = describeRecurringPosting(result);
  console.log(message);
  return NextResponse.json({ ...result, message });
}
