import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { BPD_RATE_MAX_AGE_DAYS, isWithinFreshnessWindow } from "@/lib/bpd-rate-payload";
import { getBpdRates, readStoredBpdRateDates } from "@/lib/bpd-rates";

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
 * here is allowed to look like a cron failure: the bank blocks this server's
 * fetch by design (a GitHub Action feeds the rate through
 * /api/cron/bpd-rate/ingest), so a failed fetch is an ordinary outcome of a
 * cache warm, not an error, and the route answers 200 whatever happened - a
 * failure status would fail every night and bury real failures. What it does
 * not do is dress the outcome up: the log line and the body say whether a
 * fresh rate was stored, the stored one was kept (and from which date), or
 * the fetch failed, and a stored rate past the freshness window is warned
 * about. A real visit still refetches on demand regardless of what this run
 * found, and open.er-api.com remains the untouched fallback.
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

  type Outcome = "stored" | "kept" | "failed";
  let outcome: Outcome = "failed";
  let storedAsOf: string | null = null;
  let message = "[bpd-rate] fetch failed - no stored rate";
  try {
    const before = await readStoredBpdRateDates();
    const bpd = await getBpdRates();
    const after = await readStoredBpdRateDates();
    const now = new Date();
    storedAsOf = after ? after.asOf.toISOString().slice(0, 10) : null;

    if (bpd && after) {
      const rates = `USD sell ${bpd.dollarSellRate}, EUR sell ${Number(bpd.euroSellRate.toFixed(4))}`;
      // getBpdRates() writes the row only when it fetched one; a stored rate
      // it served as it was leaves fetchedAt alone.
      if (!before || after.fetchedAt.getTime() !== before.fetchedAt.getTime()) {
        outcome = "stored";
        message = `[bpd-rate] stored a fresh rate as of ${storedAsOf} (${rates})`;
      } else {
        outcome = "kept";
        message = `[bpd-rate] kept the stored rate from ${storedAsOf} (${rates}); it is inside the ${BPD_RATE_MAX_AGE_DAYS}-day freshness window`;
      }
    } else if (after) {
      const ageDays = Math.floor((now.getTime() - after.asOf.getTime()) / 86_400_000);
      if (isWithinFreshnessWindow(after.asOf, now)) {
        message = `[bpd-rate] fetch failed - the stored rate from ${storedAsOf} could not be used`;
      } else {
        message = `[bpd-rate] fetch failed - the stored rate from ${storedAsOf} is ${ageDays} days old, outside the ${BPD_RATE_MAX_AGE_DAYS}-day freshness window`;
        console.warn(
          `[bpd-rate] the stored Banco Popular rate from ${storedAsOf} is ${ageDays} days old, older than the ${BPD_RATE_MAX_AGE_DAYS}-day freshness window; conversions fall back to open.er-api.com until the scraper stores a new one`,
        );
      }
    }
  } catch (error) {
    message = "[bpd-rate] cache warm failed";
    console.error(message, error);
    return NextResponse.json({ cached: false, outcome: "failed", storedAsOf, message });
  }

  console.log(message);
  return NextResponse.json({ cached: outcome !== "failed", outcome, storedAsOf, message });
}
