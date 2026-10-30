/**
 * Fills BpdRatePublication with the Banco Popular sell rates the scraper
 * captured before the table existed, read from the scrape-bpd-rate
 * workflow's GitHub Actions run logs - the only record of them:
 *
 *   DATABASE_URL="postgres://..." npx tsx scripts/backfill-bpd-rate-history.ts            # dry run
 *   DATABASE_URL="postgres://..." npx tsx scripts/backfill-bpd-rate-history.ts --apply    # writes
 *
 * Needs the gh CLI, signed in with read access to this repository's Actions
 * (`gh auth status`); `--repo owner/name` reads another checkout's runs. Run
 * logs expire after 90 days, so a run whose log is gone (or still unreadable
 * after LOG_ATTEMPTS tries) is listed and skipped; running it again picks up
 * what a transient failure missed.
 *
 * Every line scripts/scrape-bpd-rate.ts logged as "captured USD sell X, EUR
 * sell Y, as of Z" (scraperCaptureLine) is read, from every completed run,
 * whatever the run's outcome - a capture is what the bank published even
 * when the post failed. A capture whose rates fail the server's own
 * plausibility check (isPlausibleBpdRates) is listed and left out. Captures
 * of the same asOf are one publication: the earliest is kept, as
 * storeBpdRates keeps a publication's first capture, and one whose figures
 * differ from it is listed. Each publication becomes one row with the sell
 * rates, buy rates null (the logs never held them), and capturedAt the time
 * the run logged it.
 *
 * The dry run is the default. It reads the database inside a READ ONLY
 * transaction (the database refuses any write in it) and prints each
 * publication with whether it would be inserted or is already stored (and,
 * if stored, whether the stored sell rates agree). `--apply` inserts the
 * new ones in one database transaction; an asOf already stored is never
 * changed (ON CONFLICT DO NOTHING), so a second run inserts nothing. Nothing
 * but BpdRatePublication rows is written, and ExchangeRate is not read:
 * this is history, not the rate the app converts with.
 *
 * Exit code 0 when it ran (or had nothing to do), 2 when it could not run
 * (no gh, no runs listed, the migration not applied).
 */
import "dotenv/config";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Pool, types } from "pg";

import { capturesFromScraperLog, isPlausibleBpdRates, type ScraperLogCapture } from "../src/lib/bpd-rate-payload";

const MIGRATION = "20261030120000_add_bpd_rate_history_and_bank_figure";
const WORKFLOW = "scrape-bpd-rate.yml";
/** More runs than the workflow can have logs for: one a day for 90 days, plus manual runs. */
const RUN_LIMIT = 1000;

// Prisma stores timestamps without a time zone as UTC; node-postgres would
// read them in this machine's time zone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`));

function usage(): never {
  console.error("usage: npx tsx scripts/backfill-bpd-rate-history.ts [--dry-run | --apply] [--repo owner/name]");
  process.exit(2);
}

function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** How often a run's log is asked for before it counts as unavailable: gh's reads fail now and then. */
const LOG_ATTEMPTS = 3;
const LOG_RETRY_DELAY_MS = 3000;

async function runLog(runId: number, repoArgs: string[]): Promise<string | null> {
  for (let attempt = 1; attempt <= LOG_ATTEMPTS; attempt += 1) {
    try {
      return gh(["run", "view", String(runId), ...repoArgs, "--log"]);
    } catch {
      if (attempt < LOG_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, LOG_RETRY_DELAY_MS));
    }
  }
  return null;
}

interface Run {
  databaseId: number;
  createdAt: string;
  status: string;
}

interface Publication {
  asOf: Date;
  dollarSellRate: number;
  euroSellRate: number;
  capturedAt: Date;
  /** Every run that logged this asOf. */
  runs: number[];
  /** Later captures of the same asOf with other figures. */
  differing: { runId: number; dollarSellRate: number; euroSellRate: number }[];
}

