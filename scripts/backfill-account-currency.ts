/**
 * Stores every transaction written in another currency than its account's in
 * the account's currency (QUANTITIES_MAP.md K7), keeping what it was entered
 * as and the rate:
 *
 *   DATABASE_URL="postgres://..." npx tsx scripts/backfill-account-currency.ts            # dry run
 *   DATABASE_URL="postgres://..." npx tsx scripts/backfill-account-currency.ts --apply    # writes
 *
 * The dry run is the default. It reads inside a READ ONLY transaction (the
 * database refuses any write in it) and prints each row it would change - id,
 * date, account, note, old amount and currency, new amount, rate - and every
 * affected account's balance before and after. `--apply` writes the same
 * plan in one database transaction and commits only if every row was still
 * as read and every affected balance reads the same after as before;
 * otherwise nothing is written. It refuses to run until the migration that
 * adds Transaction.originalAmount / originalCurrency / rate is applied.
 *
 * A row that holds its account's currency exactly - entered in it and
 * converted, as on an account whose currency was changed after the row was
 * saved (R19) - gets that figure back as typed. Every other row is converted
 * from what it was entered as: its original when it has one, never its
 * converted figure converted again.
 *
 * The rate is the one table the app would use today, read from the stored
 * ExchangeRate rows (open.er-api.com, with Banco Popular's DOP and EUR sell
 * rates preferred while up to 7 days old, as getRateTable does) - never
 * fetched, so the dry run and the apply use the same figures. The rate of the
 * day each row was entered is not recoverable; each converted row is frozen at
 * this one. Each account's balance, with every row at what it holds, reads the
 * same to the cent before and after (planBackfill in src/lib/account-money.ts);
 * where a row holding the account's currency had drifted with the rate, the
 * report also prints the balance the app reads today.
 *
 * Idempotent: a row stored in its account's currency is never selected, so a
 * second run finds nothing to change. Nothing but Transaction rows is written:
 * goal contributions, budgets and snapshots are already in their own
 * currencies.
 *
 * Exit code 0 when it ran (or had nothing to do), 1 when the plan did not
 * hold (nothing written), 2 when it could not run.
 */
import "dotenv/config";

import { Pool, types, type PoolClient } from "pg";

import { planBackfill, rateLine, type BackfillRow } from "../src/lib/account-money";
import {
  BPD_SOURCE,
  isPlausibleDopRate,
  isWithinFreshnessWindow,
  toRateTableEntries,
} from "../src/lib/bpd-rate-payload";
import { CURRENCIES, formatMoney, type RateTable } from "../src/lib/currency";
import { toISODate } from "../src/lib/date";
import { balanceSign } from "../src/lib/transactions";

const MIGRATION = "20260930200000_add_transaction_original_amount";

// Prisma stores timestamps without a time zone as UTC and dates as calendar
// days; node-postgres would read both in this machine's time zone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`));
types.setTypeParser(1082, (value: string) => value);
/** getRateTable's constants when nothing is stored (src/lib/rates.ts). */
const FALLBACK_RATES: Record<string, number> = { USD: 1, DOP: 60, EUR: 0.92 };
/** open.er-api.com rates older than this are refreshed by the app on its next request. */
const OPEN_ER_API_TTL_MS = 24 * 60 * 60 * 1000;

