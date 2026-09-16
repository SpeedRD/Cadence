import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getBpdRates } from "@/lib/bpd-rates";

/**
 * Proactively warms the same-day Banco Popular rate getRateTable() already
 * prefers over open.er-api.com whenever one is cached (src/lib/rates.ts), so
 * it's ready before tomorrow even on a day nobody opens the app. Triggered
 * daily by Vercel Cron at 01:00 UTC - 9pm Dominican Republic time, chosen
 * with real buffer past the bank's observed (not tightly predictable)
 * publish time (see the `crons` entry in vercel.json) - or manually:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/bpd-rate
 *
 * getBpdRates() already owns its own timeout, freshness check, and caching
 * (src/lib/bpd-rates.ts); this route only triggers it on a schedule. Nothing
 * here is allowed to look like a cron failure: the bank not having published
 * yet, or a timeout, is an ordinary outcome of a cache warm, not an error, so
 * it's logged and swallowed rather than thrown or returned as a failure
 * status - a real visit still refetches on demand regardless of what this
 * run found, and open.er-api.com remains the untouched fallback.
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

  let cached = false;
  let message = "[bpd-rate] no same-day Banco Popular rate available yet";
  try {
    const bpd = await getBpdRates();
    if (bpd) {
      cached = true;
      message = `[bpd-rate] cached today's rate (USD sell ${bpd.dollarSellRate}, EUR sell ${bpd.euroSellRate})`;
    }
  } catch (error) {
    message = "[bpd-rate] cache warm failed";
    console.error(message, error);
    return NextResponse.json({ cached: false, message });
  }

  console.log(message);
  return NextResponse.json({ cached, message });
}
