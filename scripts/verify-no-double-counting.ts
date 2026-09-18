/**
 * Standing double-counting integrity audit.
 *
 * Three pairs of mechanisms in this codebase could, in principle, count the
 * same financial commitment twice (or, just as bad, drop it). Each was fixed
 * as a one-off in the past; this script checks all three against whatever
 * data it is pointed at, by computing each side of every pair independently
 * from the raw rows and comparing it with what the app's own readers report:
 *
 *   pair 1  a GoalContribution and the Transaction paired with it - a manual
 *           row's twin (source MANUAL, externalId "goal-contribution:<id>",
 *           see logManualContribution in src/lib/goals.ts) or an auto-posted
 *           row's twin (source RECURRING, the same "<itemId>:<date>" key on
 *           both rows). The contribution counts as saving; the twin must never
 *           also count as spending (monthly pace, src/lib/data/monthly.ts;
 *           period budget "spent", src/lib/data/period-summary.ts), and a twin
 *           whose contribution is gone must not vanish from both.
 *   pair 2  a SEMI_MONTHLY RecurringItem's two monthly anchors. Every reader
 *           that walks a schedule (owedOccurrences / advanceDate in
 *           src/lib/recurring.ts) must see both realizations each month, and
 *           each real occurrence must reach the ledger exactly once - not
 *           once through posting and again through a hand-logged charge, and
 *           not through two items covering the same bill.
 *   pair 3  the Afford calculator's goal-funding estimate for a period with no
 *           confirmed check-in versus the real GOAL allocation rows of a
 *           period that has one (projectPeriods in src/lib/data/afford.ts):
 *           a confirmed period's commitments must decompose exactly into
 *           scheduled occurrences plus its GOAL rows, with no estimate on
 *           top, and an unconfirmed period's into schedule plus estimate,
 *           with nothing leaking in from a DRAFT check-in.
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
  maxDate,
  today as appToday,
  toISODate,
} from "../src/lib/date";
import { num, round2 } from "../src/lib/money";
import { monthForDate } from "../src/lib/month";
import { planGoalFunding } from "../src/lib/payday";
import {
  nextPeriod,
  payDayOfMonth,
  periodForDate,
  periodInfo,
  periodRange,
  type PeriodInfo,
  type PeriodRef,
} from "../src/lib/period";
import { monthlyEquivalent, owedOccurrences, type ScheduledItem } from "../src/lib/recurring";
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

type FindingKind = "DOUBLE" | "DROP" | "MISMATCH";
interface Finding {
  pair: 1 | 2 | 3;
  kind: FindingKind;
  title: string;
  evidence: string[];
}

const findings: Finding[] = [];

function flag(pair: 1 | 2 | 3, kind: FindingKind, title: string, evidence: string[]) {
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

function sectionResult(pair: 1 | 2 | 3) {
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
  const walkers = /\b(owedOccurrences|advanceDate|remainingInstallments)\s*\(/;
  const offenders: string[] = [];
  const files: string[] = [];
  let scanned = 0;
  for (const file of listSourceFiles(root)) {
    if (file.endsWith("lib/recurring.ts") || file.endsWith("lib/afford-tracking.ts")) continue;
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

  const categories = await prisma.category.findMany({
    select: { id: true, name: true, isSavingsDefault: true, isSubscriptionDefault: true },
  });
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const outsideBudget = (categoryId: string | null) => {
    const category = categoryId ? categoryById.get(categoryId) : undefined;
    return Boolean(category && (category.isSavingsDefault || category.isSubscriptionDefault));
  };
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
      },
    });
    const manualTwinByKey = new Map(twins.filter((tx) => tx.source === "MANUAL").map((tx) => [tx.externalId as string, tx]));
    const recurringTwinByKey = new Map(twins.filter((tx) => tx.source === "RECURRING").map((tx) => [tx.externalId as string, tx]));
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
    const periodsWithTwins = new Map<string, PeriodInfo>();
    for (const { twin } of manualPairs) periodsWithTwins.set(periodForDate(twin.date).key, periodForDate(twin.date));
    for (const [key, period] of [...periodsWithTwins.entries()].sort()) {
      const [summary, expenses] = await Promise.all([
        getPeriodSummary(period, context as AppContext),
        prisma.transaction.findMany({
          where: { date: periodRange(period), type: "EXPENSE" },
          select: { id: true, amount: true, currency: true, source: true, categoryId: true, externalId: true },
        }),
      ]);
      const twinIds = new Set(manualPairs.map(({ twin }) => twin.id));
      let spentWithoutTwins = 0;
      const twinsInsideByRule: { id: string; amount: number }[] = [];
      for (const tx of expenses) {
        if (tx.source === "RECURRING" || outsideBudget(tx.categoryId)) continue;
        const amount = toDisplay(num(tx.amount), tx.currency);
        if (twinIds.has(tx.id)) twinsInsideByRule.push({ id: tx.id, amount });
        else spentWithoutTwins += amount;
      }
      spentWithoutTwins = round2(spentWithoutTwins);
      const leaked = round2(summary.spent - spentWithoutTwins);
      if (Math.abs(leaked) < 0.01) continue;
      const ruleTotal = round2(twinsInsideByRule.reduce((sum, row) => sum + row.amount, 0));
      if (sameCents(leaked, ruleTotal)) {
        for (const inside of twinsInsideByRule) {
          const pair = manualPairs.find(({ twin }) => twin.id === inside.id)!;
          flag(1, "DOUBLE", `getPeriodSummary(${key}).spent counts goal "${pair.contribution.goal.name}"'s contribution twin as budget spending`, [
            `saving side:   GoalContribution ${pair.contribution.id} (${toISODate(pair.contribution.date)}) ${money(num(pair.contribution.amount), pair.contribution.currency)} - the plan set this aside as goal funding`,
            `spending side: Transaction ${pair.twin.id} (${toISODate(pair.twin.date)}) ${money(num(pair.twin.amount), pair.twin.currency)}, category ${categoryName(pair.twin.categoryId)} -> counted in spent (${money(inside.amount, displayCurrency)})`,
            `the period budget excludes a twin only through its category (isSavingsDefault / isSubscriptionDefault); this twin's category is neither`,
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
          const candidates = await prisma.transaction.findMany({
            where: { type: "EXPENSE", accountId: item.accountId, source: { not: "RECURRING" }, date: periodRange(period) },
            select: { id: true, date: true, amount: true, currency: true, categoryId: true, note: true },
          });
          const matched = matchRecurringToTransactions(
            [{ id: item.id, name: item.name, amount: num(item.amount), currency: item.currency, categoryId: item.categoryId, kind: item.kind, frequency: item.frequency, nextDate: item.nextDate }],
            candidates.map((tx) => ({ id: tx.id, amount: num(tx.amount), currency: tx.currency, categoryId: tx.categoryId, note: tx.note })),
          );
          const manual = candidates.filter((tx) => matched.matchedTransactionIds.has(tx.id));
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
      if (item.active && !degraded && (item.kind !== "CONTRIBUTION" || !item.goal?.achievedAt)) {
        for (const period of livePeriods) {
          const owedFrom = maxDate(today, period.start);
          const expected = independentOwed(shape, owedFrom, period.end).length;
          const live = liveSummaries.get(period.key)?.committedItems.find((row) => row.id === item.id)?.occurrenceCount ?? 0;
          if (live !== expected) {
            flag(2, live < expected ? "DROP" : "DOUBLE", `${label}: getPeriodSummary(${period.key}) owes ${live} occurrence${live === 1 ? "" : "s"}, the anchors say ${expected}`, [
              `independent: ${isoList(independentOwed(shape, owedFrom, period.end))}`,
              `the committed figure, the payday check-in's subscription rows and the goal roadmap all read this count`,
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
          for (const due of independentOwed(shape, today, horizonEnd)) {
            const key = due.getTime() < today.getTime() ? context.currentPeriod.key : periodForDate(due).key;
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
                `measured as projectPeriods with and without excludeItemId, net of the goal estimate (loadScheduledCommitments in src/lib/data/afford.ts)`,
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
      const horizonEnd = periods[periods.length - 1].end;

      // Independent scheduled commitments per period: the same walk Afford
      // documents (every active item due by the horizon, an achieved goal's
      // contribution left out, an overdue date filed under the current period).
      const scheduledTotal = new Map<string, number>();
      const scheduledByAccount = new Map<string, Map<string, number>>();
      for (const item of allItems) {
        if (!item.active || item.nextDate.getTime() > horizonEnd.getTime()) continue;
        if (item.kind === "CONTRIBUTION" && item.goal?.achievedAt) continue;
        for (const due of owedOccurrences(item, today, horizonEnd)) {
          const key = due.getTime() < today.getTime() ? context.currentPeriod.key : periodForDate(due).key;
          if (!refsByKey.has(key)) continue;
          scheduledTotal.set(key, (scheduledTotal.get(key) ?? 0) + toDisplay(num(item.amount), item.currency));
          const account = item.accountId ? activeAccounts.find((candidate) => candidate.id === item.accountId) : undefined;
          if (account) {
            const byAccount = scheduledByAccount.get(key) ?? new Map<string, number>();
            byAccount.set(account.id, (byAccount.get(account.id) ?? 0) + convert(num(item.amount), item.currency, account.currency, rates));
            scheduledByAccount.set(key, byAccount);
          }
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
            `schedule (owedOccurrences over active items): ${money(scheduled, displayCurrency)}; confirmed GOAL rows: ${money(goalRowsTotal, displayCurrency)}; estimate: ${money(estimate, displayCurrency)}; unexplained: ${money(residual, displayCurrency)}${draftHint}`,
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
    sectionResult(3);
  }

  // =========================================================================
  console.log("\n== summary ==");
  if (findings.length === 0) {
    console.log("  clean: no double-counted or dropped commitment found in any of the three pairs");
    return 0;
  }
  for (const pair of [1, 2, 3] as const) {
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