function usage(): never {
  console.error("usage: npx tsx scripts/backfill-account-currency.ts [--dry-run | --apply]");
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

async function migrationApplied(client: PoolClient): Promise<boolean> {
  const columns = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Transaction'
        AND column_name IN ('originalAmount', 'originalCurrency', 'rate')`,
  );
  if (columns.rows[0].n !== 3) return false;
  const recorded = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    [MIGRATION],
  );
  return recorded.rows[0].n === 1;
}

/** The rate table the app uses today, from stored rows only (see the header). */
async function loadRates(client: PoolClient): Promise<{ table: RateTable; notes: string[] }> {
  const notes: string[] = [];
  const stored = await client.query<{ targetCurrency: string; rate: string; fetchedAt: Date; asOf: Date | null; source: string }>(
    `SELECT "targetCurrency", rate::text AS rate, "fetchedAt", "asOf", source FROM "ExchangeRate" WHERE "baseCurrency" = 'USD'`,
  );
  const rates: Record<string, number> = {};
  let newest: Date | null = null;
  for (const code of CURRENCIES) {
    const row = stored.rows.find((candidate) => candidate.source === "open-er-api" && candidate.targetCurrency === code);
    const rate = row ? Number(row.rate) : Number.NaN;
    if (Number.isFinite(rate) && rate > 0) {
      rates[code] = rate;
      if (!newest || row!.fetchedAt > newest) newest = row!.fetchedAt;
    } else {
      rates[code] = FALLBACK_RATES[code] ?? 1;
      notes.push(`no stored open.er-api.com rate for ${code}: using the app's fallback ${rates[code]}`);
    }
  }
  if (newest && Date.now() - newest.getTime() > OPEN_ER_API_TTL_MS) {
    notes.push(`open.er-api.com rates were fetched ${newest.toISOString()} (over 24h ago): opening the app refreshes them`);
  }
  let source: RateTable["source"] = "open-er-api";
  let asOf: Date | null = null;
  const dop = stored.rows.find((row) => row.source === BPD_SOURCE && row.targetCurrency === "DOP");
  const eur = stored.rows.find((row) => row.source === BPD_SOURCE && row.targetCurrency === "EUR");
  const now = new Date();
  if (dop?.asOf && eur?.asOf && isWithinFreshnessWindow(dop.asOf, now) && isWithinFreshnessWindow(eur.asOf, now)) {
    const dollarSellRate = Number(dop.rate);
    const euroCrossRate = Number(eur.rate);
    if (isPlausibleDopRate(dollarSellRate) && euroCrossRate > 0) {
      const entries = toRateTableEntries({ dollarSellRate, euroSellRate: dollarSellRate / euroCrossRate, asOf: dop.asOf });
      rates.DOP = entries.DOP;
      rates.EUR = entries.EUR;
      source = "bpd";
      asOf = dop.asOf;
    }
  }
  return { table: { rates, fetchedAt: newest, stale: true, source, asOf }, notes };
}

interface LoadedRow extends BackfillRow {
  /** YYYY-MM-DD */
  date: string;
  note: string | null;
}

