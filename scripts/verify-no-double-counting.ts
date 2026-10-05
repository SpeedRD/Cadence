/**
 * Standing double-counting integrity audit.
 *
 * Five pairs of mechanisms in this codebase could, in principle, count the
 * same financial commitment twice (or, just as bad, drop it). Each was fixed
 * as a one-off in the past; this script checks all five against whatever
 * data it is pointed at, by computing each side of every pair independently
 * from the raw rows and comparing it with what the app's own readers report:
 *
 *   pair 1  a GoalContribution and the Transaction paired with it - a manual
 *           row's twin (source MANUAL, externalId "goal-contribution:<id>",
 *           see logManualContribution in src/lib/goals.ts) or an auto-posted
 *           row's twin (source RECURRING, the same "<itemId>:<date>" key on
 *           both rows, or a charge the user entered that posting settled the
 *           occurrence with - its RecurringSettlement carries the key). The contribution counts as saving; the twin must never
 *           also count as spending (monthly pace, src/lib/data/monthly.ts;
 *           period budget "spent", src/lib/data/period-summary.ts), and a twin
 *           whose contribution is gone must not vanish from both.
 *   pair 2  a SEMI_MONTHLY RecurringItem's two monthly anchors. Every reader
 *           that walks a schedule (owedOccurrences / advanceDate in
 *           src/lib/recurring.ts, the period commitments' walk in
 *           src/lib/period-commitments.ts) must see both realizations each month, and
 *           each real occurrence must reach the ledger exactly once - not
 *           once through posting and again through a hand-logged charge, and
 *           not through two items covering the same bill.
 *   pair 3  the Afford calculator's goal-funding estimate for a period with no
 *           confirmed check-in versus the real GOAL allocation rows of a
 *           period that has one (projectPeriods in src/lib/data/afford.ts):
 *           a confirmed period's commitments must decompose exactly into
 *           the period's recurring commitments (whole() of
 *           src/lib/period-commitments.ts) plus its GOAL rows, with no
 *           estimate on top, and an unconfirmed period's into commitments
 *           plus estimate, with nothing leaking in from a DRAFT check-in.
 *           A recurring contribution is reserved in exactly one period -
 *           the same loaded alone or with others - and, once its money has
 *           moved, in the period whose goal window counts it as contributed.
 *   pair 4  a row Cadence wrote itself - an occurrence's RECURRING row, or
 *           the paycheck a payday check-in recorded - versus a charge or
 *           deposit brought in for the same money (a CSV row, an approved
 *           receipt, a manual entry). Existing pairs are found with this
 *           script's own matching in SQL and plain code, wider than the
 *           entry points' (any account, the posted row's half-month and five
 *           days either side), never with their matcher, so a gap in it is
 *           found rather than inherited. No occurrence may be both settled by
 *           a charge (RecurringSettlement) and posted, and no item may have
 *           one schedule slot paid twice under two keys (a settlement left on
 *           a key its schedule no longer has). A confirmed check-in must not
 *           count its paycheck beside deposits the ledger already held for it
 *           when it was confirmed (a CSV salary imported first): those are
 *           adopted, so what the check-in itself adds plus them never comes
 *           to more than the paycheck the user typed. And an installment
 *           plan's posted rows plus its recorded pairings never come to more
 *           payments than it was created with, paused, resumed or finished:
 *           no "It's that payment" left behind its nextDate uncounted.
 *   pair 5  a deposit the user earmarked for a recurring occurrence
 *           (RecurringEarmark, src/lib/earmarks.ts) and the occurrence it
 *           covers: the earmarked part lowers what the occurrence asks of the
 *           plan (wholeAmount in src/lib/period-commitments.ts), so it must
 *           not also count as estimated income (src/lib/period-income.ts) -
 *           and only that part: an earmark whose occurrence shrank or went
 *           away hands the rest back to the estimate,
 *           must not be a check-in's paycheck (already the plan's income),
 *           and no occurrence may be covered beyond its cost nor any deposit
 *           beyond its amount. What the check-in lists and adopts as a
 *           deposit's pay plus what it lowers its payments by is the whole
 *           deposit: no part counted in neither place, or in both. And a
 *           confirmed paycheck that recorded the deposits it adopted counts
 *           them in the plan's income (the confirmed room) at what of them
 *           no payment's cover takes, however their earmarks changed since
 *           the confirm or a re-confirm: its own row plus that, once.
 *
 *   DATABASE_URL="postgres://.../any_db" npx tsx scripts/verify-no-double-counting.ts
 *
 * Read-only, enforced by the database rather than by convention: after
 * connecting, the script issues `SET default_transaction_read_only = on`
 * over the live connection (a real statement, not a connection-string
 * parameter - Supabase's session pooler does not forward the `options` query
 * param a DSN-based version of this guard once relied on) and then opens the
 * work in an explicit `BEGIN READ ONLY` transaction, confirming
 * transaction_read_only is "on" before anything is read. Postgres therefore
 * refuses every INSERT/UPDATE/DELETE the script (or any app module it calls)
 * could attempt. It is therefore safe to point at a database holding real
 * data. Exchange
 * rates are read from the stored ExchangeRate rows (never fetched, never
 * written); every comparison here holds under any consistent rate table.
 *
 * Options (environment):
 *   AUDIT_TODAY=YYYY-MM-DD        the reference day (default: today in APP_TIMEZONE)
 *   AUDIT_HORIZON_PERIODS=6       how many pay periods ahead pair 3 projects
 *
 * Exit code 0 when every pair is clean, 1 when anything was flagged, 2 when
 * the audit could not run (no DATABASE_URL, no Settings row, read-only mode
 * not in effect).
 *
 * This script verifies; it never fixes. A finding names the two competing
 * sources and the amounts each claims, so it can be debugged directly.
 */
import "dotenv/config";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { CURRENCIES, convert, toCurrency, type RateTable } from "../src/lib/currency";
import {
  addDays,
  addMonths,
  civilDate,
  daysInMonth,
  fromISODate,
  today as appToday,
  toISODate,
} from "../src/lib/date";
import { num, round2 } from "../src/lib/money";
import { monthForDate } from "../src/lib/month";
import { planGoalFunding } from "../src/lib/payday";
import {
  nextPeriod,
  payDayOfMonth,
  previousPeriod,
  periodForDate,
  periodInfo,
  periodRange,
  type PeriodInfo,
  type PeriodRef,
} from "../src/lib/period";
import { whole, wholeAmount } from "../src/lib/period-commitments";
import { advanceDate, monthlyEquivalent, owedOccurrences, skipReasonFor, type ScheduledItem } from "../src/lib/recurring";
import {
  manualContributionExternalId,
  manualContributionIdFromTransaction,
  MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX,
} from "../src/lib/transactions";

import type { AffordContext } from "../src/lib/data/afford";
import type { AppContext } from "../src/lib/data/context";

// ---------------------------------------------------------------------------
// Read-only connection. Pooler-agnostic: this issues `SET
// default_transaction_read_only = on` and `BEGIN READ ONLY` as real
// statements over the connection, rather than relying on a connection-string
// parameter a pooler might not forward. `max: 1` pins the pg Pool to exactly
// one physical connection, so every later query - Prisma's own, and every
// app module's, since src/lib/prisma.ts reuses globalThis.prisma when one is
// already there - runs on the same session and stays inside this one
// transaction. Returns null (never throws) when read-only cannot be
// confirmed, so the caller can fail closed.
// ---------------------------------------------------------------------------

async function connectReadOnly(connectionString: string): Promise<{ prisma: PrismaClient; pool: Pool } | null> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  let confirmed = false;
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
    confirmed = rows[0]?.ro === "on";
    if (!confirmed) await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  if (!confirmed) {
    await pool.end();
    return null;
  }
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return { prisma: new PrismaClient({ adapter }), pool };
}

let prisma!: PrismaClient;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type FindingKind = "DOUBLE" | "POSSIBLE" | "DROP" | "MISMATCH";
type Pair = 1 | 2 | 3 | 4 | 5;
interface Finding {
  pair: Pair;
  kind: FindingKind;
  title: string;
  evidence: string[];
}

const findings: Finding[] = [];

function flag(pair: Pair, kind: FindingKind, title: string, evidence: string[]) {
  findings.push({ pair, kind, title, evidence });
  console.log(`  FLAG ${kind.padEnd(8)} ${title}`);
  for (const line of evidence) console.log(`                ${line}`);
}

function info(line: string) {
  console.log(`  ${line}`);
}

function money(amount: number, currency: string): string {
  return `${round2(amount).toFixed(2)} ${currency}`;
}

function sectionResult(pair: Pair) {
  const own = findings.filter((finding) => finding.pair === pair);
  console.log(own.length === 0 ? "  clean" : `  ${own.length} finding${own.length === 1 ? "" : "s"}`);
}

