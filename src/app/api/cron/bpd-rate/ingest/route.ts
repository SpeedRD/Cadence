import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isPlausibleDopRate } from "@/lib/bpd-rate-payload";
import { storeBpdRates } from "@/lib/bpd-rates";

/**
 * Ingestion endpoint for the browser-driven Banco Popular scraper
 * (scripts/scrape-bpd-rate.ts, run daily by .github/workflows/scrape-bpd-rate.yml).
 *
 * The bank's feed sits behind bot protection that refuses every bare HTTP
 * client, so neither the on-demand fetch in src/lib/bpd-rates.ts nor the
 * Vercel cron at /api/cron/bpd-rate can read it from a server; a real
 * browser can. The scraper captures the payload in a browser and POSTs the
 * three fields this app uses here; this route re-validates them and hands
 * them to storeBpdRates(), the same function the on-demand path writes
 * through - so the plausibility bounds and the freshness window are
 * enforced in one place regardless of which path found the rate.
 *
 * Not session-gated (a GitHub Actions job carries no session cookie):
 * BPD_SCRAPE_INGEST_SECRET is the only guard, so it must be set in
 * production, and the path must stay in BEARER_AUTH_PATHS (src/proxy.ts).
 *
 *   curl -X POST -H "Authorization: Bearer $BPD_SCRAPE_INGEST_SECRET" \
 *        -H "Content-Type: application/json" \
 *        -d '{"dollarSellRate":60.05,"euroSellRate":70.7,"asOf":"2026-09-18T00:00:00Z"}' \
 *        https://your-app.vercel.app/api/cron/bpd-rate/ingest
 *
 * Every refusal is a 4xx with a `reason`, and writes nothing: the scraper
 * treats anything but a 200 as a failed run so it shows up in the Actions
 * tab rather than silently doing nothing.
 */

const ingestBodySchema = z.object({
  dollarSellRate: z.number(),
  euroSellRate: z.number(),
  /** The bank's own BuySellRatesAsOf, as an ISO-8601 timestamp. */
  asOf: z.string(),
});

export async function POST(request: NextRequest) {
  const secret = process.env.BPD_SCRAPE_INGEST_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "BPD_SCRAPE_INGEST_SECRET is not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ stored: false, reason: "malformed" }, { status: 400 });
  }
  const parsed = ingestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ stored: false, reason: "malformed" }, { status: 400 });
  }

  // Defense in depth: the scraper already applied these bounds, but a
  // scraper is a separate deployable that could drift or be replaced, so the
  // server never trusts its check alone.
  const { dollarSellRate, euroSellRate } = parsed.data;
  if (!isPlausibleDopRate(dollarSellRate) || !isPlausibleDopRate(euroSellRate)) {
    return NextResponse.json({ stored: false, reason: "out_of_range" }, { status: 400 });
  }
  const asOf = new Date(parsed.data.asOf);
  if (Number.isNaN(asOf.getTime())) {
    return NextResponse.json({ stored: false, reason: "invalid_as_of" }, { status: 400 });
  }

  const result = await storeBpdRates({ dollarSellRate, euroSellRate, asOf });
  if (!result.ok) {
    return NextResponse.json({ stored: false, reason: result.reason }, { status: 400 });
  }

  console.log(
    `[bpd-rate-ingest] stored Banco Popular rate (USD sell ${dollarSellRate}, EUR sell ${euroSellRate}, as of ${asOf.toISOString()})`,
  );
  return NextResponse.json({
    stored: true,
    dollarSellRate,
    euroSellRate,
    asOf: asOf.toISOString(),
  });
}