async function loadRows(client: PoolClient, withOriginals: boolean) {
  const accounts = await client.query<{ id: string; name: string; currency: string }>(
    `SELECT id, name, currency FROM "Account" ORDER BY name`,
  );
  const originals = withOriginals
    ? `"originalAmount"::text AS "originalAmount", "originalCurrency", rate::text AS rate`
    : `NULL AS "originalAmount", NULL AS "originalCurrency", NULL AS rate`;
  const rows = await client.query<{
    id: string;
    accountId: string;
    date: string;
    note: string | null;
    type: string;
    transferDirection: string | null;
    amount: string;
    currency: string;
    originalAmount: string | null;
    originalCurrency: string | null;
    rate: string | null;
    yourShare: string | null;
  }>(
    `SELECT id, "accountId", date, note, type::text AS type, "transferDirection"::text AS "transferDirection",
            amount::text AS amount, currency, ${originals}, "yourShare"::text AS "yourShare"
       FROM "Transaction" ORDER BY date, "createdAt", id`,
  );
  const loaded: LoadedRow[] = rows.rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    date: row.date,
    note: row.note,
    type: row.type,
    transferDirection: row.transferDirection,
    amount: Number(row.amount),
    currency: row.currency,
    originalAmount: row.originalAmount === null ? null : Number(row.originalAmount),
    originalCurrency: row.originalCurrency,
    rate: row.rate === null ? null : Number(row.rate),
    yourShare: row.yourShare === null ? null : Number(row.yourShare),
  }));
  return { accounts: accounts.rows, rows: loaded };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply" && arg !== "--dry-run")) usage();
  if (args.includes("--apply") && args.includes("--dry-run")) usage();
  const apply = args.includes("--apply");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  console.log(`database: ${describeDatabase(url)}`);
  console.log(`mode:     ${apply ? "APPLY - writes in one transaction" : "dry run - reads only, in a READ ONLY transaction"}`);

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

    const migrated = await migrationApplied(client);
    if (!migrated) {
      if (apply) {
        console.error(`the migration ${MIGRATION} is not applied: run \`npm run db:migrate\` first. Nothing was written.`);
        await client.query("ROLLBACK");
        return 2;
      }
      console.log(`note:     the migration ${MIGRATION} is not applied yet; --apply will refuse until it is`);
    }

    const { table, notes } = await loadRates(client);
    console.log(
      `rates:    ${CURRENCIES.map((code) => `${code}=${table.rates[code]}`).join(" ")} per USD (${table.source === "bpd" ? `Banco Popular as of ${toISODate(table.asOf as Date)}, open.er-api.com for the rest` : "open.er-api.com"})`,
    );
    for (const note of notes) console.log(`          ${note}`);

    const { accounts, rows } = await loadRows(client, migrated);
    const plan = planBackfill(accounts, rows, table);
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const rowById = new Map(rows.map((row) => [row.id, row]));

    console.log(`\n${plan.changes.length} transaction${plan.changes.length === 1 ? "" : "s"} in another currency than ${plan.changes.length === 1 ? "its" : "their"} account's`);
    if (plan.changes.length === 0) {
      console.log("Nothing to change.");
      await client.query(apply ? "COMMIT" : "ROLLBACK");
      return 0;
    }
    const byDate = [...plan.changes].sort(
      (a, b) => (rowById.get(a.id) as LoadedRow).date.localeCompare((rowById.get(b.id) as LoadedRow).date) || a.id.localeCompare(b.id),
    );
    for (const change of byDate) {
      const row = rowById.get(change.id) as LoadedRow;
      const account = accountById.get(change.accountId)!;
      const rate = change.to.rate === null ? "-" : rateLine(change.to.originalCurrency as string, change.to.currency, change.to.rate);
      console.log(
        [
          `  ${change.id}`,
          row.date,
          `${account.name} (${account.currency})`,
          JSON.stringify(row.note ?? ""),
          `${row.type}${row.transferDirection ? ` ${row.transferDirection}` : ""}`,
          `${formatMoney(change.from.amount, change.from.currency)} -> ${formatMoney(change.to.amount, change.to.currency)}`,
          `rate ${rate} (${change.to.rate ?? "-"})`,
          ...(change.yourShare ? [`your share ${change.yourShare.from} -> ${change.yourShare.to}`] : []),
        ].join(" | "),
      );
    }
    console.log("\nbalances in each account's own currency, every row, at these rates:");
    let held = true;
    for (const balance of plan.balances) {
      const account = accountById.get(balance.accountId)!;
      const same = Math.round(balance.before * 100) === Math.round(balance.after * 100);
      held &&= same;
      const drifted = Math.round(balance.appReads * 100) !== Math.round(balance.before * 100);
      console.log(
        `  ${account.name} (${account.currency}): before ${formatMoney(balance.before, balance.currency)} | after ${formatMoney(balance.after, balance.currency)} | ${same ? "same" : "DIFFERENT"}${drifted ? ` | the app reads ${formatMoney(balance.appReads, balance.currency)} today, with typed figures drifted at today's rate` : ""}`,
      );
    }
    if (!held) {
      console.error("\nA balance would change; nothing was written.");
      await client.query("ROLLBACK");
      return 1;
    }

    if (!apply) {
      await client.query("ROLLBACK");
      console.log("\nDry run: nothing was written. Run again with --apply to write these rows.");
      return 0;
    }

    for (const change of plan.changes) {
      const row = rowById.get(change.id) as LoadedRow;
      // Only a row still exactly as read is rewritten.
      const updated = await client.query(
        `UPDATE "Transaction"
            SET amount = $2, currency = $3, "originalAmount" = $4, "originalCurrency" = $5, rate = $6, "yourShare" = $7
          WHERE id = $1 AND amount = $8 AND currency = $9 AND "originalCurrency" IS NOT DISTINCT FROM $10
            AND "yourShare" IS NOT DISTINCT FROM $11`,
        [
          change.id,
          change.to.amount.toFixed(2),
          change.to.currency,
          change.to.originalAmount === null ? null : change.to.originalAmount.toFixed(2),
          change.to.originalCurrency,
          change.to.rate === null ? null : String(change.to.rate),
          change.yourShare ? change.yourShare.to.toFixed(2) : null,
          row.amount.toFixed(2),
          row.currency,
          row.originalCurrency ?? null,
          row.yourShare === null ? null : row.yourShare.toFixed(2),
        ],
      );
      if (updated.rowCount !== 1) {
        console.error(`\n${change.id} changed since it was read; nothing was written.`);
        await client.query("ROLLBACK");
        return 1;
      }
    }
    // Read back inside the transaction: nothing left in another currency, and
    // every affected balance what it was.
    const reread = await loadRows(client, true);
    if (planBackfill(accounts, reread.rows, table).changes.length !== 0) {
      console.error("\nrows still in another currency after the writes; nothing was written.");
      await client.query("ROLLBACK");
      return 1;
    }
    for (const balance of plan.balances) {
      const account = accountById.get(balance.accountId)!;
      const cents = reread.rows
        .filter((row) => row.accountId === account.id)
        .reduce((total, row) => total + Math.round(balanceSign(row.type, row.transferDirection) * row.amount * 100), 0);
      if (cents !== Math.round(balance.before * 100)) {
        console.error(`\n${account.name}'s balance would read ${cents / 100}, not ${balance.before}; nothing was written.`);
        await client.query("ROLLBACK");
        return 1;
      }
    }
    await client.query("COMMIT");
    console.log(`\nApplied: ${plan.changes.length} row${plan.changes.length === 1 ? "" : "s"} stored in their account's currency, in one transaction.`);
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
