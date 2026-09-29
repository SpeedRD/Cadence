import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { postingFailureReason } from "@/lib/data/context";
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
 *
 * Answers 500 when the run threw or any item failed to post (itemsFailed is in
 * the body), 200 otherwise. Items that did post stay posted; a failed one is
 * retried by the next run.
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

  let result;
  try {
    result = await postDueRecurringItems(today());
  } catch (error) {
    console.error("[recurring] posting run failed", error);
    return NextResponse.json({ ok: false, error: postingFailureReason(error) }, { status: 500 });
  }
  const message = describeRecurringPosting(result);
  const failed = result.itemsFailed > 0;
  if (failed) console.error(message);
  else console.log(message);
  return NextResponse.json({ ok: !failed, ...result, message }, { status: failed ? 500 : 200 });
}
