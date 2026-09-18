/**
 * Captures Banco Popular Dominicano's published exchange rate with a real
 * browser and posts it to Cadence's ingestion endpoint.
 *
 *   CADENCE_APP_URL=https://your-app.vercel.app \
 *   BPD_SCRAPE_INGEST_SECRET=... \
 *   npx tsx scripts/scrape-bpd-rate.ts
 *
 *   npx tsx scripts/scrape-bpd-rate.ts --dry-run   # scrape and print; post nothing
 *
 * Why a browser: the bank's feed (BPD_RATES_API_URL) sits behind Imperva
 * Incapsula bot protection, which answers every bare HTTP client - curl,
 * Node fetch, the on-demand fetchBpdRates() in src/lib/bpd-rates.ts, the
 * Vercel cron at /api/cron/bpd-rate - with a 403 challenge page. A real,
 * unmodified Chromium loads the site normally, runs the site's own challenge
 * script as any visitor's browser would, and can then read the JSON feed
 * from inside the page. That is the whole trick, and it is deliberately the
 * only one: no spoofed headers, proxies or fingerprint changes. If the site
 * ever refuses a genuine browser too, this script fails and the workflow run
 * goes red; it must not be "fixed" by disguising the browser.
 *
 * Why headed: observed 2026-09-18, Playwright's headless shell is parked on
 * the protection's "Loading..." interstitial for minutes (one run took ~4
 * minutes to get past it, another was still there at 5), while the same
 * Chromium started headed - its ordinary mode, nothing altered - was served
 * the page and the feed in under ten seconds. On a Linux runner with no
 * display the workflow wraps this in `xvfb-run`, which is the standard way
 * to run a headed browser in CI.
 *
 * Run daily by .github/workflows/scrape-bpd-rate.yml. On any failure -
 * page unreachable, payload not JSON, fields missing, a rate outside the
 * plausibility bounds, an asOf outside the freshness window - the script
 * exits non-zero WITHOUT calling the endpoint, so a failed scrape can never
 * write anything. The endpoint re-checks everything anyway (storeBpdRates
 * in src/lib/bpd-rates.ts); the bounds below are the same functions, not a
 * copy.
 */
import { chromium, type Page } from "playwright";

import {
  BPD_RATE_MAX_AGE_DAYS,
  BPD_RATES_API_URL,
  type BpdRates,
  isWithinFreshnessWindow,
  parseBpdPayload,
} from "../src/lib/bpd-rate-payload";

/** The page a visitor would land on; the feed is read from inside it. */
const BPD_SITE_URL = "https://popularenlinea.com/";
const INGEST_PATH = "/api/cron/bpd-rate/ingest";

/**
 * The bot-protection challenge runs on first load and the site is then
 * served on the next request. A few in-page attempts with a short pause
 * between them cover that and an ordinary slow response; more would only
 * delay the inevitable red run.
 */
const FETCH_ATTEMPTS = 4;
const RETRY_DELAY_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const POST_TIMEOUT_MS = 30_000;

class ScrapeError extends Error {}

const dryRun = process.argv.includes("--dry-run");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ScrapeError(`${name} is not set`);
  return value;
}

/** Everything the endpoint needs, resolved before the browser starts so a misconfigured job fails in a second, not a minute. */
function resolveTarget(): { url: string; secret: string } | null {
  if (dryRun) return null;
  const origin = requiredEnv("CADENCE_APP_URL").replace(/\/+$/, "");
  const secret = requiredEnv("BPD_SCRAPE_INGEST_SECRET");
  return { url: `${origin}${INGEST_PATH}`, secret };
}

interface InPageFetchResult {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * Reads the feed from inside the loaded page - a same-origin fetch the page
 * itself could have made, carrying whatever the browser attaches for this
 * site (the challenge cookie included). Returns the raw status and body so
 * the caller can decide, and never throws for an HTTP error.
 */
async function fetchFeedInPage(page: Page): Promise<InPageFetchResult> {
  return page.evaluate(async (url: string) => {
    const response = await fetch(url, {
      headers: { Accept: "application/json;odata=verbose" },
      credentials: "include",
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }, BPD_RATES_API_URL);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(result: InPageFetchResult): string {
  const snippet = result.body.replace(/\s+/g, " ").slice(0, 120);
  return `status ${result.status}, content-type ${result.contentType ?? "none"}, body starts "${snippet}"`;
}

async function scrape(): Promise<BpdRates> {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    console.log(`[scrape-bpd-rate] loading ${BPD_SITE_URL}`);
    await page.goto(BPD_SITE_URL, { waitUntil: "domcontentloaded" });

    let lastResult: InPageFetchResult | null = null;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      // The challenge page finishes its own script and reloads on its own;
      // give it a moment to settle before asking the feed.
      await page.waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
      const result = await fetchFeedInPage(page);
      lastResult = result;
      const isJson = result.contentType?.includes("json") ?? false;
      if (result.status === 200 && isJson) {
        let payload: unknown;
        try {
          payload = JSON.parse(result.body);
        } catch {
          throw new ScrapeError(`feed answered 200 with JSON content-type but an unparseable body (${describe(result)})`);
        }
        const rates = parseBpdPayload(payload);
        if (!rates) {
          throw new ScrapeError(
            `feed payload failed validation - missing fields, or a rate outside the plausible band (${describe(result)})`,
          );
        }
        return rates;
      }
      console.log(`[scrape-bpd-rate] attempt ${attempt}/${FETCH_ATTEMPTS}: feed not ready (${describe(result)})`);
      if (attempt < FETCH_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
        await page.reload({ waitUntil: "domcontentloaded" });
      }
    }
    throw new ScrapeError(
      `feed never answered with JSON after ${FETCH_ATTEMPTS} attempts (last: ${lastResult ? describe(lastResult) : "no response"})`,
    );
  } finally {
    await browser.close();
  }
}

async function post(target: { url: string; secret: string }, rates: BpdRates): Promise<void> {
  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dollarSellRate: rates.dollarSellRate,
      euroSellRate: rates.euroSellRate,
      asOf: rates.asOf.toISOString(),
    }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new ScrapeError(`ingestion endpoint refused the rate: HTTP ${response.status} ${body}`);
  }
  console.log(`[scrape-bpd-rate] stored: ${body}`);
}

async function main(): Promise<void> {
  const target = resolveTarget();

  const rates = await scrape();
  console.log(
    `[scrape-bpd-rate] captured USD sell ${rates.dollarSellRate}, EUR sell ${rates.euroSellRate}, as of ${rates.asOf.toISOString()}`,
  );

  if (!isWithinFreshnessWindow(rates.asOf, new Date())) {
    throw new ScrapeError(
      `the bank's rate is dated ${rates.asOf.toISOString()}, outside the ${BPD_RATE_MAX_AGE_DAYS}-day freshness window - not posting it`,
    );
  }

  if (!target) {
    console.log("[scrape-bpd-rate] dry run: nothing posted");
    return;
  }
  await post(target, rates);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[scrape-bpd-rate] FAILED: ${message}`);
  process.exitCode = 1;
});