function sameCents(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

// ---------------------------------------------------------------------------
// Independent schedule arithmetic for pair 2. Deliberately not the walk under
// test: a SEMI_MONTHLY item is due on each anchor's realization every month -
// the anchor clamped to the month's length, then weekend-shifted the way a pay
// boundary is (payDayOfMonth, which src/lib/recurring.ts also reuses). A shift
// can spill into the previous calendar month (anchor 1 on a Saturday), which
// is why the enumeration starts one month early.
// ---------------------------------------------------------------------------

function anchorRealizations(anchors: number[], from: Date, to: Date): Date[] {
  const out = new Map<number, Date>();
  if (from.getTime() > to.getTime() || anchors.length === 0) return [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth(); // one month before `from`'s (1-based) month
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  for (let guard = 0; guard < 1200; guard += 1) {
    for (const anchor of anchors) {
      const raw = Math.min(anchor, daysInMonth(year, month));
      const date = civilDate(year, month, payDayOfMonth(year, month, raw));
      if (date.getTime() >= from.getTime() && date.getTime() <= to.getTime()) out.set(date.getTime(), date);
    }
    if (civilDate(year, month, 1).getTime() > to.getTime()) break;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

interface SemiMonthlyShape {
  nextDate: Date;
  anchors: number[];
  remainingOccurrences: number | null;
}

/**
 * What owedOccurrences() should return for a SEMI_MONTHLY item over
 * [from, to], from the definition rather than the walk: an outstanding
 * nextDate behind `from` is owed once; then nextDate itself and every anchor
 * realization after it, capped at the countdown, filtered to the window.
 */
function independentOwed(item: SemiMonthlyShape, from: Date, to: Date): Date[] {
  if (from.getTime() > to.getTime()) return [];
  const remaining = item.remainingOccurrences ?? Number.POSITIVE_INFINITY;
  if (remaining <= 0) return [];
  const sequence = [item.nextDate, ...anchorRealizations(item.anchors, addDays(item.nextDate, 1), to)].slice(
    0,
    Number.isFinite(remaining) ? remaining : undefined,
  );
  const owed: Date[] = [];
  if (item.nextDate.getTime() < from.getTime()) owed.push(item.nextDate);
  for (const date of sequence) {
    if (date.getTime() >= from.getTime() && date.getTime() <= to.getTime()) owed.push(date);
  }
  return owed;
}

/**
 * Where the period commitments should file a SEMI_MONTHLY item's schedule
 * through `to`, from the definition rather than the walk: nextDate itself and
 * every anchor realization after it, capped at the countdown, each in its own
 * period - one due before `today` in the current period.
 */
function independentFiled(item: SemiMonthlyShape, today: Date, currentKey: string, to: Date): { due: Date; key: string }[] {
  const remaining = item.remainingOccurrences ?? Number.POSITIVE_INFINITY;
  if (remaining <= 0) return [];
  return [item.nextDate, ...anchorRealizations(item.anchors, addDays(item.nextDate, 1), to)]
    .slice(0, Number.isFinite(remaining) ? remaining : undefined)
    .filter((date) => date.getTime() <= to.getTime())
    .map((due) => ({ due, key: due.getTime() < today.getTime() ? currentKey : periodForDate(due).key }));
}

function isoList(dates: Date[]): string {
  return dates.length === 0 ? "(none)" : dates.map(toISODate).join(", ");
}

// ---------------------------------------------------------------------------
// Source scan for pair 2: every module that walks a schedule must load
// secondAnchorDay for the rows it walks, or a SEMI_MONTHLY item silently
// degrades to one occurrence a month there (advanceDate's documented fallback).
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "generated" || entry === "node_modules") continue;
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** The text from `open` (an opening bracket) to its matching close. */
function balanced(source: string, open: number, pair: "()" | "{}"): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === pair[0]) depth += 1;
    else if (source[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** Block and line comments blanked out, so a walker named in prose is not a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * The `select` of one find call's own argument object - never one nested in
 * an `include` relation - as its literal block, or the block of the constant
 * it names; null when the call has no select (a full row comes back).
 */
function topLevelSelect(call: string, source: string): string | null {
  let depth = 0;
  for (let i = 0; i < call.length; i += 1) {
    if (call[i] === "{") depth += 1;
    else if (call[i] === "}") depth -= 1;
    else if (depth === 1 && /^select\s*:/.test(call.slice(i)) && /[\s,{]/.test(call[i - 1] ?? "{")) {
      const after = call.slice(i).replace(/^select\s*:\s*/, "");
      if (after.startsWith("{")) return balanced(after, 0, "{}");
      const ident = /^[A-Za-z_$][\w$]*/.exec(after);
      if (!ident) return null;
      const declaration = new RegExp(`const\\s+${ident[0]}\\s*=\\s*\\{`).exec(source);
      return declaration ? balanced(source, declaration.index + declaration[0].length - 1, "{}") : "";
    }
  }
  return null;
}

function scanScheduleReaders(root: string): { files: string[]; scanned: number; offenders: string[] } {
  const walkers = /\b(owedOccurrences|advanceDate|remainingInstallments|planCommitments)\s*\(/;
  const offenders: string[] = [];
  const files: string[] = [];
  let scanned = 0;
  for (const file of listSourceFiles(root)) {
    if (file.endsWith("lib/recurring.ts") || file.endsWith("lib/afford-tracking.ts") || file.endsWith("lib/period-commitments.ts")) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (!walkers.test(source)) continue;
    files.push(relative(process.cwd(), file));
    const calls = /recurringItem\s*\.\s*find(Many|First|Unique|FirstOrThrow|UniqueOrThrow)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = calls.exec(source)) !== null) {
      const call = balanced(source, match.index + match[0].length - 1, "()");
      const select = topLevelSelect(call, source);
      // No select: the full row, second anchor included. A select without the
      // schedule fields cannot feed a walk at all (advanceDate needs frequency).
      if (select === null || !/frequency\s*:\s*true/.test(select)) continue;
      scanned += 1;
      if (!/secondAnchorDay\s*:\s*true/.test(select)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(process.cwd(), file)}:${line}`);
      }
    }
  }
  return { files, scanned, offenders };
}

// ---------------------------------------------------------------------------
// Setup: today, settings, stored rates, context.
// ---------------------------------------------------------------------------

/** Stored open.er-api.com rates, or the same hardcoded constants getRateTable falls back to. Never fetches, never writes. */
async function loadStoredRates(): Promise<{ table: RateTable; fallback: string[] }> {
  const FALLBACK: Record<string, number> = { USD: 1, DOP: 60, EUR: 0.92 };
  const stored = await prisma.exchangeRate.findMany({ where: { baseCurrency: "USD", source: "open-er-api" } });
  const byTarget = new Map(stored.map((row) => [row.targetCurrency, row]));
  const rates: Record<string, number> = {};
  const fallback: string[] = [];
  for (const code of CURRENCIES) {
    const rate = num(byTarget.get(code)?.rate);
    if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
    else {
      rates[code] = FALLBACK[code] ?? 1;
      fallback.push(code);
    }
  }
  const newest = stored.reduce<Date | null>(
    (latest, row) => (latest === null || row.fetchedAt > latest ? row.fetchedAt : latest),
    null,
  );
  return { table: { rates, fetchedAt: newest, stale: true, source: "open-er-api", asOf: null }, fallback };
}

async function main(): Promise<number> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    console.error("no Settings row: this does not look like a seeded Cadence database");
    return 2;
  }
  const overrideToday = process.env.AUDIT_TODAY ? fromISODate(process.env.AUDIT_TODAY) : null;
  if (process.env.AUDIT_TODAY && !overrideToday) {
    console.error(`AUDIT_TODAY must be YYYY-MM-DD, got "${process.env.AUDIT_TODAY}"`);
    return 2;
  }
  const today = overrideToday ?? appToday();
  const horizonPeriods = Math.max(1, Number(process.env.AUDIT_HORIZON_PERIODS ?? 6) || 6);
  const { table: rates, fallback } = await loadStoredRates();
  const displayCurrency = toCurrency(settings.displayCurrency);

  const context: AffordContext = {
    displayCurrency,
    language: "en",
    rates,
    today,
    currentPeriod: periodForDate(today),
    incomeHistoryStartDate: settings.incomeHistoryStartDate,
    bufferPercent: settings.bufferPercent,
    bufferFloorAmount: num(settings.bufferFloorAmount),
    bufferFloorCurrency: settings.bufferFloorCurrency,
  };
  const toDisplay = (amount: number, currency: string) => convert(amount, currency, displayCurrency, rates);

  console.log(`double-counting audit: today ${toISODate(today)} (period ${context.currentPeriod.key}), display ${displayCurrency}, read-only session confirmed`);
  console.log(
    `rates: ${CURRENCIES.map((code) => `${code}=${rates.rates[code]}`).join(" ")}${fallback.length ? ` (fallback constants for ${fallback.join(", ")})` : " (stored)"}`,
  );

  // App readers, imported only now that the read-only client is installed.
  const { projectPeriods } = await import("../src/lib/data/afford");
  const { getPeriodSummary } = await import("../src/lib/data/period-summary");
  const { matchRecurringToTransactions } = await import("../src/lib/data/monthly");
  const { getGoalRoadmapAmounts, planPeriodRef } = await import("../src/lib/data/payday");
  const { loadCommitments } = await import("../src/lib/data/period-commitments");

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, isSavingsDefault: true, isSubscriptionDefault: true },
  });
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const categoryName = (categoryId: string | null) =>
    categoryId ? (categoryById.get(categoryId)?.name ?? "(deleted category)") : "(no category)";

  const allItems = await prisma.recurringItem.findMany({
    select: {
      id: true,
      name: true,
      kind: true,
      amount: true,
      currency: true,
      frequency: true,
      nextDate: true,
      anchorDay: true,
      secondAnchorDay: true,
      remainingOccurrences: true,
      active: true,
      accountId: true,
      goalId: true,
      categoryId: true,
      createdAt: true,
      updatedAt: true,
      account: { select: { name: true, status: true, currency: true } },
      goal: { select: { name: true, achievedAt: true } },
    },
  });
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const itemIdFromKey = (externalId: string) => {
    const separator = externalId.lastIndexOf(":");
    return separator > 0 ? externalId.slice(0, separator) : null;
  };

  // =========================================================================
  console.log("\n== pair 1: GoalContribution <-> its paired Transaction ==");
  // =========================================================================
  {
    const contributions = await prisma.goalContribution.findMany({
      select: {
        id: true,
        goalId: true,
        amount: true,
        currency: true,
        date: true,
        accountId: true,
        recurringExternalId: true,
        goal: { select: { name: true, currency: true } },
        account: { select: { name: true } },
      },
    });
    const twins = await prisma.transaction.findMany({
      where: {
        OR: [
          { source: "MANUAL", externalId: { startsWith: MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX } },
          { source: "RECURRING", externalId: { not: null } },
          { recurringSettlement: { isNot: null } },
        ],
      },
      select: {
        id: true,
        date: true,
        amount: true,
        currency: true,
        type: true,
        source: true,
        externalId: true,
        accountId: true,
        categoryId: true,
        account: { select: { name: true } },
        recurringSettlement: { select: { occurrenceKey: true, kind: true } },
      },
    });
    const isManualTwin = (tx: (typeof twins)[number]) =>
      tx.source === "MANUAL" && (tx.externalId ?? "").startsWith(MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX);
    const manualTwinByKey = new Map(twins.filter(isManualTwin).map((tx) => [tx.externalId as string, tx]));
    // An occurrence's ledger row: the RECURRING row posting wrote, or the
    // charge it settled the occurrence with instead (a hand-logged
    // contribution's own expense stays a manual twin above).
    const recurringTwinByKey = new Map<string, (typeof twins)[number]>();
    for (const tx of twins) {
      if (tx.source === "RECURRING") recurringTwinByKey.set(tx.externalId as string, tx);
      else if (tx.recurringSettlement && !isManualTwin(tx)) recurringTwinByKey.set(tx.recurringSettlement.occurrenceKey, tx);
    }
    const contributionById = new Map(contributions.map((row) => [row.id, row]));
    const contributionByRecurringKey = new Map(
      contributions.filter((row) => row.recurringExternalId).map((row) => [row.recurringExternalId as string, row]),
    );

    const manualPairs: { contribution: (typeof contributions)[number]; twin: (typeof twins)[number] }[] = [];
    let unpairedManual = 0;
    let unpairedRecurring = 0;
    let recurringPairs = 0;
    let dateDiffers = 0;

    // --- manual contributions and their twins --------------------------------
    for (const contribution of contributions) {
      if (contribution.recurringExternalId) continue;
      if (!contribution.accountId) continue; // logged before contributions moved money: nothing paired, by design
      const twin = manualTwinByKey.get(manualContributionExternalId(contribution.id));
      if (!twin) {
        unpairedManual += 1;
        continue;
      }
      manualPairs.push({ contribution, twin });
      const label = `goal "${contribution.goal.name}" contribution ${contribution.id} (${toISODate(contribution.date)}, ${money(num(contribution.amount), contribution.currency)})`;
      if (twin.type !== "EXPENSE") {
        flag(1, "MISMATCH", `${label}: its paired Transaction is ${twin.type}, not EXPENSE`, [
          `paired Transaction ${twin.id} (${toISODate(twin.date)}, ${money(num(twin.amount), twin.currency)}, account "${twin.account.name}")`,
        ]);
      }
      if (twin.currency === contribution.currency && !sameCents(num(twin.amount), num(contribution.amount))) {
        flag(1, "MISMATCH", `${label}: the goal counts a different amount than the ledger moved`, [
          `saving side:   GoalContribution.amount ${money(num(contribution.amount), contribution.currency)} -> Goal.savedAmount, monthly savings/investing`,
          `spending side: Transaction ${twin.id} amount ${money(num(twin.amount), twin.currency)} -> account balance, period totalSpent`,
          `same currency, so these should be the same figure to the cent (updateManualContribution keeps them in step)`,
        ]);
      }
      if (twin.accountId !== contribution.accountId) {
        flag(1, "MISMATCH", `${label}: the contribution and its Transaction name different accounts`, [
          `GoalContribution.accountId -> "${contribution.account?.name ?? contribution.accountId}"`,
          `Transaction ${twin.id}.accountId -> "${twin.account.name}"`,
          `the money is shown leaving one account while the goal records it from another`,
        ]);
      }
      if (twin.date.getTime() !== contribution.date.getTime()) dateDiffers += 1;
    }

    // --- orphaned manual twins: excluded from spending, counted by no goal ------
    for (const twin of twins) {
      if (twin.source !== "MANUAL") continue;
      const contributionId = manualContributionIdFromTransaction(twin);
      if (!contributionId) continue;
      if (contributionById.has(contributionId)) continue;
      flag(1, "DROP", `Transaction ${twin.id} carries "${twin.externalId}" but no GoalContribution ${contributionId} exists`, [
        `Transaction: ${toISODate(twin.date)}, ${money(num(twin.amount), twin.currency)}, account "${twin.account.name}", category ${categoryName(twin.categoryId)}`,
        `spending side: monthly pace sets every "goal-contribution:" twin aside (manualContributionTwinIds in src/lib/data/monthly.ts), so this is never lifestyle or committed spending`,
        `saving side:   no GoalContribution carries it, so no goal counts it either - the money is in neither figure`,
        `(the app removes the pair together: removeContribution in src/lib/goals.ts; deleting the goal clears the key instead)`,
      ]);
    }

    // --- the period budget reader on real data ----------------------------------
    // getPeriodSummary().spent must leave every twin out; the audit computes
    // the same figure without the twins from the raw rows and checks the
    // reader's figure against it, so a twin that leaked shows up as the
    // difference rather than being inferred from a rule.
    // A settled charge that is a contribution's ledger half is a twin on the
    // same terms as a manual one: the reader must leave it out of spending.
    const settledTwinPairs = contributions
      .filter((contribution) => contribution.recurringExternalId !== null)
      .map((contribution) => ({ contribution, twin: recurringTwinByKey.get(contribution.recurringExternalId as string) }))
      .filter((pair): pair is { contribution: (typeof contributions)[number]; twin: (typeof twins)[number] } =>
        pair.twin !== undefined && pair.twin.source !== "RECURRING");
    const budgetPairs = [...manualPairs, ...settledTwinPairs];
    const periodsWithTwins = new Map<string, PeriodInfo>();
    for (const { twin } of budgetPairs) periodsWithTwins.set(periodForDate(twin.date).key, periodForDate(twin.date));
    for (const [key, period] of [...periodsWithTwins.entries()].sort()) {
      const [summary, expenses, settledForSubscriptions] = await Promise.all([
        getPeriodSummary(period, context as AppContext),
        prisma.transaction.findMany({
          where: { date: periodRange(period), type: "EXPENSE" },
          select: { id: true, amount: true, currency: true, source: true, categoryId: true, externalId: true, yourShare: true },
        }),
        // A charge that paid a subscription occurrence stands for that
        // occurrence, which the plan already reserved: like posting's own
        // RECURRING row, it is not budget spending (D20). A charge that paid
        // a contribution occurrence is a twin, checked below as one.
        prisma.recurringSettlement.findMany({
          where: { kind: "SUBSCRIPTION", transaction: { date: periodRange(period) } },
          select: { transactionId: true },
        }),
      ]);
      const settledSubscriptionCharges = new Set(settledForSubscriptions.map((row) => row.transactionId));
      const twinIds = new Set(budgetPairs.map(({ twin }) => twin.id));
      let spentWithoutTwins = 0;
      const twinsInsideByRule: { id: string; amount: number }[] = [];
      for (const tx of expenses) {
        // Nothing is left out for its category (R18): an expense under a
        // subscription or savings category that nothing else covers is
        // budget spending like any other.
        if (tx.source === "RECURRING" || settledSubscriptionCharges.has(tx.id)) continue;
        // A shared expense is budget spending at the user's own share (the
        // user's decision on D22), what left the account less other people's
        // part.
        const amount = toDisplay(tx.yourShare === null ? num(tx.amount) : num(tx.yourShare), tx.currency);
        if (twinIds.has(tx.id)) twinsInsideByRule.push({ id: tx.id, amount });
        else spentWithoutTwins += amount;
      }
      spentWithoutTwins = round2(spentWithoutTwins);
      const leaked = round2(summary.spent - spentWithoutTwins);
      if (Math.abs(leaked) < 0.01) continue;
      const ruleTotal = round2(twinsInsideByRule.reduce((sum, row) => sum + row.amount, 0));
      if (sameCents(leaked, ruleTotal)) {
        for (const inside of twinsInsideByRule) {
          const pair = budgetPairs.find(({ twin }) => twin.id === inside.id)!;
          flag(1, "DOUBLE", `getPeriodSummary(${key}).spent counts goal "${pair.contribution.goal.name}"'s contribution twin as budget spending`, [
            `saving side:   GoalContribution ${pair.contribution.id} (${toISODate(pair.contribution.date)}) ${money(num(pair.contribution.amount), pair.contribution.currency)} - the plan set this aside as goal funding`,
            `spending side: Transaction ${pair.twin.id} (${toISODate(pair.twin.date)}) ${money(num(pair.twin.amount), pair.twin.currency)}, category ${categoryName(pair.twin.categoryId)} -> counted in spent (${money(inside.amount, displayCurrency)})`,
            `the period budget leaves a twin out by its own key or its settlement (isContributionTwin in src/lib/budget-spending.ts), whatever its category`,
            `reader check: spent ${money(summary.spent, displayCurrency)} = ${money(spentWithoutTwins, displayCurrency)} without twins + ${money(leaked, displayCurrency)} of twins`,
          ]);
        }
      } else {
        flag(1, "MISMATCH", `getPeriodSummary(${key}).spent does not decompose into the audit's figure`, [
          `reader: ${money(summary.spent, displayCurrency)}; audit without twins: ${money(spentWithoutTwins, displayCurrency)}; twins the category rule would admit: ${money(ruleTotal, displayCurrency)}`,
          `either the reader's exclusion rule changed or a non-twin row is counted differently - check src/lib/data/period-summary.ts`,
        ]);
      }
    }

    // --- auto-posted contributions and their RECURRING twins -------------------
    for (const contribution of contributions) {
      const key = contribution.recurringExternalId;
      if (!key) continue;
      const twin = recurringTwinByKey.get(key);
      if (!twin) {
        unpairedRecurring += 1;
        continue;
      }
      recurringPairs += 1;
      const label = `goal "${contribution.goal.name}" posted contribution ${contribution.id} (${toISODate(contribution.date)}, ${money(num(contribution.amount), contribution.currency)})`;
      const contributionMonth = monthForDate(contribution.date).key;
      const twinMonth = monthForDate(twin.date).key;
      if (contributionMonth !== twinMonth) {
        const item = itemById.get(itemIdFromKey(key) ?? "");
        const twinReading = item?.kind === "CONTRIBUTION" ? "savings/investing (contributionActual)" : "committed subscriptions (committedActual)";
        flag(1, "DOUBLE", `${label} and its RECURRING twin fall in different months, so the monthly pace counts the money twice`, [
          `saving side:   GoalContribution dated ${toISODate(contribution.date)} -> month ${contributionMonth}: goalContributionTotal (its twin is not in that month's rows, so it is not paired)`,
          `spending side: Transaction ${twin.id} dated ${toISODate(twin.date)} -> month ${twinMonth}: ${twinReading}, ${money(num(twin.amount), twin.currency)}`,
          `pairing key "${key}" only cancels the two when both rows fall in the same month window (computeMonthActuals in src/lib/data/monthly.ts)`,
        ]);
      } else if (twin.date.getTime() !== contribution.date.getTime()) {
        dateDiffers += 1;
      }
      if (twin.currency === contribution.currency && !sameCents(num(twin.amount), num(contribution.amount))) {
        flag(1, "MISMATCH", `${label}: the goal counts a different amount than its RECURRING twin`, [
          `GoalContribution ${money(num(contribution.amount), contribution.currency)} vs Transaction ${twin.id} ${money(num(twin.amount), twin.currency)} (same currency; updateRecurringContributionAmount writes both)`,
        ]);
      }
    }

    // --- RECURRING rows of a CONTRIBUTION item with no GoalContribution ---------
    let postedWithoutContribution = 0;
    for (const twin of twins) {
      if (twin.source !== "RECURRING" || !twin.externalId) continue;
      const item = itemById.get(itemIdFromKey(twin.externalId) ?? "");
      if (!item || item.kind !== "CONTRIBUTION") continue;
      if (contributionByRecurringKey.has(twin.externalId)) continue;
      postedWithoutContribution += 1;
    }

    info(`examined ${manualPairs.length} manual pair${manualPairs.length === 1 ? "" : "s"} (${unpairedManual} contribution${unpairedManual === 1 ? "" : "s"} whose twin was removed from the ledger, counted once as saving), ${recurringPairs} auto-posted pair${recurringPairs === 1 ? "" : "s"} (${unpairedRecurring} without a twin), ${periodsWithTwins.size} pay period${periodsWithTwins.size === 1 ? "" : "s"} re-read through getPeriodSummary`);
    if (dateDiffers > 0) info(`note: ${dateDiffers} pair${dateDiffers === 1 ? "" : "s"} carry different dates on the two rows (same month; counted once either way)`);
    if (postedWithoutContribution > 0) {
      info(`note: ${postedWithoutContribution} RECURRING row${postedWithoutContribution === 1 ? "" : "s"} of a CONTRIBUTION item have no GoalContribution (the goal was deleted, or the row was hand-edited); the money counts once, as a contribution charge`);
    }
    sectionResult(1);
  }

  // =========================================================================
  console.log("\n== pair 2: SEMI_MONTHLY items - two anchors, each occurrence exactly once ==");
  // =========================================================================
  {
    const scan = scanScheduleReaders(join(process.cwd(), "src"));
    info(`source scan: ${scan.files.length} module${scan.files.length === 1 ? "" : "s"} walk a schedule (${scan.files.join(", ")}); ${scan.scanned} schedule-field select${scan.scanned === 1 ? "" : "s"} checked for secondAnchorDay`);
    for (const offender of scan.offenders) {
      flag(2, "DROP", `${offender} walks schedules but selects RecurringItem rows without secondAnchorDay`, [
        `advanceDate() degrades a SEMI_MONTHLY item to a single monthly anchor when secondAnchorDay is absent, so this reader would count one of its two occurrences`,
      ]);
    }

    const semiItems = allItems.filter((item) => item.frequency === "SEMI_MONTHLY");
    if (semiItems.length === 0) info("no SEMI_MONTHLY items in this database; only the source scan applies");

    const activeAccounts = await prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    });
    const livePeriods: PeriodInfo[] = [context.currentPeriod];
    for (let i = 0; i < 2; i += 1) livePeriods.push(periodInfo(nextPeriod(livePeriods[livePeriods.length - 1])));
    const liveSummaries = new Map<string, Awaited<ReturnType<typeof getPeriodSummary>>>();
    for (const period of livePeriods) liveSummaries.set(period.key, await getPeriodSummary(period, context as AppContext));

    let periodsAudited = 0;
    for (const item of semiItems) {
      let ownPeriodsAudited = 0;
      const label = `"${item.name}" (${item.id}, ${money(num(item.amount), item.currency)}, anchors ${item.anchorDay ?? "null"} & ${item.secondAnchorDay ?? "null"}, next ${toISODate(item.nextDate)}${item.active ? "" : ", paused"})`;
      const firstAnchor = item.anchorDay ?? item.nextDate.getUTCDate();
      const anchors = item.secondAnchorDay === null || item.secondAnchorDay === firstAnchor ? [firstAnchor] : [firstAnchor, item.secondAnchorDay];
      const schedule: ScheduledItem = item;
      const shape: SemiMonthlyShape = { nextDate: item.nextDate, anchors, remainingOccurrences: item.remainingOccurrences };

      // --- schedule shape ------------------------------------------------------
      const yearEnd = addDays(addMonths(item.nextDate, 12), -1);
      const walked = owedOccurrences(schedule, item.nextDate, yearEnd);
      const perYearByMonthlyEquivalent = round2((monthlyEquivalent(num(item.amount), item.frequency) * 12) / num(item.amount));
      if (item.secondAnchorDay === null) {
        flag(2, "DROP", `${label}: secondAnchorDay is null, so every schedule walk sees one occurrence a month`, [
          `walk side:   owedOccurrences over the 12 months from ${toISODate(item.nextDate)} yields ${walked.length} occurrence${walked.length === 1 ? "" : "s"} (period summary, Afford, payday check-in, posting all use this walk)`,
          `rate side:   monthlyEquivalent(SEMI_MONTHLY) = amount x 2 -> ${perYearByMonthlyEquivalent} a year (Recurring page total, monthly pace fallback)`,
          `the readers disagree by ${money((perYearByMonthlyEquivalent - walked.length) * num(item.amount), item.currency)} a year; neither the Recurring form (recurringSchema) nor Afford (affordInputSchema, narrowed to AFFORD_FREQUENCIES) writes a SEMI_MONTHLY row without both anchors any more, so this state now means a row written outside the app or a future validation regression`,
        ]);
      } else if (item.secondAnchorDay === firstAnchor) {
        flag(2, "DROP", `${label}: both anchors are day ${firstAnchor}, so the walk advances once a month`, [
          `owedOccurrences over 12 months: ${walked.length}; monthlyEquivalent implies ${perYearByMonthlyEquivalent}`,
        ]);
      } else {
        const expected = independentOwed(shape, item.nextDate, yearEnd);
        const walkedKeys = new Set(walked.map((date) => date.getTime()));
        const expectedKeys = new Set(expected.map((date) => date.getTime()));
        const missing = expected.filter((date) => !walkedKeys.has(date.getTime()));
        const extra = walked.filter((date) => !expectedKeys.has(date.getTime()));
        if (missing.length > 0) {
          flag(2, "DROP", `${label}: the schedule walk skips ${missing.length} of its anchor realizations in the next 12 months`, [
            `missing from owedOccurrences: ${isoList(missing)}`,
            `independent enumeration (anchor clamped to month length, weekend-shifted with payDayOfMonth): ${expected.length} dates; walk: ${walked.length}`,
          ]);
        }
        if (extra.length > 0) {
          flag(2, "DOUBLE", `${label}: the schedule walk yields ${extra.length} date${extra.length === 1 ? "" : "s"} that are not anchor realizations`, [
            `extra in owedOccurrences: ${isoList(extra)}`,
          ]);
        }
        if (item.remainingOccurrences === null && missing.length === 0 && extra.length === 0 && expected.length !== 24) {
          const coincide = expected.length < 24 ? "two realizations coincide on one date in some month (posting keys occurrences by date, so that month is one charge)" : "nextDate is not itself an anchor realization (it posts once there, then follows the anchors)";
          info(`note: ${label} owes ${expected.length} occurrences over the next 12 months, not the 24 monthlyEquivalent assumes: ${coincide}`);
        }
      }

      // --- posted history: each claimed occurrence reaches the ledger once -----
      const rows = await prisma.transaction.findMany({
        where: { source: "RECURRING", externalId: { startsWith: `${item.id}:` } },
        orderBy: { date: "asc" },
        select: { id: true, date: true, amount: true, currency: true, externalId: true, accountId: true, note: true },
      });
      for (const row of rows) {
        const keyed = fromISODate((row.externalId as string).slice(item.id.length + 1));
        if (!keyed || keyed.getTime() !== row.date.getTime()) {
          flag(2, "MISMATCH", `${label}: posted row ${row.id} is dated ${toISODate(row.date)} but its key says ${row.externalId}`, [
            `the key is what pairs the row with its occurrence (and with a GoalContribution); the date is what every period and month reader files it under`,
          ]);
        }
      }
      const degraded = item.secondAnchorDay === null || item.secondAnchorDay === firstAnchor;
      if (degraded) {
        info(`note: ${label} is audited for its anchors only; its posted history and live counts are skipped until it has two distinct anchors`);
      }
      if (rows.length > 0 && item.accountId && !degraded) {
        let period = periodInfo(nextPeriod(periodForDate(rows[0].date))); // the first period is partial: skipped
        for (
          let guard = 0;
          guard < 400 && period.end.getTime() < item.nextDate.getTime() && period.end.getTime() <= today.getTime();
          guard += 1, period = periodInfo(nextPeriod(period))
        ) {
          periodsAudited += 1;
          ownPeriodsAudited += 1;
          const expected = anchorRealizations(anchors, period.start, period.end);
          const posted = rows.filter((row) => row.date.getTime() >= period.start.getTime() && row.date.getTime() <= period.end.getTime());
          // Hand-logged payments of this period's occurrences: the charges
          // posting recorded as settling them (RecurringSettlement - any
          // account, possibly dated just before the period), plus, for
          // occurrences claimed before that pairing was kept, unpaired charges
          // on the item's own account the matcher recognises as this item.
          const settledHere = await prisma.recurringSettlement.findMany({
            where: { recurringItemId: item.id, dueDate: periodRange(period) },
            select: { transaction: { select: { id: true, date: true, amount: true, currency: true, note: true } } },
          });
          const candidates = await prisma.transaction.findMany({
            where: { type: "EXPENSE", accountId: item.accountId, source: { not: "RECURRING" }, recurringSettlement: { is: null }, date: periodRange(period) },
            select: { id: true, date: true, amount: true, currency: true, originalAmount: true, originalCurrency: true, categoryId: true, note: true },
          });
          const matched = matchRecurringToTransactions(
            [{ id: item.id, name: item.name, amount: num(item.amount), currency: item.currency, categoryId: item.categoryId, kind: item.kind, frequency: item.frequency, nextDate: item.nextDate }],
            candidates.map((tx) => ({
              id: tx.id,
              amount: num(tx.amount),
              currency: tx.currency,
              originalAmount: tx.originalAmount === null ? null : num(tx.originalAmount),
              originalCurrency: tx.originalCurrency,
              categoryId: tx.categoryId,
              note: tx.note,
            })),
          );
          const manual = [
            ...settledHere.map((row) => row.transaction),
            ...candidates.filter((tx) => matched.matchedTransactionIds.has(tx.id)),
          ];
          const describeManual = manual.map((tx) => `${tx.id} (${toISODate(tx.date)}, ${money(num(tx.amount), tx.currency)}, "${tx.note ?? ""}")`).join("; ");
          const describePosted = posted.map((row) => `${row.id} (${toISODate(row.date)})`).join("; ");
          if (posted.length > expected.length) {
            flag(2, "DOUBLE", `${label}: ${period.key} has ${posted.length} posted RECURRING rows for ${expected.length} scheduled occurrence${expected.length === 1 ? "" : "s"}`, [
              `scheduled: ${isoList(expected)}`,
              `posted:    ${describePosted}`,
              `${money(num(item.amount) * (posted.length - expected.length), item.currency)} more than the schedule owes reached the ledger`,
            ]);
          } else if (posted.length + manual.length < expected.length) {
            const postedKeys = new Set(posted.map((row) => row.date.getTime()));
            const unaccounted = expected.filter((date) => !postedKeys.has(date.getTime()));
            flag(2, "DROP", `${label}: ${period.key} owed ${expected.length} occurrence${expected.length === 1 ? "" : "s"} but the ledger shows ${posted.length} posted + ${manual.length} hand-logged`, [
              `scheduled: ${isoList(expected)}; posted: ${describePosted || "(none)"}; hand-logged matches: ${describeManual || "(none)"}`,
              `no ledger row for ${isoList(unaccounted)} - ${money(num(item.amount) * (expected.length - posted.length - manual.length), item.currency)} was claimed (nextDate rolled past it) without reaching the ledger; either the walk dropped it or nextDate was edited forward (item updatedAt ${item.updatedAt.toISOString().slice(0, 10)})`,
            ]);
          } else if (posted.length + manual.length > expected.length) {
            flag(2, "DOUBLE", `${label}: ${period.key} shows ${posted.length} posted + ${manual.length} hand-logged charge${manual.length === 1 ? "" : "s"} for ${expected.length} scheduled occurrence${expected.length === 1 ? "" : "s"}`, [
              `scheduled: ${isoList(expected)}`,
              `posted RECURRING rows: ${describePosted || "(none)"}`,
              `hand-logged charges the posting matcher recognises as this item: ${describeManual}`,
              `${money(num(item.amount) * (posted.length + manual.length - expected.length), item.currency)} of the same bill is in the ledger twice (posting only consumes a charge logged before it runs)`,
            ]);
          }
        }
        if (ownPeriodsAudited === 0) info(`note: ${label} has posted rows only in a partial period; nothing fully claimed to audit yet`);
      } else if (rows.length === 0) {
        info(`note: ${label} has no posted history yet`);
      }

      // --- two items or two rows covering the same bill ------------------------
      if (item.active && item.accountId && !degraded) {
        const horizon = addDays(today, 90);
        const own = new Set(owedOccurrences(schedule, today, horizon).map((date) => date.getTime()));
        for (const other of allItems) {
          if (other.id === item.id || !other.active || other.accountId !== item.accountId) continue;
          if (other.currency !== item.currency || !sameCents(num(other.amount), num(item.amount))) continue;
          const shared = owedOccurrences(other, today, horizon).filter((date) => own.has(date.getTime()));
          if (shared.length === 0) continue;
          flag(2, "DOUBLE", `${label} and "${other.name}" (${other.id}, ${other.frequency}, anchor ${other.anchorDay ?? "null"}) both charge ${money(num(item.amount), item.currency)} on the same account on the same dates`, [
            `shared due dates in the next 90 days: ${isoList(shared)}`,
            `both will post, and both count in every committed figure - the same bill through two items (the pre-SEMI_MONTHLY "two MONTHLY items" workaround left beside the real item looks exactly like this)`,
          ]);
        }
      }
      for (const row of rows) {
        const others = await prisma.transaction.findMany({
          where: {
            source: "RECURRING",
            accountId: row.accountId,
            date: row.date,
            amount: row.amount,
            currency: row.currency,
            id: { not: row.id },
            NOT: { externalId: { startsWith: `${item.id}:` } },
          },
          select: { id: true, externalId: true },
        });
        for (const other of others) {
          const otherItem = itemById.get(itemIdFromKey(other.externalId ?? "") ?? "");
          flag(2, "DOUBLE", `${label}: ${toISODate(row.date)} was posted twice on the same account for ${money(num(row.amount), row.currency)}`, [
            `this item's row: ${row.id} (${row.externalId})`,
            `other row:       ${other.id} (${other.externalId}${otherItem ? `, item "${otherItem.name}"` : ", item no longer exists"})`,
          ]);
        }
      }

      // --- live readers agree with the independent count -----------------------
      if (item.active && !degraded && skipReasonFor(item) === null) {
        const liveEnd = livePeriods[livePeriods.length - 1].end;
        for (const period of livePeriods) {
          const expectedDates = independentFiled(shape, today, context.currentPeriod.key, liveEnd)
            .filter((entry) => entry.key === period.key)
            .map((entry) => entry.due);
          const live = (liveSummaries.get(period.key)?.commitments ?? []).filter(
            (occurrence) => occurrence.itemId === item.id && occurrence.source === "schedule",
          ).length;
          if (live !== expectedDates.length) {
            flag(2, live < expectedDates.length ? "DROP" : "DOUBLE", `${label}: getPeriodSummary(${period.key}) holds ${live} scheduled occurrence${live === 1 ? "" : "s"}, the anchors say ${expectedDates.length}`, [
              `independent: ${isoList(expectedDates)}`,
              `the committed figure, the payday check-in's subscription rows and the goal roadmap all read these occurrences`,
            ]);
          }
        }
        const chosen = activeAccounts.find((account) => account.id === item.accountId);
        if (chosen) {
          const refs: PeriodRef[] = livePeriods.map(({ year, month, period }) => ({ year, month, period }));
          const horizonEnd = livePeriods[livePeriods.length - 1].end;
          const [withItem, withoutItem] = await Promise.all([
            projectPeriods(refs, chosen, activeAccounts, context),
            projectPeriods(refs, chosen, activeAccounts, context, { excludeItemId: item.id }),
          ]);
          const filed = new Map<string, number>();
          for (const { key } of independentFiled(shape, today, context.currentPeriod.key, horizonEnd)) {
            filed.set(key, (filed.get(key) ?? 0) + 1);
          }
          for (const period of livePeriods) {
            const a = withItem.get(period.key)!;
            const b = withoutItem.get(period.key)!;
            const count = filed.get(period.key) ?? 0;
            const deltaFlexible = round2(a.flexible.committed - a.flexible.estimatedGoalFunding - (b.flexible.committed - b.flexible.estimatedGoalFunding));
            const expectedFlexible = round2(count * toDisplay(num(item.amount), item.currency));
            const deltaAccount = round2(a.account.committed - a.account.estimatedGoalFunding - (b.account.committed - b.account.estimatedGoalFunding));
            const expectedAccount = round2(count * convert(num(item.amount), item.currency, chosen.currency, rates));
            if (!sameCents(deltaFlexible, expectedFlexible) || !sameCents(deltaAccount, expectedAccount)) {
              const kind: FindingKind = deltaFlexible < expectedFlexible ? "DROP" : "DOUBLE";
              flag(2, kind, `${label}: Afford commits ${money(deltaFlexible, displayCurrency)} to ${period.key} for it, the anchors say ${money(expectedFlexible, displayCurrency)} (${count} occurrence${count === 1 ? "" : "s"})`, [
                `per account "${chosen.name}": ${money(deltaAccount, chosen.currency)} vs ${money(expectedAccount, chosen.currency)}`,
                `measured as projectPeriods with and without excludeItemId, net of the goal estimate (loadScheduledCommitments in src/lib/data/afford.ts, over the period commitments)`,
              ]);
            }
          }
        }
      }
    }
    if (semiItems.length > 0) {
      info(`examined ${semiItems.length} SEMI_MONTHLY item${semiItems.length === 1 ? "" : "s"}: 12-month walk vs anchor enumeration, ${periodsAudited} fully claimed pay period${periodsAudited === 1 ? "" : "s"} of posted history, ${livePeriods.length} live periods through getPeriodSummary and projectPeriods`);
    }
    sectionResult(2);
  }

  // =========================================================================
  console.log("\n== pair 3: Afford goal-funding estimate vs confirmed GOAL allocations ==");
  // =========================================================================
  {
    const activeAccounts = await prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    });
    const checkins = await prisma.paydayCheckin.findMany({
      select: {
        id: true,
        year: true,
        month: true,
        period: true,
        status: true,
        currency: true,
        allocations: {
          where: { type: "GOAL" },
          select: { id: true, goalId: true, accountId: true, plannedAmount: true, recommendedAmount: true, currency: true, goal: { select: { name: true } } },
        },
      },
    });

    if (activeAccounts.length === 0) {
      info("no active accounts: Afford has nothing to project");
    } else {
      const refsByKey = new Map<string, PeriodInfo>();
      let cursor = context.currentPeriod;
      for (let i = 0; i < horizonPeriods; i += 1) {
        refsByKey.set(cursor.key, cursor);
        cursor = periodInfo(nextPeriod(cursor));
      }
      for (const checkin of checkins) {
        const period = periodInfo(checkin);
        if (period.start.getTime() >= context.currentPeriod.start.getTime()) refsByKey.set(period.key, period);
      }
      const periods = [...refsByKey.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
      const refs: PeriodRef[] = periods.map(({ year, month, period }) => ({ year, month, period }));

      // The period's recurring commitments, as the app defines them: whole()
      // of the period commitments (src/lib/period-commitments.ts) - pair 2
      // checks that walk against an independent anchor count; this pair is
      // about what Afford adds on top of it. Each occurrence counts at what it
      // costs the plan (wholeAmount: less what a deposit the user earmarked
      // for it covers - pair 5 checks that part), on the account the money
      // leaves (the ledger row's, the paying charge's, else the item's), and
      // only an active account carries a per-account figure.
      const scheduledTotal = new Map<string, number>();
      const scheduledByAccount = new Map<string, Map<string, number>>();
      for (const [key, occurrences] of await loadCommitments(periods, context)) {
        for (const occurrence of whole(occurrences)) {
          scheduledTotal.set(key, (scheduledTotal.get(key) ?? 0) + toDisplay(wholeAmount(occurrence), occurrence.currency));
          const account = occurrence.accountId ? activeAccounts.find((candidate) => candidate.id === occurrence.accountId) : undefined;
          if (!account) continue;
          const byAccount = scheduledByAccount.get(key) ?? new Map<string, number>();
          byAccount.set(account.id, (byAccount.get(account.id) ?? 0) + convert(wholeAmount(occurrence), occurrence.currency, account.currency, rates));
          scheduledByAccount.set(key, byAccount);
        }
      }

      const projectionsByChosen = new Map<string, Awaited<ReturnType<typeof projectPeriods>>>();
      for (const account of activeAccounts) {
        projectionsByChosen.set(account.id, await projectPeriods(refs, account, activeAccounts, context));
      }
      const paces = (await getGoalRoadmapAmounts(planPeriodRef(context as AppContext), context as AppContext)).filter((pace) => pace.targetDate !== null);

      let confirmedCount = 0;
      let draftLeakChecks = 0;
      for (const period of periods) {
        const key = period.key;
        const confirmed = checkins.filter((checkin) => periodInfo(checkin).key === key && checkin.status === "CONFIRMED");
        const unconfirmed = checkins.filter((checkin) => periodInfo(checkin).key === key && checkin.status !== "CONFIRMED");
        const goalRows = confirmed.flatMap((checkin) => checkin.allocations);
        const draftRows = unconfirmed.flatMap((checkin) => checkin.allocations);
        const goalRowsTotal = round2(goalRows.reduce((sum, row) => sum + toDisplay(num(row.plannedAmount), row.currency), 0));
        const draftRowsTotal = round2(draftRows.reduce((sum, row) => sum + toDisplay(num(row.plannedAmount), row.currency), 0));
        const goalRowsByAccount = new Map<string, number>();
        for (const row of goalRows) {
          const account = row.accountId ? activeAccounts.find((candidate) => candidate.id === row.accountId) : undefined;
          if (!account) continue;
          goalRowsByAccount.set(account.id, (goalRowsByAccount.get(account.id) ?? 0) + convert(num(row.plannedAmount), row.currency, account.currency, rates));
        }
        const scheduled = round2(scheduledTotal.get(key) ?? 0);
        const isConfirmed = confirmed.length > 0;
        if (isConfirmed) confirmedCount += 1;
        if (draftRows.length > 0) draftLeakChecks += 1;

        // Legacy accountless row beside per-account rows, or duplicate rows, for one goal.
        for (const checkin of confirmed) {
          const byGoal = new Map<string, typeof checkin.allocations>();
          for (const row of checkin.allocations) {
            const goalKey = row.goalId ?? "(deleted goal)";
            byGoal.set(goalKey, [...(byGoal.get(goalKey) ?? []), row]);
          }
          for (const [goalKey, rowsForGoal] of byGoal) {
            const accountless = rowsForGoal.filter((row) => row.accountId === null);
            const perAccount = rowsForGoal.filter((row) => row.accountId !== null);
            const goalName = rowsForGoal[0].goal?.name ?? goalKey;
            if (accountless.length > 0 && perAccount.length > 0) {
              flag(3, "DOUBLE", `${key}: confirmed check-in ${checkin.id} funds goal "${goalName}" through both a legacy accountless GOAL row and per-account rows`, [
                `accountless: ${accountless.map((row) => money(num(row.plannedAmount), row.currency)).join(", ")}; per account: ${perAccount.map((row) => money(num(row.plannedAmount), row.currency)).join(", ")}`,
                `readers sum a goal's rows "either way" (confirmPaydayCheckin), so Afford and the goal page count this funding twice; the app rewrites every allocation on re-confirm, so only a hand-inserted row produces this`,
              ]);
            }
            const seen = new Set<string>();
            for (const row of perAccount) {
              const accountKey = row.accountId as string;
              if (seen.has(accountKey)) {
                flag(3, "DOUBLE", `${key}: confirmed check-in ${checkin.id} has two GOAL rows for goal "${goalName}" on the same account`, [
                  `rows: ${rowsForGoal.filter((candidate) => candidate.accountId === accountKey).map((candidate) => `${candidate.id} ${money(num(candidate.plannedAmount), candidate.currency)}`).join("; ")}`,
                ]);
              }
              seen.add(accountKey);
            }
          }
        }

        // Period-wide decomposition against the reader.
        const anyProjection = projectionsByChosen.get(activeAccounts[0].id)!.get(key)!;
        const flexibleValues = new Set(activeAccounts.map((account) => projectionsByChosen.get(account.id)!.get(key)!.flexible.committed));
        if (flexibleValues.size > 1) {
          flag(3, "MISMATCH", `${key}: the period-wide committed figure differs depending on which account was chosen`, [
            `values: ${[...flexibleValues].map((value) => money(value, displayCurrency)).join(", ")} - it should be the same total for every caller`,
          ]);
        }
        const estimate = anyProjection.flexible.estimatedGoalFunding;
        const estimateListed = round2(anyProjection.estimatedGoals.reduce((sum, goal) => sum + goal.amount, 0));
        if (!sameCents(estimate, estimateListed)) {
          flag(3, "MISMATCH", `${key}: estimatedGoalFunding ${money(estimate, displayCurrency)} does not equal the listed estimatedGoals (${money(estimateListed, displayCurrency)})`, []);
        }
        if (isConfirmed && (estimate > 0 || anyProjection.estimatedGoals.length > 0 || anyProjection.goalPlans.length > 0)) {
          flag(3, "DOUBLE", `${key}: a confirmed period still carries a goal-funding estimate on top of its GOAL rows`, [
            `confirmed side: GOAL rows ${money(goalRowsTotal, displayCurrency)} (${goalRows.length} row${goalRows.length === 1 ? "" : "s"})`,
            `estimate side:  estimatedGoalFunding ${money(estimate, displayCurrency)}, ${anyProjection.estimatedGoals.length} estimatedGoals, ${anyProjection.goalPlans.length} goalPlans - projectPeriods must add none for a period whose check-in is CONFIRMED`,
          ]);
        }
        const residual = round2(anyProjection.flexible.committed - scheduled - goalRowsTotal - estimate);
        if (Math.abs(residual) >= 0.01) {
          const draftHint = draftRows.length > 0 && sameCents(residual, draftRowsTotal) ? ` - exactly the ${money(draftRowsTotal, displayCurrency)} of GOAL rows on a non-confirmed check-in, which must not count` : "";
          flag(3, residual > 0 ? "DOUBLE" : "DROP", `${key}: period-wide committed ${money(anyProjection.flexible.committed, displayCurrency)} does not decompose into schedule + confirmed GOAL rows + estimate`, [
            `recurring commitments (whole() of the period commitments): ${money(scheduled, displayCurrency)}; confirmed GOAL rows: ${money(goalRowsTotal, displayCurrency)}; estimate: ${money(estimate, displayCurrency)}; unexplained: ${money(residual, displayCurrency)}${draftHint}`,
          ]);
        }

        // Per-account decomposition, one projection per chosen account.
        for (const account of activeAccounts) {
          const own = projectionsByChosen.get(account.id)!.get(key)!.account;
          const scheduledOwn = round2(scheduledByAccount.get(key)?.get(account.id) ?? 0);
          const goalOwn = round2(goalRowsByAccount.get(account.id) ?? 0);
          if (isConfirmed && own.estimatedGoalFunding > 0) {
            flag(3, "DOUBLE", `${key}: account "${account.name}" carries an estimated goal share of ${money(own.estimatedGoalFunding, account.currency)} in a confirmed period`, [
              `its confirmed GOAL rows already commit ${money(goalOwn, account.currency)} here`,
            ]);
          }
          const residualOwn = round2(own.committed - scheduledOwn - goalOwn - own.estimatedGoalFunding);
          if (Math.abs(residualOwn) >= 0.01) {
            flag(3, residualOwn > 0 ? "DOUBLE" : "DROP", `${key}: account "${account.name}" committed ${money(own.committed, account.currency)} does not decompose into its schedule + GOAL rows + estimate`, [
              `schedule: ${money(scheduledOwn, account.currency)}; confirmed GOAL rows: ${money(goalOwn, account.currency)}; estimate: ${money(own.estimatedGoalFunding, account.currency)}; unexplained: ${money(residualOwn, account.currency)}`,
            ]);
          }
        }

        // What the estimate would have added had the guard not held: the same
        // planGoalFunding split over each account's projected room, so a
        // "clean" confirmed period is shown to be a non-vacuous check.
        let wouldBe = 0;
        if (isConfirmed && paces.length > 0) {
          const rooms = activeAccounts.map((account) => {
            const own = projectionsByChosen.get(account.id)!.get(key)!.account;
            const scheduledOwn = round2(scheduledByAccount.get(key)?.get(account.id) ?? 0);
            return { accountId: account.id, name: account.name, currency: account.currency, headroom: round2(own.income - scheduledOwn - own.buffer) };
          });
          wouldBe = round2(
            planGoalFunding(paces.map((pace) => ({ goalId: pace.goalId, amount: pace.amount })), rooms, { displayCurrency, rates }).reduce(
              (sum, plan) => sum + plan.recommendedTotal,
              0,
            ),
          );
        }
        const status = isConfirmed
          ? `confirmed: GOAL rows ${money(goalRowsTotal, displayCurrency)} counted, estimate ${money(estimate, displayCurrency)}${paces.length > 0 ? ` (an unguarded estimate would have added ${money(wouldBe, displayCurrency)})` : " (no dated goal to estimate for)"}`
          : `not confirmed: estimate ${money(estimate, displayCurrency)}${anyProjection.estimatedGoals.length ? ` over ${anyProjection.estimatedGoals.map((goal) => goal.name).join(", ")}` : ""}, GOAL rows 0${draftRows.length ? ` (${draftRows.length} GOAL row${draftRows.length === 1 ? "" : "s"} on a ${unconfirmed.map((checkin) => checkin.status).join("/")} check-in correctly ignored)` : ""}`;
        info(`${key}  schedule ${money(scheduled, displayCurrency)}  ${status}`);
      }
      info(`examined ${periods.length} period${periods.length === 1 ? "" : "s"} (${confirmedCount} confirmed, ${draftLeakChecks} with non-confirmed GOAL rows) x ${activeAccounts.length} account${activeAccounts.length === 1 ? "" : "s"}; ${paces.length} dated goal${paces.length === 1 ? "" : "s"} with a pace to estimate`);
      if (paces.length === 0 || confirmedCount === 0) {
        info(`note: the "no estimate on a confirmed period" check is vacuous here - it needs at least one dated goal still being saved for and one confirmed check-in in the horizon`);
      }
    }

    // --- scheduled contributions: one period each, the one their money counts in ---
    // A recurring contribution is filed in exactly one period by the period
    // commitments - the same one whether a reader loads that period alone
    // (period summary, check-in) or with others (Afford, goal plans) - and,
    // once its money has moved, in the period whose goal window counts that
    // GoalContribution as contributed (contributionWindow in
    // src/lib/goal-plan.ts, over loadPayLanded). Counted in two periods, the
    // room is reserved twice; in neither, or in another period than its
    // money, a goal's scheduled and contributed figures disagree (R3). The
    // app's own readers are compared with each other here, not re-derived.
    {
      const { contributionWindow } = await import("../src/lib/goal-plan");
      const { loadPayLanded } = await import("../src/lib/data/period-income");
      const span: PeriodInfo[] = [];
      let back: PeriodInfo = context.currentPeriod;
      for (let i = 0; i < 6; i += 1) back = periodInfo(previousPeriod(back));
      for (let cursor = back; span.length < 7 + horizonPeriods; cursor = periodInfo(nextPeriod(cursor))) span.push(cursor);
      const spanKeys = new Set(span.map((period) => period.key));
      const holders = new Map<string, string[]>();
      const alone = new Map<string, { period: string; status: string; due: Date; name: string }>();
      for (const period of span) {
        for (const occurrence of (await loadCommitments([period], context)).get(period.key) ?? []) {
          if (occurrence.kind !== "CONTRIBUTION") continue;
          holders.set(occurrence.key, [...(holders.get(occurrence.key) ?? []), period.key]);
          alone.set(occurrence.key, { period: period.key, status: occurrence.status, due: occurrence.dueDate, name: occurrence.name });
        }
      }
      const together = new Map<string, string>();
      for (const [key, occurrences] of await loadCommitments(span, context)) {
        for (const occurrence of occurrences) if (occurrence.kind === "CONTRIBUTION") together.set(occurrence.key, key);
      }
      for (const [key, periods] of holders) {
        const seen = alone.get(key)!;
        if (periods.length > 1) {
          flag(3, "DOUBLE", `contribution "${seen.name}" due ${toISODate(seen.due)} is scheduled in ${periods.length} periods: ${periods.join(", ")}`, [
            `each period's commitments reserve it, so the room is lowered twice for one contribution`,
          ]);
        } else if (together.get(key) !== periods[0]) {
          flag(3, "MISMATCH", `contribution "${seen.name}" due ${toISODate(seen.due)} is in ${periods[0]} when its period is loaded alone, in ${together.get(key) ?? "no period"} when loaded with the others`, [
            `a single-period reader (period summary, check-in) and a multi-period one (Afford, the goal plans) disagree on where it is reserved`,
          ]);
        }
      }
      for (const key of together.keys()) {
        if (!holders.has(key)) {
          flag(3, "DROP", `contribution ${key} is scheduled in ${together.get(key)} only when the periods are loaded together`, [
            `a single-period reader leaves it out of every period`,
          ]);
        }
      }

      // Each contribution's money moved on a day; the period whose goal
      // window holds that day must be the one that reserved it.
      const payLanded = await loadPayLanded(span, context);
      const windowOf = (day: Date) =>
        span.find((period) => {
          const window = contributionWindow(period, payLanded);
          return day.getTime() >= window.from.getTime() && day.getTime() < window.until.getTime();
        }) ?? null;
      const contributed = await prisma.goalContribution.findMany({
        where: { recurringExternalId: { not: null } },
        select: { recurringExternalId: true, date: true, amount: true, currency: true, goal: { select: { name: true } } },
      });
      let contributedChecked = 0;
      for (const row of contributed) {
        const key = row.recurringExternalId as string;
        const expected = windowOf(row.date);
        if (!expected) continue;
        contributedChecked += 1;
        const periods = holders.get(key) ?? [];
        if (periods.length === 0) {
          flag(3, "DROP", `goal "${row.goal.name}"'s automatic contribution ${key} (${money(num(row.amount), row.currency)}, dated ${toISODate(row.date)}) is in no period's commitments`, [
            `contributed side: counted in ${expected.key} (its goal window holds ${toISODate(row.date)})`,
            `scheduled side:   no period's commitments hold the occurrence it posted for`,
          ]);
        } else if (periods.length === 1 && periods[0] !== expected.key) {
          flag(3, "MISMATCH", `goal "${row.goal.name}"'s automatic contribution ${key} is scheduled in ${periods[0]} but contributed in ${expected.key}`, [
            `contributed side: GoalContribution dated ${toISODate(row.date)} -> ${expected.key}'s goal window`,
            `scheduled side:   the period commitments file the occurrence in ${periods[0]} - one period then reads a follow-through shortfall and the other an inflated contribution`,
          ]);
        }
      }

      // Every date an active, postable contribution item still owes inside
      // the span is reserved somewhere.
      let owedChecked = 0;
      const spanEnd = span[span.length - 1].end;
      for (const item of allItems) {
        if (item.kind !== "CONTRIBUTION" || !item.active || skipReasonFor(item) !== null) continue;
        for (const due of owedOccurrences(item, today, spanEnd)) {
          const key = `${item.id}:${toISODate(due)}`;
          const home = due.getTime() < today.getTime() ? context.currentPeriod : windowOf(due);
          if (!home || !spanKeys.has(home.key) || home.key === span[span.length - 1].key) continue;
          owedChecked += 1;
          if (!holders.has(key)) {
            flag(3, "DROP", `contribution "${item.name}" due ${toISODate(due)} is in no period's commitments`, [
              `its schedule still owes it (owedOccurrences), and its goal window is ${home.key}'s`,
            ]);
          }
        }
      }
      info(`scheduled contributions: ${holders.size} occurrence${holders.size === 1 ? "" : "s"} across ${span.length} periods (${span[0].key} to ${span[span.length - 1].key}) each loaded alone and together; ${contributedChecked} posted or settled one${contributedChecked === 1 ? "" : "s"} checked against the goal window of their money, ${owedChecked} still owed checked for a home`);
    }
    sectionResult(3);
  }

  // =========================================================================
  console.log("\n== pair 4: a charge or deposit brought in vs the row Cadence wrote for it ==");
  // =========================================================================
  // Its own matching, in SQL and plain code - never the entry points' matcher
  // (planPostedDuplicates / planSettlements), so a gap in those (a window
  // that ends too early, an account they do not look at) shows up here
  // instead of being inherited. Deliberately wider than the app's rules: a
  // finding is a pair to look at, not a verdict.
  {
    const normalized = (value: string | null | undefined) => (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const cents = (value: number) => Math.round(value * 100);
    type MoneyShape = { amount: number; currency: string; originalAmount: number | null; originalCurrency: string | null };
    // The same money, exactly: some currency both rows hold a figure in - as
    // stored, or as entered before being stored in another.
    const sameMoney = (a: MoneyShape, b: MoneyShape) => {
      const figures = (row: MoneyShape) => [
        [row.currency, row.amount],
        ...(row.originalCurrency !== null && row.originalAmount !== null ? [[row.originalCurrency, row.originalAmount] as const] : []),
      ] as const;
      return figures(a).some(([ca, va]) => figures(b).some(([cb, vb]) => ca === cb && Math.abs(cents(va as number) - cents(vb as number)) <= 1));
    };

    // (a) An occurrence settled by a charge (RecurringSettlement) and posted
    // (its RECURRING row) both.
    const settlements = await prisma.$queryRaw<{ id: string; occurrenceKey: string; transactionId: string; dueDate: Date; kind: string; postedId: string | null; postedDate: Date | null; postedAmount: string | null; postedCurrency: string | null }[]>`
      SELECT s.id, s."occurrenceKey", s."transactionId", s."dueDate", s.kind::text AS kind,
             t.id AS "postedId", t.date AS "postedDate", t.amount::text AS "postedAmount", t.currency AS "postedCurrency"
      FROM "RecurringSettlement" s
      LEFT JOIN "Transaction" t ON t.source = 'RECURRING' AND t."externalId" = s."occurrenceKey"`;
    let settledAndPosted = 0;
    for (const settlement of settlements) {
      if (!settlement.postedId) continue;
      settledAndPosted += 1;
      flag(4, "DOUBLE", `occurrence ${settlement.occurrenceKey} is both settled by a charge and posted`, [
        `settled:  RecurringSettlement ${settlement.id} -> Transaction ${settlement.transactionId} (due ${toISODate(settlement.dueDate)})`,
        `posted:   Transaction ${settlement.postedId} (${toISODate(settlement.postedDate!)}) ${money(Number(settlement.postedAmount), settlement.postedCurrency!)}`,
      ]);
    }

    // (b) One schedule slot paid twice under two keys: an item's consumed
    // occurrences (RECURRING rows and settlements, by the due date in their
    // key) closer together than its schedule ever puts two - the same
    // calendar month for a monthly item, the same year for a yearly one,
    // under half the interval for weekly and biweekly, under half the gap
    // between its two days (less two days of weekend shift) for a
    // semi-monthly one. A schedule edit that left a settlement on the old
    // key while the new one posted is this.
    const consumed = await prisma.$queryRaw<{ itemId: string; due: Date; key: string; how: string; rowId: string }[]>`
      SELECT left("externalId", length("externalId") - 11) AS "itemId", to_date(right("externalId", 10), 'YYYY-MM-DD') AS due,
             "externalId" AS key, 'posted' AS how, id AS "rowId"
      FROM "Transaction" WHERE source = 'RECURRING' AND type = 'EXPENSE' AND "externalId" ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      UNION ALL
      SELECT left("occurrenceKey", length("occurrenceKey") - 11), to_date(right("occurrenceKey", 10), 'YYYY-MM-DD'),
             "occurrenceKey", 'settled', "transactionId"
      FROM "RecurringSettlement" WHERE "occurrenceKey" ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
    const schedules = new Map(
      (
        await prisma.$queryRaw<{ id: string; name: string; frequency: string; anchorDay: number | null; secondAnchorDay: number | null; categoryId: string | null }[]>`
          SELECT id, name, frequency::text AS frequency, "anchorDay", "secondAnchorDay", "categoryId" FROM "RecurringItem"`
      ).map((row) => [row.id, row]),
    );
    const byItem = new Map<string, typeof consumed>();
    for (const row of consumed) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
    let slotsChecked = 0;
    for (const [itemId, rows] of byItem) {
      const schedule = schedules.get(itemId);
      if (!schedule) continue;
      const sorted = [...rows].sort((a, b) => a.due.getTime() - b.due.getTime());
      slotsChecked += sorted.length;
      const tooClose = (a: Date, b: Date) => {
        const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
        switch (schedule.frequency) {
          case "MONTHLY":
            return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
          case "YEARLY":
            return a.getUTCFullYear() === b.getUTCFullYear();
          case "WEEKLY":
            return days < 3.5;
          case "BIWEEKLY":
            return days < 7;
          default: {
            const gap = Math.abs((schedule.anchorDay ?? 1) - (schedule.secondAnchorDay ?? 16));
            return days < Math.max(1, Math.min(gap, 30 - gap) / 2 - 2);
          }
        }
      };
      for (let i = 1; i < sorted.length; i += 1) {
        const [earlier, later] = [sorted[i - 1], sorted[i]];
        if (earlier.key === later.key || !tooClose(earlier.due, later.due)) continue;
        flag(4, "DOUBLE", `"${schedule.name}" (${schedule.frequency}) has one slot paid twice: ${toISODate(earlier.due)} ${earlier.how} and ${toISODate(later.due)} ${later.how}`, [
          `${earlier.how}: ${earlier.key} (${earlier.how === "posted" ? "RECURRING row" : "settled by Transaction"} ${earlier.rowId})`,
          `${later.how}: ${later.key} (${later.how === "posted" ? "RECURRING row" : "settled by Transaction"} ${later.rowId})`,
          "its schedule never puts two occurrences this close: a settlement left on a key the schedule no longer has, or two items for one bill",
        ]);
      }
    }

    // (c) A charge brought in (CSV, receipt, manual entry) on any account
    // holding exactly the money of a RECURRING row, dated in that row's
    // half-month widened by five days each side; a deposit holding exactly a
    // check-in paycheck's money on its account within ten days of it. Rows a
    // settlement already pairs, transfer legs and hand-logged contributions'
    // own expenses (pair 1) are accounted for and left out.
    const candidates = await prisma.$queryRaw<
      {
        postedId: string; postedKind: string; postedAccount: string; postedDate: Date; postedAmount: string; postedCurrency: string; postedOriginalAmount: string | null; postedOriginalCurrency: string | null; postedKey: string | null;
        broughtId: string; broughtSource: string; broughtAccount: string; broughtDate: Date; broughtAmount: string; broughtCurrency: string; broughtOriginalAmount: string | null; broughtOriginalCurrency: string | null; broughtNote: string | null; broughtCategory: string | null;
      }[]
    >`
      WITH posted AS (
        SELECT id, 'recurring' AS kind, "accountId", date, amount, currency, "originalAmount", "originalCurrency", "externalId",
               to_date(right("externalId", 10), 'YYYY-MM-DD') AS due
        FROM "Transaction"
        WHERE source = 'RECURRING' AND type = 'EXPENSE' AND "externalId" ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        UNION ALL
        SELECT id, 'paycheck', "accountId", date, amount, currency, "originalAmount", "originalCurrency", NULL, date
        FROM "Transaction" WHERE source = 'PAYDAY_CHECKIN' AND type = 'INCOME'
      ), bounds AS (
        SELECT *,
          CASE WHEN extract(day FROM due) <= 15 THEN date_trunc('month', due)::date ELSE date_trunc('month', due)::date + 15 END - 5 AS lo,
          CASE WHEN extract(day FROM due) <= 15 THEN date_trunc('month', due)::date + 14 ELSE (date_trunc('month', due) + interval '1 month - 1 day')::date END + 5 AS hi
        FROM posted
      ), brought AS (
        SELECT t.* FROM "Transaction" t
        WHERE t.type IN ('EXPENSE', 'INCOME') AND t.source NOT IN ('RECURRING', 'PAYDAY_CHECKIN', 'OPENING_BALANCE') AND t."transferId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "RecurringSettlement" s WHERE s."transactionId" = t.id)
          AND (t."externalId" IS NULL OR t."externalId" NOT LIKE ${`${MANUAL_CONTRIBUTION_EXTERNAL_ID_PREFIX}%`})
      )
      SELECT p.id AS "postedId", p.kind AS "postedKind", p."accountId" AS "postedAccount", p.date AS "postedDate", p.amount::text AS "postedAmount", p.currency AS "postedCurrency",
             p."originalAmount"::text AS "postedOriginalAmount", p."originalCurrency" AS "postedOriginalCurrency", p."externalId" AS "postedKey",
             b.id AS "broughtId", b.source::text AS "broughtSource", b."accountId" AS "broughtAccount", b.date AS "broughtDate", b.amount::text AS "broughtAmount", b.currency AS "broughtCurrency",
             b."originalAmount"::text AS "broughtOriginalAmount", b."originalCurrency" AS "broughtOriginalCurrency", b.note AS "broughtNote", b."categoryId" AS "broughtCategory"
      FROM bounds p JOIN brought b
        ON (p.kind = 'recurring' AND b.type = 'EXPENSE' AND b.date BETWEEN p.lo AND p.hi)
        OR (p.kind = 'paycheck' AND b.type = 'INCOME' AND b."accountId" = p."accountId" AND b.date BETWEEN p.date - 10 AND p.date + 10)`;
    type Verdict = { kind: "DOUBLE" | "POSSIBLE"; reason: string; days: number; row: (typeof candidates)[number] };
    const verdicts: Verdict[] = [];
    for (const row of candidates) {
      const posted: MoneyShape = { amount: Number(row.postedAmount), currency: row.postedCurrency, originalAmount: row.postedOriginalAmount === null ? null : Number(row.postedOriginalAmount), originalCurrency: row.postedOriginalCurrency };
      const brought: MoneyShape = { amount: Number(row.broughtAmount), currency: row.broughtCurrency, originalAmount: row.broughtOriginalAmount === null ? null : Number(row.broughtOriginalAmount), originalCurrency: row.broughtOriginalCurrency };
      const days = Math.abs(Math.round((row.broughtDate.getTime() - row.postedDate.getTime()) / 86_400_000));
      const sameAccount = row.broughtAccount === row.postedAccount;
      const item = row.postedKey ? schedules.get(row.postedKey.slice(0, -11)) : undefined;
      const names = Boolean(item) && ((normalized(item!.name).length > 0 && normalized(row.broughtNote).includes(normalized(item!.name))) || (item!.categoryId !== null && item!.categoryId === row.broughtCategory));
      if (sameMoney(posted, brought)) {
        if (row.postedKind === "paycheck") verdicts.push({ kind: "DOUBLE", reason: "the paycheck's exact amount, within ten days", days, row });
        else if (names) verdicts.push({ kind: "DOUBLE", reason: `exact amount, names the item${sameAccount ? "" : ", on another account"}`, days, row });
        else if (sameAccount && days <= 4) verdicts.push({ kind: "DOUBLE", reason: "exact amount on the same account within four days", days, row });
        else verdicts.push({ kind: "POSSIBLE", reason: `exact amount${sameAccount ? "" : " on another account"}, but it names neither the item nor its category${sameAccount ? " and is more than four days away" : ""}`, days, row });
      } else if (sameAccount && row.postedKind === "recurring") {
        const inBrought = convert(posted.amount, posted.currency, brought.currency, rates);
        if (inBrought > 0 && Math.abs(brought.amount - inBrought) <= 0.03 * inBrought && (posted.currency !== brought.currency || posted.originalCurrency !== null || brought.originalCurrency !== null)) {
          verdicts.push({ kind: "POSSIBLE", reason: "amounts agree only after conversion at the stored rates", days, row });
        }
      }
    }
    // One brought-in row, one posted row: strongest and nearest first.
    verdicts.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "DOUBLE" ? -1 : 1) || a.days - b.days || a.row.broughtId.localeCompare(b.row.broughtId));
    const usedPosted = new Set<string>();
    const usedBrought = new Set<string>();
    let doubles = 0;
    let possibles = 0;
    for (const verdict of verdicts) {
      const { row } = verdict;
      if (usedPosted.has(row.postedId) || usedBrought.has(row.broughtId)) continue;
      usedPosted.add(row.postedId);
      usedBrought.add(row.broughtId);
      if (verdict.kind === "DOUBLE") doubles += 1;
      else possibles += 1;
      const label = row.postedKind === "paycheck" ? "paycheck" : `posted charge "${(row.postedKey && schedules.get(row.postedKey.slice(0, -11))?.name) ?? "?"}"`;
      flag(4, verdict.kind, `${row.broughtSource} row ${row.broughtId} duplicates the ${label} ${row.postedId}`, [
        `brought in: Transaction ${row.broughtId} (${row.broughtSource}, ${toISODate(row.broughtDate)}, account ${row.broughtAccount}) ${money(Number(row.broughtAmount), row.broughtCurrency)}${row.broughtNote ? ` "${row.broughtNote}"` : ""}`,
        `written:    Transaction ${row.postedId} (${row.postedKind === "paycheck" ? "PAYDAY_CHECKIN" : `RECURRING ${row.postedKey}`}, ${toISODate(row.postedDate)}, account ${row.postedAccount}) ${money(Number(row.postedAmount), row.postedCurrency)}`,
        `why: ${verdict.reason}; ${verdict.days} day${verdict.days === 1 ? "" : "s"} apart`,
      ]);
    }
    // (d) A confirmed check-in's paycheck vs the deposits the ledger already
    // held for it when it was confirmed. Its own SQL for which deposits those
    // are: ordinary INCOME rows on the account (not the check-in's own
    // PAYDAY_CHECKIN rows, not one-off income, not a payback of a shared
    // expense), less any part earmarked for a recurring payment, dated from
    // five days before the period's first day to five days before the next
    // period's (a payday is never more than three days early, so this is the
    // income window), created before the check-in was last confirmed (its
    // allocations are rewritten on every confirm). The check-in owes them
    // adoption. What the check-in itself adds to its period's income is the
    // app's own snapshotIncome (src/lib/period-income.ts); those deposits
    // count as rows in the same period (loadPeriodIncome, "fact", confirms
    // both are in). Together they must not exceed the paycheck typed: any
    // excess is money counted twice - DOUBLE when it is pay-sized (half the
    // paycheck or more, the size of a salary deposit), POSSIBLE when smaller
    // (a refund or interest the check-in did not take in).
    const { snapshotIncome } = await import("../src/lib/period-income");
    const { loadPeriodIncome } = await import("../src/lib/data/period-income");
    // A paycheck that recorded which deposits it adopted
    // (adoptedTransactionIds) is not judged here: its plan's income follows
    // those deposits as they are now, so a deposit it did not adopt is by
    // definition not in it - one fully earmarked at the confirm and freed
    // later is pay the plan does not count yet, not pay counted twice. Pair
    // 5 checks that its adopted deposits are counted once. Read with raw SQL
    // so this script runs on a client generated before the column existed.
    const recordedAdoptions = new Set(
      (
        await prisma.$queryRaw<{ id: string }[]>`
          SELECT s.id FROM "PaydayAccountSnapshot" s
          WHERE cardinality(coalesce(s."adoptedTransactionIds", ARRAY[]::text[])) > 0`
      ).map((row) => row.id),
    );
    const paydaySnapshots = (await prisma.paydayAccountSnapshot.findMany({
      where: { checkin: { status: "CONFIRMED" }, incomeEntered: { gt: 0 } },
      select: {
        id: true,
        accountId: true,
        incomeEntered: true,
        oneOffIncome: true,
        adoptedIncome: true,
        currency: true,
        account: { select: { name: true, currency: true } },
        checkin: { select: { year: true, month: true, period: true, updatedAt: true, allocations: { select: { createdAt: true } } } },
      },
    })).filter((snapshot) => !recordedAdoptions.has(snapshot.id));
    const firstDayOf = (year: number, month: number, period: string) => civilDate(year, month, period === "A" ? 1 : 16);
    const firstDayAfter = (year: number, month: number, period: string) =>
      period === "A" ? civilDate(year, month, 16) : month === 12 ? civilDate(year + 1, 1, 1) : civilDate(year, month + 1, 1);
    let paychecksChecked = 0;
    for (const snapshot of paydaySnapshots) {
      const { year, month, period } = snapshot.checkin;
      const allocationTimes = snapshot.checkin.allocations.map((row) => row.createdAt.getTime());
      const confirmedAt = new Date(allocationTimes.length > 0 ? Math.max(...allocationTimes) : snapshot.checkin.updatedAt.getTime());
      const from = addDays(firstDayOf(year, month, period), -5);
      const until = addDays(firstDayAfter(year, month, period), -5);
      const deposits = await prisma.$queryRaw<{ id: string; date: Date; amount: string; currency: string; source: string; note: string | null; earmarks: { amount: string; currency: string }[] | null }[]>`
        SELECT t.id, t.date, t.amount::text AS amount, t.currency, t.source::text AS source, t.note,
               (SELECT json_agg(json_build_object('amount', e.amount::text, 'currency', e.currency)) FROM "RecurringEarmark" e WHERE e."transactionId" = t.id) AS earmarks
        FROM "Transaction" t
        WHERE t."accountId" = ${snapshot.accountId} AND t.type = 'INCOME' AND t.source <> 'PAYDAY_CHECKIN'
          AND NOT t."isOneOffIncome" AND t."reimbursesTransactionId" IS NULL
          AND t.date >= ${from} AND t.date < ${until} AND t."createdAt" <= ${confirmedAt}`;
      paychecksChecked += 1;
      if (deposits.length === 0) continue;
      const inAccount = (amount: number, currency: string) => convert(amount, currency, snapshot.account.currency, rates);
      const earmarkedOf = (row: (typeof deposits)[number]) => (row.earmarks ?? []).reduce((sum, earmark) => sum + inAccount(Number(earmark.amount), earmark.currency), 0);
      const held = round2(deposits.reduce((sum, row) => sum + Math.max(0, inAccount(Number(row.amount), row.currency) - earmarkedOf(row)), 0));
      const paycheck = num(snapshot.incomeEntered);
      const ownPart = snapshotIncome(
        {
          accountId: snapshot.accountId,
          incomeEntered: paycheck,
          oneOffIncome: snapshot.oneOffIncome === null ? null : num(snapshot.oneOffIncome),
          adoptedIncome: snapshot.adoptedIncome === null ? null : num(snapshot.adoptedIncome),
          currency: snapshot.currency,
        },
        "fact",
      );
      const excess = round2(ownPart + held - paycheck);
      if (excess <= 0.01) continue;
      const key = `${year}-${String(month).padStart(2, "0")}-${period}`;
      const counted = (await loadPeriodIncome([{ year, month, period: period as "A" | "B" }], "fact", context)).get(key)?.byAccount.get(snapshot.accountId) ?? 0;
      if (counted + 0.01 < ownPart + held) continue;
      flag(4, excess + 0.005 >= paycheck / 2 ? "DOUBLE" : "POSSIBLE", `check-in ${key} counts ${snapshot.account.name}'s paycheck beside ${money(held, snapshot.account.currency)} the ledger already held for it`, [
        `paycheck typed: ${money(paycheck, snapshot.currency)}, of it adopted from the ledger: ${snapshot.adoptedIncome === null ? "none recorded" : money(num(snapshot.adoptedIncome), snapshot.currency)}; the check-in itself adds ${money(ownPart, snapshot.currency)}`,
        ...deposits.map((row) => `in the ledger before it was confirmed: Transaction ${row.id} (${row.source}, ${toISODate(row.date)}) ${money(Number(row.amount), row.currency)}${row.earmarks ? `, ${money(earmarkedOf(row), snapshot.account.currency)} earmarked` : ""}${row.note ? ` "${row.note}"` : ""}`),
        `its period counts ${money(counted, snapshot.account.currency)} for the account: ${money(excess, snapshot.account.currency)} more than the paycheck`,
      ]);
    }

    // (e) An installment plan (remainingOccurrences set) makes no more
    // payments than it was created with, paused, resumed or finished. What
    // it was created with is what it has counted - its RECURRING rows and
    // the pairings claimed against it (posting's claim, or a skip or edit
    // that moved nextDate past a recorded "It's that payment") - plus what
    // is left. What it makes is every row and every recorded pairing, plus
    // the payments still to post. A pairing not claimed yet is one of those
    // only while it is one of the next `remaining` occurrences posting will
    // count from nextDate (as stored: resuming a paused plan claims one its
    // skip goes past); any other - behind nextDate, past the countdown, off
    // the schedule - was paid and will never be counted, so the plan pays
    // one installment more. The walk is the app's own (advanceDate), over
    // the keys posting would count (a posted or claimed one is rolled past).
    let plansChecked = 0;
    const plans = allItems.filter((item) => item.remainingOccurrences !== null);
    if (plans.length > 0) {
      const planIds = plans.map((item) => item.id);
      const planPairings = await prisma.recurringSettlement.findMany({
        where: { recurringItemId: { in: planIds } },
        select: { id: true, occurrenceKey: true, dueDate: true, claimedByPostingAt: true, transactionId: true },
      });
      const planRows = await prisma.$queryRaw<{ externalId: string }[]>`
        SELECT "externalId" FROM "Transaction"
        WHERE source = 'RECURRING' AND type = 'EXPENSE' AND "externalId" IS NOT NULL
          AND left("externalId", length("externalId") - 11) = ANY(${planIds})`;
      for (const item of plans) {
        plansChecked += 1;
        const remaining = Math.max(0, item.remainingOccurrences as number);
        const postedKeys = new Set(planRows.map((row) => row.externalId).filter((key) => itemIdFromKey(key) === item.id));
        const pairings = planPairings.filter((row) => itemIdFromKey(row.occurrenceKey) === item.id);
        const claimedKeys = new Set(pairings.filter((row) => row.claimedByPostingAt !== null).map((row) => row.occurrenceKey));
        const counting = new Set<string>();
        let cursor = item.nextDate;
        for (let guard = 0; counting.size < remaining && guard < 400; guard += 1) {
          const key = `${item.id}:${toISODate(cursor)}`;
          if (!postedKeys.has(key) && !claimedKeys.has(key)) counting.add(key);
          cursor = advanceDate(cursor, item.frequency, item.anchorDay, item.secondAnchorDay);
        }
        const pending = pairings.filter((row) => row.claimedByPostingAt === null);
        const stranded = pending.filter((row) => !counting.has(row.occurrenceKey));
        const createdWith = postedKeys.size + claimedKeys.size + remaining;
        const makes = postedKeys.size + pairings.length + remaining - (pending.length - stranded.length);
        if (makes <= createdWith) continue;
        const state = item.active ? "active" : remaining > 0 ? "paused" : "finished";
        flag(4, "DOUBLE", `installment plan "${item.name}" (${state}) makes ${makes} payments; it was created with ${createdWith}`, [
          `counted: ${postedKeys.size} posted row${postedKeys.size === 1 ? "" : "s"}, ${claimedKeys.size} claimed pairing${claimedKeys.size === 1 ? "" : "s"}; ${remaining} left from ${toISODate(item.nextDate)}`,
          ...stranded.map(
            (row) => `recorded payment never counted: RecurringSettlement ${row.id} (due ${toISODate(row.dueDate)}, Transaction ${row.transactionId}) is not claimed and posting will not reach it`,
          ),
        ]);
      }
    }

    const written = await prisma.$queryRaw<{ source: string; currency: string; n: number }[]>`
      SELECT source::text AS source, currency, count(*)::int AS n FROM "Transaction"
      WHERE (source = 'RECURRING' AND type = 'EXPENSE') OR (source = 'PAYDAY_CHECKIN' AND type = 'INCOME')
      GROUP BY 1, 2 ORDER BY 1, 2`;
    info(`settled and posted: ${settledAndPosted} of ${settlements.length} settlement${settlements.length === 1 ? "" : "s"} name an occurrence that also has a RECURRING row`);
    info(`installment plans: ${plansChecked} checked for more payments than they were created with`);
    info(`slots: ${slotsChecked} consumed occurrence${slotsChecked === 1 ? "" : "s"} of ${byItem.size} item${byItem.size === 1 ? "" : "s"} checked for one slot paid twice`);
    info(`paychecks: ${paychecksChecked} confirmed check-in paycheck${paychecksChecked === 1 ? "" : "s"} checked against the deposits the ledger held for them when confirmed (${recordedAdoptions.size} that recorded their deposits are checked in pair 5)`);
    info(
      `existing pairs: ${doubles + possibles} (${doubles} double, ${possibles} possible) from ${candidates.length} candidate pair${candidates.length === 1 ? "" : "s"} against ${written.map((group) => `${group.n} ${group.source} ${group.currency}`).join(", ") || "no written rows"}`,
    );
    sectionResult(4);
  }

  // =========================================================================
  console.log("\n== pair 5: an earmarked deposit vs the occurrence it covers ==");
  // =========================================================================
  {
    const { loadPeriodIncome } = await import("../src/lib/data/period-income");
    const { incomePeriodFor } = await import("../src/lib/period-income");

    const earmarks = await prisma.recurringEarmark.findMany({
      select: {
        transactionId: true,
        occurrenceKey: true,
        dueDate: true,
        amount: true,
        currency: true,
        transaction: {
          select: {
            id: true,
            date: true,
            amount: true,
            currency: true,
            type: true,
            source: true,
            transferDirection: true,
            accountId: true,
            note: true,
            isOneOffIncome: true,
            reimbursesTransactionId: true,
          },
        },
      },
    });
    const deposits = new Map(earmarks.map((earmark) => [earmark.transactionId, earmark.transaction]));
    const describe = (deposit: (typeof earmarks)[number]["transaction"]) =>
      `Transaction ${deposit.id} (${deposit.source} ${deposit.type.toLowerCase()}${deposit.transferDirection ? ` ${deposit.transferDirection}` : ""}, ${toISODate(deposit.date)}) ${money(num(deposit.amount), deposit.currency)}${deposit.note ? ` "${deposit.note}"` : ""}`;
    const storedIn = (earmark: (typeof earmarks)[number], currency: string) => convert(num(earmark.amount), earmark.currency, currency, rates);

    // A deposit that can be set aside at all: ordinary income or an
    // incoming external transfer. A check-in's paycheck is the plan's income
    // already; earmarking it lowers the occurrence while the check-in still
    // counts the same money.
    for (const deposit of deposits.values()) {
      const own = earmarks.filter((earmark) => earmark.transactionId === deposit.id);
      if (deposit.source === "PAYDAY_CHECKIN") {
        flag(5, "DOUBLE", `a check-in's paycheck ${deposit.id} is earmarked for a recurring payment`, [
          `deposit:   ${describe(deposit)}`,
          ...own.map((earmark) => `earmarked: ${money(num(earmark.amount), earmark.currency)} for ${earmark.occurrenceKey}`),
          "the check-in counts this paycheck as the plan's income, and the occurrence asks less of the same plan",
        ]);
      } else if (
        !(deposit.type === "INCOME" || (deposit.type === "EXTERNAL_TRANSFER" && deposit.transferDirection === "IN")) ||
        deposit.source === "OPENING_BALANCE" ||
        deposit.source === "RECURRING"
      ) {
        flag(5, "MISMATCH", `${deposit.id} is earmarked but is not a deposit`, [`row: ${describe(deposit)}`]);
      }
      const stored = own.reduce((sum, earmark) => sum + storedIn(earmark, deposit.currency), 0);
      if (stored > num(deposit.amount) + 0.005) {
        flag(5, "MISMATCH", `the earmarks stored for ${deposit.id} add up to more than the deposit`, [
          `deposit:   ${describe(deposit)}`,
          `earmarked: ${money(stored, deposit.currency)} over ${own.length} occurrence${own.length === 1 ? "" : "s"} (the readers apply at most the deposit)`,
        ]);
      }
    }

    // What the period commitments apply: never more than an occurrence
    // costs, never below zero, never more of a deposit than it holds.
    const periods = new Map<string, PeriodInfo>([[context.currentPeriod.key, context.currentPeriod]]);
    for (const earmark of earmarks) {
      const period = periodForDate(earmark.dueDate);
      periods.set(period.key, period);
    }
    const commitments = earmarks.length > 0 ? await loadCommitments([...periods.values()], context) : new Map();
    const appliedByDeposit = new Map<string, number>();
    const appliedKeys = new Set<string>();
    let covered = 0;
    for (const occurrence of [...commitments.values()].flat()) {
      if (occurrence.earmarks.length === 0) continue;
      covered += 1;
      appliedKeys.add(occurrence.key);
      const cost = wholeAmount(occurrence);
      if (occurrence.earmarked > occurrence.amount + 0.005 || cost < 0 || !sameCents(cost, Math.max(0, occurrence.amount - occurrence.earmarked))) {
        flag(5, "DOUBLE", `occurrence ${occurrence.key} (${occurrence.name}) is covered beyond what it costs`, [
          `occurrence: ${money(occurrence.amount, occurrence.currency)} (${occurrence.status})`,
          `covered:    ${money(occurrence.earmarked, occurrence.currency)}; asks ${money(cost, occurrence.currency)}`,
        ]);
      }
      for (const part of occurrence.earmarks) {
        const deposit = deposits.get(part.transactionId);
        const inDeposit = deposit ? convert(part.amount, part.currency, deposit.currency, rates) : part.amount;
        appliedByDeposit.set(part.transactionId, (appliedByDeposit.get(part.transactionId) ?? 0) + inDeposit);
      }
    }
    for (const [depositId, applied] of appliedByDeposit) {
      const deposit = deposits.get(depositId);
      if (deposit && applied > num(deposit.amount) + 0.01) {
        flag(5, "DOUBLE", `deposit ${depositId} lowers its occurrences by more than it holds`, [
          `deposit: ${describe(deposit)}`,
          `applied: ${money(applied, deposit.currency)} across the occurrences it covers`,
        ]);
      }
    }

    // Income: what an earmarked deposit covers is not estimated income - and
    // only that (R23): the part that still lowers an occurrence, as the
    // period commitments just applied it, not what was stored when the
    // occurrence cost more or was still due. For every period and account an
    // earmarked INCOME row counts in, the fact must exceed the estimate by
    // at least the applied parts of the rows the estimate would otherwise
    // read (one-off income and paybacks are out of it already), and - where
    // nothing else separates the two figures - by no more.
    const incomeRows = [...deposits.values()].filter((deposit) => deposit.type === "INCOME" && deposit.source !== "PAYDAY_CHECKIN");
    const required = new Map<string, number>();
    const storedPart = new Map<string, number>();
    const incomePeriods = new Map<string, PeriodInfo>();
    for (const row of incomeRows) {
      if (row.isOneOffIncome || row.reimbursesTransactionId !== null) continue;
      const period = incomePeriodFor(row);
      incomePeriods.set(period.key, period);
      const earmarked = earmarks
        .filter((earmark) => earmark.transactionId === row.id)
        .reduce((sum, earmark) => sum + storedIn(earmark, row.currency), 0);
      const account = await prisma.account.findUnique({ where: { id: row.accountId }, select: { currency: true } });
      const inAccount = (amount: number) => convert(amount, row.currency, account?.currency ?? row.currency, rates);
      const key = `${period.key}|${row.accountId}`;
      required.set(key, (required.get(key) ?? 0) + inAccount(Math.min(num(row.amount), appliedByDeposit.get(row.id) ?? 0)));
      storedPart.set(key, (storedPart.get(key) ?? 0) + inAccount(Math.min(num(row.amount), earmarked)));
    }
    if (required.size > 0) {
      const [fact, estimate] = await Promise.all([
        loadPeriodIncome([...incomePeriods.values()], "fact", context),
        loadPeriodIncome([...incomePeriods.values()], "estimate", context),
      ]);
      for (const [key, part] of required) {
        const [periodKey, accountId] = key.split("|");
        const factAmount = fact.get(periodKey)?.byAccount.get(accountId) ?? 0;
        const estimateAmount = estimate.get(periodKey)?.byAccount.get(accountId) ?? 0;
        if (factAmount - estimateAmount + 0.01 < part) {
          flag(5, "DOUBLE", `earmarked income counted as estimated income in ${periodKey} on account ${accountId}`, [
            `income fact ${round2(factAmount).toFixed(2)}, estimate ${round2(estimateAmount).toFixed(2)} (account currency)`,
            `earmarked parts that lower their occurrences: ${round2(part).toFixed(2)} - the estimate must leave at least that out`,
          ]);
        }
        // The other way: an earmark whose occurrence shrank or went away
        // still kept out of the estimate. Judged only where earmarks are all
        // that separate fact from estimate - no one-off or payback row, no
        // check-in paycheck with a one-off part.
        const stored = storedPart.get(key) ?? 0;
        if (stored > part + 0.01) {
          const period = incomePeriods.get(periodKey)!;
          const [otherRows, oneOffSnapshots] = await Promise.all([
            prisma.transaction.count({
              where: {
                accountId,
                type: "INCOME",
                OR: [{ isOneOffIncome: true }, { reimbursesTransactionId: { not: null } }],
                date: { gte: addDays(period.start, -16), lte: period.end },
              },
            }),
            prisma.paydayAccountSnapshot.count({
              where: { accountId, oneOffIncome: { gt: 0 }, checkin: { status: "CONFIRMED", year: period.year, month: period.month, period: period.period } },
            }),
          ]);
          if (otherRows === 0 && oneOffSnapshots === 0 && factAmount - estimateAmount > part + 0.01) {
            flag(5, "DROP", `the estimate in ${periodKey} on account ${accountId} leaves out earmarked money no occurrence takes any more`, [
              `income fact ${round2(factAmount).toFixed(2)}, estimate ${round2(estimateAmount).toFixed(2)} (account currency)`,
              `earmarked as stored ${round2(stored).toFixed(2)}, still covering an occurrence ${round2(part).toFixed(2)} - the rest is income again`,
            ]);
          }
        }
      }
    }
    // The check-in's side: Step 2 lists each ordinary deposit in its income
    // window as pay, less what of it lowers a payment, and confirm adopts
    // that (loadLedgerDeposits). What it lists plus what the commitments
    // apply must be the whole deposit: less, and part of it is counted in
    // neither place - not lowering any payment, not the plan's pay (an
    // earmark whose payment shrank or was paused, still subtracted as
    // stored); more, and part is counted in both.
    const { loadLedgerDeposits } = await import("../src/lib/data/period-income");
    const listedByPeriod = new Map<string, Awaited<ReturnType<typeof loadLedgerDeposits>>>();
    let depositsChecked = 0;
    for (const row of incomeRows) {
      if (row.isOneOffIncome || row.reimbursesTransactionId !== null) continue;
      const period = incomePeriodFor(row);
      if (!listedByPeriod.has(period.key)) listedByPeriod.set(period.key, await loadLedgerDeposits(period, context));
      const account = await prisma.account.findUnique({ where: { id: row.accountId }, select: { currency: true } });
      const accountCurrency = account?.currency ?? row.currency;
      const whole = convert(num(row.amount), row.currency, accountCurrency, rates);
      const applied = Math.min(whole, convert(appliedByDeposit.get(row.id) ?? 0, row.currency, accountCurrency, rates));
      const listed = listedByPeriod.get(period.key)?.byAccount.get(row.accountId)?.find((deposit) => deposit.transactionId === row.id)?.amount ?? 0;
      depositsChecked += 1;
      const gap = round2(whole - applied - listed);
      if (Math.abs(gap) <= 0.01) continue;
      flag(5, gap > 0 ? "DROP" : "DOUBLE", `deposit ${row.id} is ${gap > 0 ? "counted in neither place" : "counted twice"} for ${round2(Math.abs(gap)).toFixed(2)} ${accountCurrency}`, [
        `deposit:  ${describe(row)}`,
        `lowers its payments by ${round2(applied).toFixed(2)} (the period commitments); listed as ${period.key}'s pay ${round2(listed).toFixed(2)} (Step 2, what confirm adopts)`,
        gap > 0 ? "the rest lowers no payment and is not the plan's pay" : "part of it both lowers a payment and is the plan's pay",
      ]);
    }
    // The plan's side (S7, S18): a confirmed paycheck that recorded the
    // deposits it adopted counts, in the confirmed room's income for its
    // account, its own row (incomeEntered - adoptedIncome, the PAYDAY_CHECKIN
    // row it wrote) plus each of those deposits less what the period
    // commitments apply of its earmarks - however they changed since the
    // confirm, and whatever a re-confirm adopted since. Computed here from
    // the rows: a deposit still counts while it exists on that account as
    // ordinary income dated in the period's income window (five days before
    // the period's first day to five days before the next one's). More in
    // the room than that is money counted both as the plan's pay and as a
    // payment's cover (or a deposit that is gone, still counted); less is
    // pay counted nowhere.
    const recordedPaychecks = await prisma.$queryRaw<
      { id: string; accountId: string; currency: string; incomeEntered: string; adoptedIncome: string | null; ids: string[]; incomeTransactionId: string | null; year: number; month: number; period: string }[]
    >`
      SELECT s.id, s."accountId", s.currency, s."incomeEntered"::text AS "incomeEntered", s."adoptedIncome"::text AS "adoptedIncome",
             s."adoptedTransactionIds" AS ids, s."incomeTransactionId", c.year, c.month, c.period::text AS period
      FROM "PaydayAccountSnapshot" s JOIN "PaydayCheckin" c ON c.id = s."paydayCheckinId"
      WHERE c.status = 'CONFIRMED' AND cardinality(coalesce(s."adoptedTransactionIds", ARRAY[]::text[])) > 0`;
    let paychecksFollowed = 0;
    if (recordedPaychecks.length > 0) {
      const { loadConfirmedRooms } = await import("../src/lib/data/flexible-room");
      const refs = new Map(recordedPaychecks.map((row) => [`${row.year}-${row.month}-${row.period}`, { year: row.year, month: row.month, period: row.period as "A" | "B" }]));
      const rooms = await loadConfirmedRooms([...refs.values()], context);
      for (const snapshot of recordedPaychecks) {
        const ref = refs.get(`${snapshot.year}-${snapshot.month}-${snapshot.period}`)!;
        const key = `${ref.year}-${String(ref.month).padStart(2, "0")}-${ref.period}`;
        const own = round2(Number(snapshot.incomeEntered) - Number(snapshot.adoptedIncome ?? 0));
        const ownRow = snapshot.incomeTransactionId
          ? await prisma.transaction.findUnique({ where: { id: snapshot.incomeTransactionId }, select: { amount: true, source: true } })
          : null;
        const rowAmount = ownRow ? num(ownRow.amount) : 0;
        if (Math.abs(rowAmount - Math.max(0, own)) > 0.01) {
          flag(5, rowAmount > own ? "DOUBLE" : "DROP", `check-in ${key}'s own paycheck row on account ${snapshot.accountId} is not the part beyond the deposits it adopted`, [
            `paycheck ${Number(snapshot.incomeEntered).toFixed(2)}, adopted ${Number(snapshot.adoptedIncome ?? 0).toFixed(2)}: its own row should hold ${Math.max(0, own).toFixed(2)}`,
            `its own row (${snapshot.incomeTransactionId ?? "none"}) holds ${rowAmount.toFixed(2)}`,
          ]);
        }
        const from = addDays(civilDate(ref.year, ref.month, ref.period === "A" ? 1 : 16), -5);
        const until = addDays(ref.period === "A" ? civilDate(ref.year, ref.month, 16) : ref.month === 12 ? civilDate(ref.year + 1, 1, 1) : civilDate(ref.year, ref.month + 1, 1), -5);
        const adopted = await prisma.transaction.findMany({
          where: { id: { in: snapshot.ids } },
          select: { id: true, accountId: true, type: true, source: true, isOneOffIncome: true, reimbursesTransactionId: true, date: true, amount: true, currency: true },
        });
        const parts = adopted
          .filter(
            (row) =>
              row.accountId === snapshot.accountId &&
              row.type === "INCOME" &&
              row.source !== "PAYDAY_CHECKIN" &&
              !row.isOneOffIncome &&
              row.reimbursesTransactionId === null &&
              row.date.getTime() >= from.getTime() &&
              row.date.getTime() < until.getTime(),
          )
          .map((row) => {
            const whole = convert(num(row.amount), row.currency, snapshot.currency, rates);
            const cover = Math.min(whole, convert(appliedByDeposit.get(row.id) ?? 0, row.currency, snapshot.currency, rates));
            return { row, whole, cover, pay: round2(whole - cover) };
          });
        const expected = round2(own + parts.reduce((sum, part) => sum + part.pay, 0));
        const counted = rooms.get(key)?.accounts.find((account) => account.accountId === snapshot.accountId)?.income ?? 0;
        paychecksFollowed += 1;
        if (Math.abs(counted - expected) <= 0.01) continue;
        flag(5, counted > expected ? "DOUBLE" : "DROP", `check-in ${key} counts ${round2(Math.abs(counted - expected)).toFixed(2)} ${counted > expected ? "more" : "less"} pay on account ${snapshot.accountId} than its own row and the deposits it adopted hold`, [
          `confirmed room income for the account: ${round2(counted).toFixed(2)} ${snapshot.currency}`,
          `own row ${own.toFixed(2)} + adopted deposits less their applied cover ${round2(expected - own).toFixed(2)} = ${expected.toFixed(2)}`,
          ...parts.map((part) => `adopted: Transaction ${part.row.id} (${toISODate(part.row.date)}) ${part.whole.toFixed(2)}, of it covering payments ${round2(part.cover).toFixed(2)}`),
          ...snapshot.ids.filter((id) => !parts.some((part) => part.row.id === id)).map((id) => `adopted: Transaction ${id} - gone, or no longer ordinary income in the window on that account: counts 0`),
          counted > expected ? "part of it is counted both as the plan's pay and as a payment's cover, or a deposit no longer there still counts" : "part of the adopted pay is counted nowhere",
        ]);
      }
    }

    const unapplied = [...new Set(earmarks.map((earmark) => earmark.occurrenceKey))].filter((key) => !appliedKeys.has(key));
    info(
      `earmarks: ${earmarks.length} on ${deposits.size} deposit${deposits.size === 1 ? "" : "s"}; ${covered} occurrence${covered === 1 ? "" : "s"} covered in the period commitments${unapplied.length ? `; ${unapplied.length} not applied (posting skips the item, or the item is gone): ${unapplied.join(", ")}` : ""}; ${required.size} period/account income figure${required.size === 1 ? "" : "s"} checked; ${depositsChecked} deposit${depositsChecked === 1 ? "" : "s"} checked against what Step 2 lists; ${paychecksFollowed} paycheck${paychecksFollowed === 1 ? "" : "s"} that recorded their deposits checked against the confirmed room`,
    );
    sectionResult(5);
  }

  // =========================================================================
  console.log("\n== summary ==");
  if (findings.length === 0) {
    console.log("  clean: no double-counted or dropped commitment found in any of the five pairs");
    return 0;
  }
  for (const pair of [1, 2, 3, 4, 5] as const) {
    const own = findings.filter((finding) => finding.pair === pair);
    if (own.length === 0) continue;
    console.log(`  pair ${pair}: ${own.length} finding${own.length === 1 ? "" : "s"}`);
    for (const finding of own) console.log(`    ${finding.kind.padEnd(8)} ${finding.title}`);
  }
  return 1;
}

async function run(): Promise<number> {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const established = await connectReadOnly(rawUrl);
  if (!established) {
    console.error(`refusing to run: could not confirm a read-only transaction on this connection`);
    return 2;
  }
  prisma = established.prisma;
  (globalThis as { prisma?: unknown }).prisma = prisma;
  return main();
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
  });