/** Each asOf's earliest plausible capture, oldest publication first. */
function publicationsFrom(captures: readonly (ScraperLogCapture & { runId: number })[]): Publication[] {
  const byAsOf = new Map<string, Publication>();
  const ordered = [...captures].sort((a, b) => a.loggedAt.getTime() - b.loggedAt.getTime() || a.runId - b.runId);
  for (const capture of ordered) {
    const key = capture.asOf.toISOString();
    const known = byAsOf.get(key);
    if (!known) {
      byAsOf.set(key, {
        asOf: capture.asOf,
        dollarSellRate: capture.dollarSellRate,
        euroSellRate: capture.euroSellRate,
        capturedAt: capture.loggedAt,
        runs: [capture.runId],
        differing: [],
      });
      continue;
    }
    if (!known.runs.includes(capture.runId)) known.runs.push(capture.runId);
    if (known.dollarSellRate !== capture.dollarSellRate || known.euroSellRate !== capture.euroSellRate) {
      known.differing.push({ runId: capture.runId, dollarSellRate: capture.dollarSellRate, euroSellRate: capture.euroSellRate });
    }
  }
  return [...byAsOf.values()].sort((a, b) => a.asOf.getTime() - b.asOf.getTime());
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let repo: string | null = null;
  let apply = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo" && args[index + 1]) repo = args[++index];
    else usage();
  }
  if (apply && dryRun) usage();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  console.log(`database: ${describeDatabase(url)}`);
  console.log(`mode:     ${apply ? "APPLY - inserts in one transaction" : "dry run - reads only, in a READ ONLY transaction"}`);

  const repoArgs = repo ? ["--repo", repo] : [];
  let runs: Run[];
  try {
    runs = JSON.parse(
      gh(["run", "list", ...repoArgs, "--workflow", WORKFLOW, "--limit", String(RUN_LIMIT), "--json", "databaseId,createdAt,status"]),
    ) as Run[];
  } catch (error) {
    console.error(`could not list the ${WORKFLOW} runs with gh: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const completed = runs.filter((run) => run.status === "completed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.log(`runs:     ${completed.length} completed ${WORKFLOW} run${completed.length === 1 ? "" : "s"}${runs.length > completed.length ? ` (${runs.length - completed.length} still running, skipped)` : ""}`);
  if (completed.length === 0) {
    console.error("no completed runs to read");
    return 2;
  }

  const captures: (ScraperLogCapture & { runId: number })[] = [];
  const noLog: Run[] = [];
  const implausible: (ScraperLogCapture & { runId: number })[] = [];
  let withoutCapture = 0;
  for (const run of completed) {
    const log = await runLog(run.databaseId, repoArgs);
    if (log === null) {
      noLog.push(run);
      continue;
    }
    const found = capturesFromScraperLog(log);
    if (found.length === 0) withoutCapture += 1;
    for (const capture of found) {
      if (isPlausibleBpdRates(capture.dollarSellRate, capture.euroSellRate)) captures.push({ ...capture, runId: run.databaseId });
      else implausible.push({ ...capture, runId: run.databaseId });
    }
  }
  for (const run of noLog) console.log(`          run ${run.databaseId} (${run.createdAt}): log not available (expired or unreadable), skipped`);
  if (withoutCapture > 0) console.log(`          ${withoutCapture} run${withoutCapture === 1 ? "" : "s"} logged no capture (the scrape failed before reading the feed)`);
  for (const capture of implausible) {
    console.log(
      `          run ${capture.runId}: USD sell ${capture.dollarSellRate}, EUR sell ${capture.euroSellRate}, as of ${capture.asOf.toISOString()} fails the plausibility check, left out`,
    );
  }

  const publications = publicationsFrom(captures);

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    if (apply) {
      await client.query("BEGIN");
    } else {
      await client.query("BEGIN READ ONLY");
      const readOnly = await client.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
      if (readOnly.rows[0]?.ro !== "on") {
        console.error("could not confirm a read-only transaction; refusing to run");
        await client.query("ROLLBACK");
        return 2;
      }
    }

    const recorded = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      [MIGRATION],
    );
    if (recorded.rows[0].n !== 1) {
      console.error(`the migration ${MIGRATION} is not applied: run \`npm run db:migrate\` first. Nothing was written.`);
      await client.query("ROLLBACK");
      return 2;
    }

    const stored = await client.query<{ asOf: Date; dollarSellRate: string; euroSellRate: string }>(
      `SELECT "asOf", "dollarSellRate"::text AS "dollarSellRate", "euroSellRate"::text AS "euroSellRate" FROM "BpdRatePublication"`,
    );
    const storedByAsOf = new Map(stored.rows.map((row) => [row.asOf.toISOString(), row]));

    console.log(`\n${publications.length} publication${publications.length === 1 ? "" : "s"} in the logs`);
    const toInsert: Publication[] = [];
    for (const publication of publications) {
      const existing = storedByAsOf.get(publication.asOf.toISOString());
      const agrees =
        existing &&
        Number(existing.dollarSellRate) === publication.dollarSellRate &&
        Number(existing.euroSellRate) === publication.euroSellRate;
      if (!existing) toInsert.push(publication);
      console.log(
        [
          `  ${publication.asOf.toISOString()}`,
          `USD sell ${publication.dollarSellRate}`,
          `EUR sell ${publication.euroSellRate}`,
          `logged ${publication.capturedAt.toISOString()}`,
          `${publication.runs.length} run${publication.runs.length === 1 ? "" : "s"}`,
          existing
            ? agrees
              ? "already stored"
              : `already stored with USD sell ${Number(existing.dollarSellRate)}, EUR sell ${Number(existing.euroSellRate)} - kept as stored`
            : apply
              ? "insert"
              : "would insert",
          ...publication.differing.map(
            (other) => `run ${other.runId} logged USD sell ${other.dollarSellRate}, EUR sell ${other.euroSellRate} for it later - the first capture is kept`,
          ),
        ].join(" | "),
      );
    }
    if (toInsert.length === 0) {
      console.log("Nothing to insert.");
      await client.query("ROLLBACK");
      return 0;
    }

    if (!apply) {
      await client.query("ROLLBACK");
      console.log(`\nDry run: nothing was written. Run again with --apply to insert ${toInsert.length} row${toInsert.length === 1 ? "" : "s"}.`);
      return 0;
    }

    let inserted = 0;
    for (const publication of toInsert) {
      const result = await client.query(
        `INSERT INTO "BpdRatePublication" (id, "asOf", "dollarBuyRate", "dollarSellRate", "euroBuyRate", "euroSellRate", "capturedAt")
         VALUES ($1, $2, NULL, $3, NULL, $4, $5)
         ON CONFLICT ("asOf") DO NOTHING`,
        // As ISO strings: node-postgres would send a Date in this machine's
        // time zone, which a timestamp column without one keeps as is.
        [
          randomUUID(),
          publication.asOf.toISOString(),
          String(publication.dollarSellRate),
          String(publication.euroSellRate),
          publication.capturedAt.toISOString(),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    console.log(`\nApplied: ${inserted} row${inserted === 1 ? "" : "s"} inserted into BpdRatePublication, in one transaction.`);
    return 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(error);
    return 2;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then((code) => {
  process.exitCode = code;
});
