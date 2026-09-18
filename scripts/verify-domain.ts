/**
 * Domain checks for the rules in the README: pay periods, safe to spend,
 * transfers, currency conversion through USD, CSV parsing and goal caching.
 *
 *   DATABASE_URL="postgres://.../scratch_db" npx tsx scripts/verify-domain.ts
 *
 * It writes a handful of rows and deletes them again, so point it at a scratch
 * database rather than one holding real data.
 */
import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  BPD_RATE_MAX_AGE_DAYS,
  BPD_SOURCE,
  fetchBpdRates,
  isSameUtcDay,
  parseBpdPayload,
  toRateTableEntries,
} from "../src/lib/bpd-rates";
import { convert, type RateTable } from "../src/lib/currency";
import { getRateTable } from "../src/lib/rates";
import {
  DATE_FORMATS,
  parseAmount,
  parseCsv,
  parseDateWithFormat,
} from "../src/lib/csv";
import {
  addDays,
  appTimeZone,
  civilDate,
  civilDateInZone,
  daysBetween,
  daysInMonth,
  DEFAULT_APP_TIMEZONE,
  formatDate,
  toISODate,
} from "../src/lib/date";
import {
  daysRemainingInPeriod,
  isPaydayDate,
  paydayDateFor,
  periodForDate,
  periodInfo,
  periodKey,
  periodRange,
  periodsRemaining,
  periodSeries,
  previousComparablePeriod,
  previousPeriod,
} from "../src/lib/period";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  planAccountBuffers,
  planGoalFunding,
  recommendGoalFunding,
  resolveFlexibleCategories,
  resolveGoalFunding,
  scaleFlexibleSuggestions,
  suggestCoverShortfall,
  summarizePaydayDraft,
} from "../src/lib/payday";
import { advanceDate, monthlyEquivalent, owedOccurrences } from "../src/lib/recurring";
import {
  EXPLICIT_NO_CATEGORY,
  resolveImportCategoryId,
  suggestCategoryName,
} from "../src/lib/categorization";
import {
  buildRowCategoryOverrides,
  buildTransferPrefill,
  detectImportGroups,
  type GroupableRow,
  type RowCategoryDecision,
} from "../src/lib/import-grouping";
import { num, round2 } from "../src/lib/money";
import {
  compareDebtStrategies,
  MAX_DEBT_PERIODS,
  MIN_DEBTS_TO_COMPARE,
  orderDebts,
  simulateDebtPayoff,
  type DebtInput,
  type DebtPayoffResult,
} from "../src/lib/debt-payoff";
import { gmailRedirectUri } from "../src/lib/oauth/google";
import type { AffordInput } from "../src/lib/data/afford";
import type { NextRequest } from "next/server";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected) || actual === expected, `got ${String(actual)}, expected ${String(expected)}`);
}

async function main() {
  console.log("\n== APP_TIMEZONE / business date ==");
  const SD = "America/Santo_Domingo";
  eq(
    "9pm Aug 31 in Santo Domingo is still Aug 31",
    toISODate(civilDateInZone(new Date("2026-09-01T01:00:00.000Z"), SD)),
    "2026-08-31",
  );
  eq(
    "midnight Santo Domingo rolls the business date to Sep 1",
    toISODate(civilDateInZone(new Date("2026-09-01T04:00:00.000Z"), SD)),
    "2026-09-01",
  );
  eq(
    "23:59 local on the 14th is still period A (Aug 14)",
    toISODate(civilDateInZone(new Date("2026-08-15T03:59:00.000Z"), SD)),
    "2026-08-14",
  );
  eq(
    "local midnight on the 15th starts period A's last day",
    periodForDate(civilDateInZone(new Date("2026-08-15T04:00:00.000Z"), SD)).period,
    "A",
  );
  eq(
    "23:59 local on the 15th is still period A",
    periodForDate(civilDateInZone(new Date("2026-08-16T03:59:00.000Z"), SD)).period,
    "A",
  );
  eq(
    "local midnight on the 16th rolls into period B",
    periodForDate(civilDateInZone(new Date("2026-08-16T04:00:00.000Z"), SD)).period,
    "B",
  );
  eq(
    "a stored civil date for Aug 31 renders as Aug 31",
    formatDate(civilDate(2026, 8, 31)),
    "Aug 31, 2026",
  );

  const savedAppTimezone = process.env.APP_TIMEZONE;
  delete process.env.APP_TIMEZONE;
  eq("APP_TIMEZONE missing falls back to America/Santo_Domingo", appTimeZone(), DEFAULT_APP_TIMEZONE);
  process.env.APP_TIMEZONE = "Not/A_Real_Zone";
  eq("APP_TIMEZONE invalid falls back to America/Santo_Domingo", appTimeZone(), DEFAULT_APP_TIMEZONE);
  process.env.APP_TIMEZONE = "America/Santo_Domingo";
  eq("APP_TIMEZONE valid is used as-is", appTimeZone(), "America/Santo_Domingo");
  if (savedAppTimezone === undefined) delete process.env.APP_TIMEZONE;
  else process.env.APP_TIMEZONE = savedAppTimezone;

  console.log("\n== pay periods ==");
  const aug15 = periodForDate(civilDate(2026, 8, 15));
  eq("Aug 15 is period A", aug15.period, "A");
  eq("A starts on the 1st", toISODate(aug15.start), "2026-08-01");
  eq("A ends on the 15th", toISODate(aug15.end), "2026-08-15");
  const aug16 = periodForDate(civilDate(2026, 8, 16));
  eq("Aug 16 is period B", aug16.period, "B");
  eq("B ends on the 31st", toISODate(aug16.end), "2026-08-31");
  eq("B label", aug16.label, "Aug 16-31");
  eq("Feb 2026 B ends on the 28th", toISODate(periodForDate(civilDate(2026, 2, 20)).end), "2026-02-28");
  eq("Feb 2024 B ends on the 29th", toISODate(periodForDate(civilDate(2024, 2, 20)).end), "2024-02-29");
  eq("Apr B ends on the 30th", toISODate(periodForDate(civilDate(2026, 4, 30)).end), "2026-04-30");
  eq("days left on the last day", daysRemainingInPeriod(civilDate(2026, 8, 31)), 1);
  eq("days left on the 16th", daysRemainingInPeriod(civilDate(2026, 8, 16)), 16);
  eq("days left mid period A", daysRemainingInPeriod(civilDate(2026, 8, 10)), 6);
  eq("periods until year end", periodsRemaining(civilDate(2026, 8, 16), civilDate(2026, 12, 31)), 9);
  eq("target inside the current period", periodsRemaining(civilDate(2026, 8, 20), civilDate(2026, 8, 25)), 0);
  const series = periodSeries(periodForDate(civilDate(2026, 1, 20)), 3);
  eq("series spans a year boundary", series.map((p) => p.key).join(","), "2025-12-B,2026-01-A,2026-01-B");

  console.log("\n== recurring advancement ==");
  eq("monthly clamps to month end", toISODate(advanceDate(civilDate(2026, 1, 31), "MONTHLY")), "2026-02-28");
  eq("biweekly adds 14 days", toISODate(advanceDate(civilDate(2026, 8, 20), "BIWEEKLY")), "2026-09-03");
  eq("yearly adds a year", toISODate(advanceDate(civilDate(2026, 8, 20), "YEARLY")), "2027-08-20");

  console.log("\n== recurring advancement: SEMI_MONTHLY ==");
  {
    // Aug 1 2026 is a Saturday -> shifts back to Jul 31 (crossing months).
    // Aug 16 2026 is a Sunday -> shifts back to Aug 14.
    eq(
      "same month, no shift: Jul 1 -> Jul 16",
      toISODate(advanceDate(civilDate(2026, 7, 1), "SEMI_MONTHLY", 1, 16)),
      "2026-07-16",
    );
    eq(
      "the next slot (Aug 1) shifts back into the *previous* month: Jul 16 -> Jul 31",
      toISODate(advanceDate(civilDate(2026, 7, 16), "SEMI_MONTHLY", 1, 16)),
      "2026-07-31",
    );
    eq(
      "from a shifted occurrence, the next is the *other* anchor's slot (Aug 16 -> Aug 14), not the same one again",
      toISODate(advanceDate(civilDate(2026, 7, 31), "SEMI_MONTHLY", 1, 16)),
      "2026-08-14",
    );
    eq(
      "and from there, back to the first anchor with no shift: Aug 14 -> Sep 1",
      toISODate(advanceDate(civilDate(2026, 8, 14), "SEMI_MONTHLY", 1, 16)),
      "2026-09-01",
    );
    eq(
      "the two anchors are interchangeable - passing them in the other order behaves identically",
      toISODate(advanceDate(civilDate(2026, 7, 16), "SEMI_MONTHLY", 16, 1)),
      "2026-07-31",
    );
    eq(
      "anchored on the 15th and the last day of the month (anchor 31, clamped) - the app's own paydays",
      [
        toISODate(advanceDate(civilDate(2026, 6, 15), "SEMI_MONTHLY", 15, 31)),
        toISODate(advanceDate(civilDate(2026, 6, 30), "SEMI_MONTHLY", 15, 31)),
        toISODate(advanceDate(civilDate(2026, 7, 15), "SEMI_MONTHLY", 15, 31)),
      ].join(","),
      "2026-06-30,2026-07-15,2026-07-31",
    );
    eq(
      "no secondAnchorDay degrades to a plain single-anchor monthly advance rather than crashing",
      toISODate(advanceDate(civilDate(2026, 7, 1), "SEMI_MONTHLY", 1, null)),
      "2026-08-01",
    );
    eq(
      "every other frequency is unaffected: WEEKLY",
      toISODate(advanceDate(civilDate(2026, 7, 1), "WEEKLY")),
      "2026-07-08",
    );
    eq(
      "every other frequency is unaffected: MONTHLY anchored on the 31st, clamped in February",
      toISODate(advanceDate(civilDate(2027, 1, 31), "MONTHLY", 31)),
      "2027-02-28",
    );

    console.log("-- owedOccurrences across a window (pure) --");
    const semiItem = {
      nextDate: civilDate(2026, 7, 1),
      frequency: "SEMI_MONTHLY" as const,
      anchorDay: 1,
      secondAnchorDay: 16,
    };
    eq(
      "a window spanning several months returns every weekend-shifted occurrence, in order",
      owedOccurrences(semiItem, civilDate(2026, 7, 1), civilDate(2026, 9, 1)).map(toISODate).join(","),
      "2026-07-01,2026-07-16,2026-07-31,2026-08-14,2026-09-01",
    );
    eq(
      "a window entirely before nextDate is empty",
      owedOccurrences(semiItem, civilDate(2026, 6, 1), civilDate(2026, 6, 30)).length,
      0,
    );
    eq(
      // Existing owedOccurrences semantics, unchanged: the one outstanding
      // backlog date (nextDate itself), then only occurrences that actually
      // fall inside [from, to] - occurrences before `from` are not
      // individually re-reported.
      "a window that starts after nextDate returns the outstanding backlog date, then only occurrences inside the window",
      owedOccurrences(semiItem, civilDate(2026, 8, 1), civilDate(2026, 8, 20)).map(toISODate).join(","),
      "2026-07-01,2026-08-14",
    );
    eq(
      "a finite item's countdown is spent one per occurrence, across both anchors",
      owedOccurrences({ ...semiItem, remainingOccurrences: 3 }, civilDate(2026, 7, 1), civilDate(2027, 1, 1))
        .map(toISODate)
        .join(","),
      "2026-07-01,2026-07-16,2026-07-31",
    );

    eq("twice a month is double the per-charge monthly-equivalent amount", monthlyEquivalent(50, "SEMI_MONTHLY"), 100);

    console.log("-- property sweep: alternation never skips, repeats, or locks onto one anchor --");
    // A handful of representative anchor pairs (including ones that clamp in
    // February) at every start day across three years, walked 30 steps.
    let sweepFailures = 0;
    const anchorPairs: [number, number][] = [
      [1, 16], [15, 31], [5, 20], [10, 25], [1, 15], [16, 1], [28, 13], [30, 15],
    ];
    for (const [a, b] of anchorPairs) {
      for (let offset = 0; offset < 365 * 3; offset += 11) {
        const start = advanceDate(addDays(civilDate(2024, 1, 1), offset), "SEMI_MONTHLY", a, b);
        let cursor = start;
        const diffs: number[] = [];
        const steps: Date[] = [cursor];
        for (let i = 0; i < 30; i += 1) {
          const next = advanceDate(cursor, "SEMI_MONTHLY", a, b);
          const gap = daysBetween(cursor, next);
          if (gap < 10 || gap > 20) sweepFailures += 1;
          cursor = next;
          steps.push(cursor);
        }
        // A genuinely alternating walk visits each anchor roughly every
        // other step; a walk stuck on one anchor would instead keep
        // landing near the same day every step. Anchors above 28 clamp
        // (and can then weekend-shift) in February, moving one two-step
        // pair by a few extra days - the same "Jan 31 -> Feb 28 -> Mar 31"
        // effect MONTHLY already has - so this checks the median two-step
        // difference across the whole walk, which one Feb clamp can't skew.
        for (let i = 0; i + 2 < steps.length; i += 1) {
          const d0 = steps[i].getUTCDate();
          const d2raw = steps[i + 2].getUTCDate();
          const d2 = d0 > 25 && d2raw < 5 ? d2raw + 31 : d2raw > 25 && d0 < 5 ? d0 + 31 : d2raw;
          diffs.push(Math.abs(d0 - d2));
        }
        const sortedDiffs = [...diffs].sort((x, y) => x - y);
        if ((sortedDiffs[Math.floor(sortedDiffs.length / 2)] ?? 0) > 2) sweepFailures += 1;
      }
    }
    eq(
      `every gap stays within a half-month band and the walk keeps alternating, across ${anchorPairs.length} anchor pairs x every start day in three years`,
      sweepFailures,
      0,
    );
  }

  console.log("\n== csv parsing ==");
  eq("all three formats supported", DATE_FORMATS.length, 3);
  eq("YYYY-MM-DD", toISODate(parseDateWithFormat("2026-08-16", "YYYY-MM-DD")!), "2026-08-16");
  eq("MM/DD/YYYY", toISODate(parseDateWithFormat("08/16/2026", "MM/DD/YYYY")!), "2026-08-16");
  eq("DD/MM/YYYY", toISODate(parseDateWithFormat("16/08/2026", "DD/MM/YYYY")!), "2026-08-16");
  check("rejects day 32", parseDateWithFormat("32/08/2026", "DD/MM/YYYY") === null);
  eq("thousands separator", parseAmount("1,234.56"), 1234.56);
  eq("parenthesised negative", parseAmount("(45.00)"), -45);
  eq("currency symbol and sign", parseAmount("-$45.10"), -45.1);
  eq("european decimals", parseAmount("1.234,56"), 1234.56);
  const rows = parseCsv('date,amount,description\r\n2026-08-16,-12.50,"Coffee, large"\n2026-08-17,20,"He said ""hi"""\n');
  eq("row count", rows.length, 3);
  eq("quoted comma preserved", rows[1][2], "Coffee, large");
  eq("escaped quotes", rows[2][2], 'He said "hi"');

  console.log("\n== amount entry parsing ==");
  const { parseAmountInput } = await import("../src/lib/money");
  const amountCases: [string, number | string][] = [
    ["12.50", 12.5],
    ["12,50", 12.5],
    ["12,5", 12.5],
    ["0,99", 0.99],
    ["1,250", 1250],
    ["1,250.00", 1250],
    ["1.250,50", 1250.5],
    ["1,234,567", 1234567],
    ["1.234.567,89", 1234567.89],
    ["1 250,50", 1250.5],
    ["12,", 12],
    [",5", 0.5],
    ["-12.30", -12.3],
    ["4061.02", 4061.02],
    ["0.1", 0.1],
    ["", "empty"],
    ["-", "invalid"],
    [".", "invalid"],
    ["abc", "invalid"],
    ["1,23,4", "invalid"],
    ["1.2.3", "invalid"],
    ["12.345", "too_many_decimals"],
    ["1.250", "too_many_decimals"],
    ["1000000000000", "too_large"],
  ];
  for (const [raw, expected] of amountCases) {
    const parsed = parseAmountInput(raw);
    if (typeof expected === "number") {
      check(`parses ${JSON.stringify(raw)} as ${expected}`, parsed.ok && parsed.amount === expected, parsed);
    } else {
      check(`rejects ${JSON.stringify(raw)} as ${expected}`, !parsed.ok && parsed.reason === expected, parsed);
    }
  }
  check(
    "parsing never leaks binary float error (1.005 is rejected, not rounded to 1)",
    !parseAmountInput("1.005").ok,
  );
  const eightCents = parseAmountInput("0.08");
  eq("parsed cents are exact for 0.07 + 0.01 style inputs", eightCents.ok ? eightCents.amount : "error", 0.08);

  const { transactionSchema } = await import("../src/lib/validation");
  const txBase = { date: "2026-08-20", currency: "DOP", type: "EXPENSE", accountId: "acct", categoryId: "", note: "" };
  const commaTx = transactionSchema.safeParse({ ...txBase, amount: "12,50" });
  eq("a transaction amount typed with a comma decimal is 12.50, not 1250", commaTx.success ? commaTx.data.amount : "error", 12.5);
  const dotTx = transactionSchema.safeParse({ ...txBase, amount: "12.50" });
  eq("a transaction amount typed with a dot decimal is unchanged", dotTx.success ? dotTx.data.amount : "error", 12.5);
  const threeDecimals = transactionSchema.safeParse({ ...txBase, amount: "12.345" });
  eq("three decimals are rejected with a specific message", threeDecimals.success ? "accepted" : threeDecimals.error.issues[0].message, "Use at most 2 decimal places");
  const zeroTx = transactionSchema.safeParse({ ...txBase, amount: "0,00" });
  eq("a zero amount is still rejected", zeroTx.success ? "accepted" : zeroTx.error.issues[0].message, "Enter an amount greater than 0");
  const { firstError } = await import("../src/lib/validation");
  eq(
    "the decimal-places message is translated to Spanish",
    threeDecimals.success ? "accepted" : firstError(threeDecimals.error, "es"),
    "Usa como máximo 2 decimales",
  );

  console.log("\n-- transactionSchema: EXTERNAL_TRANSFER invariants --");
  {
    const base = { date: "2026-08-20", currency: "DOP", accountId: "acct", note: "" };

    const missingDirection = transactionSchema.safeParse({
      ...base, amount: "100", type: "EXTERNAL_TRANSFER", categoryId: "",
    });
    check("EXTERNAL_TRANSFER without a direction is rejected", !missingDirection.success);

    const outParsed = transactionSchema.safeParse({
      ...base, amount: "5000", type: "EXTERNAL_TRANSFER", categoryId: "some-category-id", transferDirection: "OUT",
    });
    check("EXTERNAL_TRANSFER with an OUT direction validates", outParsed.success);
    eq(
      "categoryId is forced null even though one was submitted",
      outParsed.success ? outParsed.data.categoryId : "n/a",
      null,
    );
    eq(
      "transferDirection OUT survives validation",
      outParsed.success ? outParsed.data.transferDirection : "n/a",
      "OUT",
    );

    const inParsed = transactionSchema.safeParse({
      ...base, amount: "2000", type: "EXTERNAL_TRANSFER", categoryId: "", transferDirection: "IN",
    });
    check("EXTERNAL_TRANSFER with an IN direction validates", inParsed.success);
    eq(
      "transferDirection IN survives validation",
      inParsed.success ? inParsed.data.transferDirection : "n/a",
      "IN",
    );

    const garbageDirection = transactionSchema.safeParse({
      ...base, amount: "100", type: "EXTERNAL_TRANSFER", categoryId: "", transferDirection: "SIDEWAYS",
    });
    check("an unrecognized transferDirection value is rejected for EXTERNAL_TRANSFER", !garbageDirection.success);

    const expenseWithStaleDirection = transactionSchema.safeParse({
      ...base, amount: "50", type: "EXPENSE", categoryId: "", transferDirection: "OUT",
    });
    check("an ordinary EXPENSE still validates even if transferDirection is present", expenseWithStaleDirection.success);
    eq(
      "a stale transferDirection is dropped for a non-EXTERNAL_TRANSFER type",
      expenseWithStaleDirection.success ? expenseWithStaleDirection.data.transferDirection : "n/a",
      null,
    );

    const incomeNoDirection = transactionSchema.safeParse({
      ...base, amount: "50", type: "INCOME", categoryId: "",
    });
    check("an ordinary INCOME with no transferDirection field at all still validates", incomeNoDirection.success);
  }

  console.log("\n== transaction edit guard ==");
  const { transactionEditBlock, balanceSign, isCashflow } = await import("../src/lib/transactions");
  const plain = { transferId: null, source: "MANUAL", externalId: null };
  eq("an opening balance can't be edited through the transaction form", transactionEditBlock({ ...plain, type: "OPENING_BALANCE" }), "opening_balance");
  eq("a transfer leg can't be edited through the transaction form", transactionEditBlock({ ...plain, type: "TRANSFER", transferId: "t1" }), "transfer");
  eq("an ordinary expense can be edited", transactionEditBlock({ ...plain, type: "EXPENSE" }), null);
  eq("an ordinary income can be edited", transactionEditBlock({ ...plain, type: "INCOME" }), null);
  eq("an outgoing external transfer can be edited (single row, never paired)", transactionEditBlock({ ...plain, type: "EXTERNAL_TRANSFER" }), null);
  eq("an incoming external transfer can be edited (single row, never paired)", transactionEditBlock({ ...plain, type: "EXTERNAL_TRANSFER" }), null);
  eq("a goal contribution's expense can't be edited through the transaction form", transactionEditBlock({ ...plain, type: "EXPENSE", externalId: "goal-contribution:c1" }), "goal_contribution");
  eq("the prefix only counts under source MANUAL", transactionEditBlock({ ...plain, type: "EXPENSE", source: "CSV", externalId: "goal-contribution:c1" }), null);
  eq("a RECURRING externalId is not a goal contribution twin", transactionEditBlock({ ...plain, type: "EXPENSE", source: "RECURRING", externalId: "item:2026-08-01" }), null);
  eq("the paycheck a payday check-in recorded can't be edited or deleted through the transaction form", transactionEditBlock({ ...plain, type: "INCOME", source: "PAYDAY_CHECKIN" }), "payday_income");
  eq("an ordinary income row from any other source is still editable", transactionEditBlock({ ...plain, type: "INCOME", source: "CSV" }), null);
  eq("balanceSign(EXTERNAL_TRANSFER, OUT) is -1, same shape as an outgoing internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "OUT"), -1);
  eq("balanceSign(EXTERNAL_TRANSFER, IN) is +1, same shape as an incoming internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "IN"), 1);
  eq("isCashflow(EXTERNAL_TRANSFER) is false - it never counts as income or spending", isCashflow("EXTERNAL_TRANSFER"), false);

  console.log("\n== currency conversion through USD ==");
  const rates: RateTable = {
    rates: { USD: 1, DOP: 60, EUR: 0.5 },
    fetchedAt: new Date(),
    stale: false,
    source: "open-er-api",
    asOf: null,
  };
  eq("USD to DOP", convert(100, "USD", "DOP", rates), 6000);
  eq("DOP to USD", convert(6000, "DOP", "USD", rates), 100);
  eq("EUR to DOP has no stored pair", convert(10, "EUR", "DOP", rates), 1200);
  eq("DOP to EUR round trip", convert(1200, "DOP", "EUR", rates), 10);
  eq("same currency is identity", convert(7, "EUR", "EUR", rates), 7);

  console.log("\n== external transfer: schema ==");
  {
    const smokeAccount = await prisma.account.create({
      data: { name: "Verify Schema Smoke", currency: "USD", type: "CHECKING" },
    });
    const smokeRow = await prisma.transaction.create({
      data: {
        date: civilDate(2026, 8, 1),
        amount: 1,
        currency: "USD",
        type: "EXTERNAL_TRANSFER",
        transferDirection: "OUT",
        accountId: smokeAccount.id,
        source: "MANUAL",
      },
    });
    eq("Postgres accepts the EXTERNAL_TRANSFER enum value", smokeRow.type, "EXTERNAL_TRANSFER");
    await prisma.transaction.delete({ where: { id: smokeRow.id } });
    await prisma.account.delete({ where: { id: smokeAccount.id } });
  }

  console.log("\n== database invariants ==");
  const context = {
    displayCurrency: "USD" as const,
    language: "en" as const,
    rates,
    today: civilDate(2026, 8, 20),
    currentPeriod: periodForDate(civilDate(2026, 8, 20)),
  };

  const checking = await prisma.account.create({
    data: { name: "Verify Checking", currency: "USD", type: "CHECKING" },
  });
  const savings = await prisma.account.create({
    data: { name: "Verify Savings", currency: "DOP", type: "SAVINGS" },
  });

  await prisma.transaction.create({
    data: { date: civilDate(2026, 8, 18), amount: 100, currency: "USD", type: "INCOME", accountId: checking.id, source: "MANUAL" },
  });
  await prisma.transaction.create({
    data: { date: civilDate(2026, 8, 19), amount: 30, currency: "USD", type: "EXPENSE", accountId: checking.id, source: "MANUAL" },
  });
  const transferId = crypto.randomUUID();
  await prisma.$transaction([
    prisma.transaction.create({
      data: { date: civilDate(2026, 8, 20), amount: 50, currency: "USD", type: "TRANSFER", accountId: checking.id, transferId, transferDirection: "OUT", source: "MANUAL" },
    }),
    prisma.transaction.create({
      data: { date: civilDate(2026, 8, 20), amount: 50, currency: "USD", type: "TRANSFER", accountId: savings.id, transferId, transferDirection: "IN", source: "MANUAL" },
    }),
  ]);

  const { getAccountBalances } = await import("../src/lib/data/accounts");
  const balances = await getAccountBalances(context);
  const checkingBalance = balances.find((a) => a.id === checking.id)!;
  const savingsBalance = balances.find((a) => a.id === savings.id)!;
  eq("checking = income - expense - transfer out", checkingBalance.balance, 20);
  eq("savings receives the transfer in its own currency", savingsBalance.balance, 3000);
  eq("net across accounts in USD nets the transfer to zero", Math.round((checkingBalance.displayBalance + savingsBalance.displayBalance) * 100) / 100, 70);

  const { getPeriodSummary } = await import("../src/lib/data/period-summary");
  await prisma.budget.create({
    data: { year: 2026, month: 8, period: "B", categoryId: null, amount: 500, currency: "USD" },
  });
  const groceries = await prisma.category.findFirst({ where: { name: "Groceries" } });
  await prisma.budget.create({
    data: { year: 2026, month: 8, period: "B", categoryId: groceries!.id, amount: 200, currency: "USD" },
  });
  await prisma.recurringItem.create({
    data: { name: "Verify Netflix", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 25), active: true },
  });
  await prisma.recurringItem.create({
    data: { name: "Verify past due", amount: 99, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 5), active: true },
  });

  const summary = await getPeriodSummary(context.currentPeriod, context);
  eq("spent excludes transfers", summary.spent, 30);
  eq("income excludes transfers", summary.income, 100);
  eq("overall budget wins over category totals", summary.periodBudget, 500);
  eq("committed counts what the period still owes, overdue included (15 + 99)", summary.committed, 114);
  eq("safe to spend = budget - spent, with committed outflows not subtracted twice", summary.safeToSpend, 470);
  eq("per day over the 12 remaining days", summary.safeToSpendPerDay, Math.round((470 / 12) * 100) / 100);

  let duplicateOverall = false;
  try {
    await prisma.budget.create({
      data: { year: 2026, month: 8, period: "B", categoryId: null, amount: 900, currency: "USD" },
    });
  } catch {
    duplicateOverall = true;
  }
  check("a second overall budget for the period is rejected", duplicateOverall);

  let duplicateCategory = false;
  try {
    await prisma.budget.create({
      data: { year: 2026, month: 8, period: "B", categoryId: groceries!.id, amount: 900, currency: "USD" },
    });
  } catch {
    duplicateCategory = true;
  }
  check("a second category budget for the period is rejected", duplicateCategory);

  const otherPeriod = await prisma.budget.create({
    data: { year: 2026, month: 9, period: "A", categoryId: null, amount: 400, currency: "USD" },
  });
  check("a different period can hold its own overall budget", Boolean(otherPeriod.id));

  const { recomputeGoalSaved } = await import("../src/lib/goals");
  const goal = await prisma.goal.create({
    data: { name: "Verify Goal", targetAmount: 1000, currency: "EUR", targetDate: civilDate(2026, 12, 31) },
  });
  await prisma.goalContribution.createMany({
    data: [
      { goalId: goal.id, amount: 120.5, currency: "EUR", date: civilDate(2026, 7, 5) },
      { goalId: goal.id, amount: 79.5, currency: "EUR", date: civilDate(2026, 8, 5) },
    ],
  });
  const saved = await recomputeGoalSaved(goal.id);
  eq("savedAmount equals the sum of contributions", saved, 200);
  const stored = await prisma.goal.findUnique({ where: { id: goal.id } });
  eq("cached savedAmount is written back", Number(stored!.savedAmount), 200);

  await prisma.goal.update({ where: { id: goal.id }, data: { savedAmount: 5 } });
  eq("self-heal restores the cached value", await recomputeGoalSaved(goal.id), 200);

  const { listGoals } = await import("../src/lib/data/goals");
  const goals = await listGoals(context);
  const verifyGoal = goals.find((g) => g.id === goal.id)!;
  eq("periods left to the target date", verifyGoal.periodsLeft, 9);
  eq("per period = remaining / periods left", verifyGoal.perPeriod, Math.round((800 / 9) * 100) / 100);

  console.log("\n== external transfer: manual create/update/delete invariants ==");
  {
    // saveTransactionAction/deleteTransactionAction are "use server" actions
    // gated by requireAuth() (next/headers cookies()), which only works
    // inside a real Next.js request - this script can't call them directly.
    // Every check below instead exercises the exact same two steps those
    // actions perform - validate via transactionSchema, then the identical
    // prisma.transaction calls - so each assertion is a real database
    // assertion, just without the auth/redirect wrapper (covered by manual
    // QA instead - see the plan's final task).
    const extAccount = await prisma.account.create({
      data: { name: "Verify External Transfer", currency: "DOP", type: "CHECKING" },
    });
    const otherAccount = await prisma.account.create({
      data: { name: "Verify External Transfer Other", currency: "DOP", type: "CHECKING" },
    });
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
    const incomeCat = await prisma.category.findFirstOrThrow({ where: { name: "Income" } });

    const extContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: civilDate(2026, 8, 20),
      currentPeriod: periodForDate(civilDate(2026, 8, 20)),
    };
    const balanceOf = async (accountId: string) => {
      const balances = await getAccountBalances(extContext, { status: "ALL" });
      return balances.find((a) => a.id === accountId)?.balance ?? 0;
    };

    // -- create: EXTERNAL_TRANSFER OUT, categoryId forced null even if submitted --
    const createOutParsed = transactionSchema.safeParse({
      date: "2026-08-20",
      amount: "5000",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: groceriesCat.id, // deliberately submitted - must be dropped
      note: "Sent to Mom",
      transferDirection: "OUT",
    });
    check("create: EXTERNAL_TRANSFER OUT validates", createOutParsed.success);
    if (!createOutParsed.success) throw new Error("fixture setup failed: createOutParsed");
    eq("create: categoryId is forced null even though one was submitted", createOutParsed.data.categoryId, null);
    eq("create: transferDirection OUT survives validation", createOutParsed.data.transferDirection, "OUT");

    const { id: _createOutId, ...outValues } = createOutParsed.data;
    const outRow = await prisma.transaction.create({ data: { ...outValues, source: "MANUAL" } });
    eq("create: transferId stays null - never paired like an internal transfer", outRow.transferId, null);
    eq("create: type is EXTERNAL_TRANSFER", outRow.type, "EXTERNAL_TRANSFER");
    eq("create: categoryId is null in the database", outRow.categoryId, null);
    eq("create: transactionEditBlock allows editing it (unlike a TRANSFER leg)", transactionEditBlock(outRow), null);
    eq("create: account balance drops by the full amount", await balanceOf(extAccount.id), -5000);

    // -- create: EXTERNAL_TRANSFER IN --
    const createInParsed = transactionSchema.safeParse({
      date: "2026-08-21",
      amount: "2000",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: "",
      note: "Dad's pass-through funds",
      transferDirection: "IN",
    });
    check("create: EXTERNAL_TRANSFER IN validates", createInParsed.success);
    if (!createInParsed.success) throw new Error("fixture setup failed: createInParsed");
    const { id: _createInId, ...inValues } = createInParsed.data;
    const inRow = await prisma.transaction.create({ data: { ...inValues, source: "MANUAL" } });
    eq("create: account balance reflects both rows (-5000 + 2000)", await balanceOf(extAccount.id), -3000);

    // -- update: EXPENSE -> EXTERNAL_TRANSFER clears category, sets direction --
    const expenseRow = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 22), amount: 300, currency: "DOP", type: "EXPENSE", accountId: extAccount.id, categoryId: groceriesCat.id, source: "MANUAL" },
    });
    const toExternalParsed = transactionSchema.safeParse({
      id: expenseRow.id,
      date: "2026-08-22",
      amount: "300",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: groceriesCat.id, // still submitted by a form that hasn't cleared its own field yet
      note: "Actually a pass-through",
      transferDirection: "OUT",
    });
    check("update EXPENSE->EXTERNAL_TRANSFER validates", toExternalParsed.success);
    if (!toExternalParsed.success) throw new Error("fixture setup failed: toExternalParsed");
    const { id: updateId1, ...toExternalValues } = toExternalParsed.data;
    await prisma.transaction.update({ where: { id: updateId1! }, data: toExternalValues });
    const afterToExternal = await prisma.transaction.findUniqueOrThrow({ where: { id: expenseRow.id } });
    eq("update EXPENSE->EXTERNAL_TRANSFER: categoryId clears to null", afterToExternal.categoryId, null);
    eq("update EXPENSE->EXTERNAL_TRANSFER: transferDirection is set", afterToExternal.transferDirection, "OUT");
    eq("update EXPENSE->EXTERNAL_TRANSFER: transferId remains null", afterToExternal.transferId, null);
    eq("update EXPENSE->EXTERNAL_TRANSFER: still editable", transactionEditBlock(afterToExternal), null);

    // -- update: EXTERNAL_TRANSFER -> INCOME clears direction, category settable again --
    const backToIncomeParsed = transactionSchema.safeParse({
      id: expenseRow.id,
      date: "2026-08-22",
      amount: "300",
      currency: "DOP",
      type: "INCOME",
      accountId: extAccount.id,
      categoryId: incomeCat.id,
      note: "Turned out to be real income",
      transferDirection: "OUT", // stale client state from before switching the type back - must be dropped
    });
    check("update EXTERNAL_TRANSFER->INCOME validates", backToIncomeParsed.success);
    if (!backToIncomeParsed.success) throw new Error("fixture setup failed: backToIncomeParsed");
    eq("update EXTERNAL_TRANSFER->INCOME: stale transferDirection is dropped by validation", backToIncomeParsed.data.transferDirection, null);
    const { id: updateId2, ...backToIncomeValues } = backToIncomeParsed.data;
    await prisma.transaction.update({ where: { id: updateId2! }, data: backToIncomeValues });
    const afterBackToIncome = await prisma.transaction.findUniqueOrThrow({ where: { id: expenseRow.id } });
    eq("update EXTERNAL_TRANSFER->INCOME: transferDirection clears to null in the database", afterBackToIncome.transferDirection, null);
    eq("update EXTERNAL_TRANSFER->INCOME: categoryId is settable again", afterBackToIncome.categoryId, incomeCat.id);
    eq("update EXTERNAL_TRANSFER->INCOME: transferId still null", afterBackToIncome.transferId, null);

    // -- update: direction change OUT -> IN on an existing EXTERNAL_TRANSFER row --
    const balanceBeforeFlip = await balanceOf(extAccount.id);
    const flipParsed = transactionSchema.safeParse({
      id: outRow.id, date: "2026-08-20", amount: "5000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Sent to Mom", transferDirection: "IN",
    });
    check("update: flipping EXTERNAL_TRANSFER direction validates", flipParsed.success);
    if (!flipParsed.success) throw new Error("fixture setup failed: flipParsed");
    const { id: flipId, ...flipValues } = flipParsed.data;
    await prisma.transaction.update({ where: { id: flipId! }, data: flipValues });
    const balanceAfterFlip = await balanceOf(extAccount.id);
    eq(
      "update: flipping OUT->IN on a 5000 row moves the balance by 10000 (removes the -5000 effect, adds +5000)",
      round2(balanceAfterFlip - balanceBeforeFlip),
      10000,
    );

    // flip it back OUT so the rest of this block's balance math stays predictable
    const flipBackParsed = transactionSchema.safeParse({
      id: outRow.id, date: "2026-08-20", amount: "5000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Sent to Mom", transferDirection: "OUT",
    });
    if (!flipBackParsed.success) throw new Error("fixture setup failed: flipBackParsed");
    const { id: flipBackId, ...flipBackValues } = flipBackParsed.data;
    await prisma.transaction.update({ where: { id: flipBackId! }, data: flipBackValues });
    const afterFlipBack = await prisma.transaction.findUniqueOrThrow({ where: { id: outRow.id } });
    eq("update: flipped-back row's transferDirection is OUT again", afterFlipBack.transferDirection, "OUT");
    eq("update: flipped-back row is still editable", transactionEditBlock(afterFlipBack), null);

    // -- update: reassigning accountId moves the effect to the new account --
    const balanceOldBefore = await balanceOf(extAccount.id);
    const balanceNewBefore = await balanceOf(otherAccount.id);
    const reassignParsed = transactionSchema.safeParse({
      id: inRow.id, date: "2026-08-21", amount: "2000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: otherAccount.id, categoryId: "", note: "Dad's pass-through funds", transferDirection: "IN",
    });
    check("update: reassigning accountId validates", reassignParsed.success);
    if (!reassignParsed.success) throw new Error("fixture setup failed: reassignParsed");
    const { id: reassignId, ...reassignValues } = reassignParsed.data;
    await prisma.transaction.update({ where: { id: reassignId! }, data: reassignValues });
    eq("update: old account balance drops by the reassigned row's effect", round2((await balanceOf(extAccount.id)) - balanceOldBefore), -2000);
    eq("update: new account balance picks up the reassigned row's effect", round2((await balanceOf(otherAccount.id)) - balanceNewBefore), 2000);

    // move it back so the delete check below only has to look in one place
    const moveBackParsed = transactionSchema.safeParse({
      id: inRow.id, date: "2026-08-21", amount: "2000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Dad's pass-through funds", transferDirection: "IN",
    });
    if (!moveBackParsed.success) throw new Error("fixture setup failed: moveBackParsed");
    const { id: moveBackId, ...moveBackValues } = moveBackParsed.data;
    await prisma.transaction.update({ where: { id: moveBackId! }, data: moveBackValues });
    const afterMoveBack = await prisma.transaction.findUniqueOrThrow({ where: { id: inRow.id } });
    eq("update: moved-back row is on extAccount again", afterMoveBack.accountId, extAccount.id);

    // -- delete: an EXTERNAL_TRANSFER row is a single row, never a paired delete --
    const beforeDeleteCount = await prisma.transaction.count({ where: { accountId: extAccount.id } });
    const balanceBeforeDelete = await balanceOf(extAccount.id);
    const toDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: outRow.id } });
    // Mirrors deleteTransactionAction exactly: transferId is null, so it
    // takes the single-row `else` branch, never the multi-row
    // `deleteMany({ transferId })` branch used for internal transfer legs.
    eq("delete: the row being deleted has a null transferId before branching", toDelete.transferId, null);
    if (toDelete.transferId) {
      await prisma.transaction.deleteMany({ where: { transferId: toDelete.transferId } });
    } else {
      await prisma.transaction.delete({ where: { id: toDelete.id } });
    }
    const afterDeleteCount = await prisma.transaction.count({ where: { accountId: extAccount.id } });
    eq("delete: exactly one row is removed, not a paired transfer delete", beforeDeleteCount - afterDeleteCount, 1);
    const stillThere = await prisma.transaction.findUnique({ where: { id: inRow.id } });
    check("delete: the other EXTERNAL_TRANSFER row on the same account is untouched", stillThere !== null);
    eq("delete: the sibling row's account is unchanged", stillThere?.accountId, extAccount.id);
    eq(
      "delete: deleting the 5000 OUT row raises the account balance by exactly 5000",
      round2((await balanceOf(extAccount.id)) - balanceBeforeDelete),
      5000,
    );

    await prisma.transaction.deleteMany({ where: { accountId: { in: [extAccount.id, otherAccount.id] } } });
    await prisma.account.deleteMany({ where: { id: { in: [extAccount.id, otherAccount.id] } } });
    console.log("  ok   external transfer manual CRUD fixtures removed");
  }

  console.log("\n== external transfer: BSC import scenario ==");
  {
    // Reproduces the real production-data edge case this feature exists for:
    // a BSC bank CSV account with "Debito Por Transferencia" rows that are
    // NOT internal Cadence transfers (the destination is outside Cadence
    // entirely) and must not inflate spending. Amounts match the actual BSC
    // CSV cited in the task: several DOP 5,000 rows plus two large ones
    // (134,422 and 115,000).
    const bsc = await prisma.account.create({
      data: { name: "Verify BSC", currency: "DOP", type: "CHECKING" },
    });
    const bscContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: civilDate(2026, 8, 20),
      currentPeriod: periodForDate(civilDate(2026, 8, 20)),
    };

    const bscExternalRows = [
      { date: civilDate(2026, 4, 16), amount: 134422, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 5, 3), amount: 5000, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 6, 12), amount: 5000, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 8, 21), amount: 115000, note: "Debito Por Transferencia" },
    ];
    // A real, unrelated expense in the same account/period, to prove it's
    // still counted normally once the external-transfer rows are excluded.
    const realExpense = { date: civilDate(2026, 8, 18), amount: 1200, note: "Supermercado Nacional" };

    // Mirrors exactly what importTransactionsAction writes for a row whose
    // CSV-review decision was "Record as external transfer": categoryId
    // null, transferDirection carried through, source CSV.
    await prisma.transaction.createMany({
      data: bscExternalRows.map((row) => ({
        date: row.date,
        amount: row.amount,
        currency: "DOP",
        type: "EXTERNAL_TRANSFER" as const,
        transferDirection: "OUT" as const,
        accountId: bsc.id,
        categoryId: null,
        note: row.note,
        source: "CSV" as const,
      })),
    });
    const groceriesForBsc = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
    await prisma.transaction.create({
      data: {
        date: realExpense.date,
        amount: realExpense.amount,
        currency: "DOP",
        type: "EXPENSE",
        accountId: bsc.id,
        categoryId: groceriesForBsc.id,
        note: realExpense.note,
        source: "CSV",
      },
    });

    const bscBalances = await getAccountBalances(bscContext, { status: "ALL" });
    const bscBalance = bscBalances.find((a) => a.id === bsc.id)!;
    const totalExternal = bscExternalRows.reduce((sum, row) => sum + row.amount, 0);
    eq(
      "BSC account balance reflects the full reduction from every external-transfer row plus the real expense",
      bscBalance.balance,
      -(totalExternal + realExpense.amount),
    );

    const { getPeriodSummary } = await import("../src/lib/data/period-summary");
    const augPeriodB = periodForDate(civilDate(2026, 8, 20));
    const augSummary = await getPeriodSummary(augPeriodB, bscContext);
    // getPeriodSummary is app-wide (not scoped to one account) and converts to
    // the display currency, so this also includes the pre-existing $30 USD
    // "database invariants" expense (line ~342, Aug 19, same period) plus our
    // 1200 DOP real expense converted to USD (1200 / 60 = 20): 30 + 20 = 50.
    // The point of this check is what's absent: none of the 259,422 DOP in
    // external-transfer rows (including the 115,000 landing in this same
    // period) leaks into spend.
    eq(
      "period spend for the covering period counts only the real expense, not the 115,000 external transfer landing in the same period",
      augSummary.spent,
      50,
    );

    const { getAccountLedger } = await import("../src/lib/data/accounts");
    const bscLedger = await getAccountLedger(bsc.id, bscContext);
    eq("ledger externalOut totals every external-transfer row", bscLedger!.totals.externalOut, totalExternal);
    eq("ledger outflow only counts the real expense, not the external transfers", bscLedger!.totals.outflow, 1200);

    const anyExternalRow = await prisma.transaction.findFirstOrThrow({ where: { accountId: bsc.id, type: "EXTERNAL_TRANSFER" } });
    eq("each external-transfer row remains individually editable", transactionEditBlock(anyExternalRow), null);
    eq("each external-transfer row is still a single row, never paired", anyExternalRow.transferId, null);

    await prisma.transaction.deleteMany({ where: { accountId: bsc.id } });
    await prisma.account.delete({ where: { id: bsc.id } });
    console.log("  ok   BSC scenario fixtures removed");
  }

  console.log("\n== the display currency drives goal and budget presentation ==");
  // A stored amount is a native financial value; every figure the pages show
  // is that same amount converted once into the selected display currency.
  // Switching between the three first-class currencies must therefore always
  // derive from the stored value, never from an already-converted one.
  const inCurrency = (code: "USD" | "DOP" | "EUR") => ({ ...context, displayCurrency: code });
  const goalIn = async (code: "USD" | "DOP" | "EUR") =>
    (await listGoals(inCurrency(code))).find((g) => g.id === goal.id)!;
  const goalInEur = await goalIn("EUR");
  const goalInUsd = await goalIn("USD");
  const goalInDop = await goalIn("DOP");

  eq("the goal's own stored currency is reported unchanged", goalInUsd.currency, "EUR");
  for (const [code, view] of [["EUR", goalInEur], ["USD", goalInUsd], ["DOP", goalInDop]] as const) {
    eq(`goal progress is shown in ${code}`, view.displaySaved, round2(convert(200, "EUR", code, rates)));
    eq(`goal target is shown in ${code}`, view.displayTarget, round2(convert(1000, "EUR", code, rates)));
    eq(`goal remaining is shown in ${code}`, view.displayRemaining, round2(convert(800, "EUR", code, rates)));
    eq(
      `the per-pay-period roadmap amount is shown in ${code}`,
      view.displayPerPeriod,
      round2(convert(verifyGoal.perPeriod!, "EUR", code, rates)),
    );
    eq(`the display currency is reported alongside the figures in ${code}`, view.displayCurrency, code);
  }
  eq("a goal in the display currency is not converted at all", goalInEur.displaySaved, 200);
  eq("switching EUR -> USD -> EUR recovers the stored goal amount exactly", (await goalIn("EUR")).displaySaved, 200);
  eq("switching EUR -> DOP -> EUR recovers the stored goal amount exactly", (await goalIn("EUR")).displayTarget, 1000);
  const goalRowAfterSwitching = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
  check(
    "switching the display currency never rewrites the goal's stored currency or amounts",
    goalRowAfterSwitching.currency === "EUR" &&
      num(goalRowAfterSwitching.savedAmount) === 200 &&
      num(goalRowAfterSwitching.targetAmount) === 1000,
  );

  // A period far outside the payday history lookback, so this budget is only
  // ever read by the checks below.
  const displayBudgetPeriod = { year: 2026, month: 2, period: "A" as const };
  const displayBudget = await prisma.budget.create({
    data: { ...displayBudgetPeriod, categoryId: groceries!.id, amount: 9000, currency: "DOP" },
  });
  const budgetIn = async (code: "USD" | "DOP" | "EUR") =>
    getPeriodSummary(periodInfo(displayBudgetPeriod), inCurrency(code));
  for (const code of ["DOP", "USD", "EUR"] as const) {
    const view = await budgetIn(code);
    eq(`a DOP budget's category line is shown in ${code}`, view.categories[0]?.budget, round2(convert(9000, "DOP", code, rates)));
    eq(`the period budget total is shown in ${code}`, view.periodBudget, round2(convert(9000, "DOP", code, rates)));
    eq(`the summary reports the currency its figures are in (${code})`, view.currency, code);
  }
  eq("switching DOP -> USD -> DOP recovers the stored budget exactly", (await budgetIn("DOP")).periodBudget, 9000);
  eq("switching DOP -> EUR -> DOP recovers the stored budget exactly", (await budgetIn("DOP")).periodBudget, 9000);
  const budgetRowAfterSwitching = await prisma.budget.findUniqueOrThrow({ where: { id: displayBudget.id } });
  check(
    "switching the display currency never rewrites the budget's stored currency or amount",
    budgetRowAfterSwitching.currency === "DOP" && num(budgetRowAfterSwitching.amount) === 9000,
  );

  // The Budgets page edits these amounts in the display currency, so the save
  // path has to tell an untouched field apart from a real edit.
  const { isSameMoney } = await import("../src/lib/currency");
  check(
    "re-saving the displayed value is recognised as the stored amount, not an edit",
    isSameMoney(round2(convert(9000, "DOP", "USD", rates)), "USD", 9000, "DOP", rates),
  );
  check(
    "an actual edit is not mistaken for the stored amount",
    !isSameMoney(round2(convert(9000, "DOP", "USD", rates)) + 1, "USD", 9000, "DOP", rates),
  );
  await prisma.budget.delete({ where: { id: displayBudget.id } });

  // Overdue items are no longer silently rolled forward: the posting job
  // (src/lib/recurring-posting.ts) either posts them or, when the item lacks
  // the account/goal it needs, leaves them where they are and reports them.
  const { postDueRecurringItems: catchUpRecurring } = await import("../src/lib/recurring-posting");
  const catchUp = await catchUpRecurring(context.today);
  eq(
    "an overdue item with no account is reported as skipped rather than rolled",
    catchUp.skipped.find((item) => item.name === "Verify past due")?.reason,
    "missing_account",
  );
  const rolled = await prisma.recurringItem.findFirst({ where: { name: "Verify past due" } });
  eq("a skipped item keeps its overdue nextDate", toISODate(rolled!.nextDate), "2026-08-05");

  const summaryAfter = await getPeriodSummary(context.currentPeriod, context);
  eq(
    "an overdue, unposted item is still owed and stays in committed (15 + 99)",
    summaryAfter.committed,
    114,
  );

  console.log("\n== monthly spending pace ==");
  // Clear earlier sections' fixtures that would otherwise leak into these
  // calculations: getCurrentMonthPace queries active recurring items globally
  // (not scoped by name), and computeMonthActuals queries Transaction and
  // GoalContribution globally by date - "Verify Goal" has a contribution
  // dated in July and one in August that would land inside the windows below.
  await prisma.recurringItem.deleteMany({ where: { name: { in: ["Verify Netflix", "Verify past due"] } } });
  await prisma.goal.deleteMany({ where: { name: "Verify Goal" } });
  const {
    MIN_HISTORICAL_MONTHS,
    MAX_HISTORICAL_MONTHS,
    classifyCompletedMonth,
    compareToAverage,
    computeCompletedMonthWindows,
    getCompletedMonthWindows,
    getCurrentMonthPace,
    getHistoricalMonthlyAverage,
    matchRecurringToTransactions,
  } = await import("../src/lib/data/monthly");
  const { daysElapsedInMonth, monthForDate, monthWindow } = await import("../src/lib/month");

  console.log("\n-- month windows (pure) --");
  eq("Feb 2026 (non-leap) ends on the 28th", toISODate(monthWindow({ year: 2026, month: 2 }).end), "2026-02-28");
  eq("Feb 2024 (leap) ends on the 29th", toISODate(monthWindow({ year: 2024, month: 2 }).end), "2024-02-29");
  eq("April ends on the 30th", toISODate(monthWindow({ year: 2026, month: 4 }).end), "2026-04-30");
  eq("August ends on the 31st", toISODate(monthWindow({ year: 2026, month: 8 }).end), "2026-08-31");
  eq("days elapsed on the 1st is 1, never 0", daysElapsedInMonth(civilDate(2026, 8, 1)), 1);
  eq("days elapsed on the 15th", daysElapsedInMonth(civilDate(2026, 8, 15)), 15);
  eq(
    "monthForDate composes with the APP_TIMEZONE civil date, not UTC",
    monthForDate(civilDateInZone(new Date("2026-09-01T01:00:00.000Z"), SD)).key,
    "2026-08",
  );

  console.log("\n-- recurring/transaction matching (pure) --");
  const netflixItem = {
    id: "item-netflix",
    name: "Netflix",
    amount: 15,
    currency: "USD",
    categoryId: "cat-subscriptions",
    kind: "SUBSCRIPTION" as const,
    frequency: "MONTHLY" as const,
    nextDate: civilDate(2026, 9, 1),
  };
  const spotifyItem = {
    id: "item-spotify",
    name: "Spotify Premium",
    amount: 10,
    currency: "USD",
    categoryId: null,
    kind: "SUBSCRIPTION" as const,
    frequency: "MONTHLY" as const,
    nextDate: civilDate(2026, 9, 1),
  };
  const byCategory = matchRecurringToTransactions(
    [netflixItem],
    [{ id: "tx-1", amount: 15, currency: "USD", categoryId: "cat-subscriptions", note: null }],
  );
  check("matches by category + amount + currency", byCategory.matchedTransactionIds.has("tx-1"));
  const byName = matchRecurringToTransactions(
    [spotifyItem],
    [{ id: "tx-2", amount: 10, currency: "USD", categoryId: null, note: "SPOTIFY PREMIUM 08/26" }],
  );
  check("matches by normalized note when category can't disambiguate", byName.matchedTransactionIds.has("tx-2"));
  const wrongCurrency = matchRecurringToTransactions(
    [netflixItem],
    [{ id: "tx-3", amount: 15, currency: "EUR", categoryId: "cat-subscriptions", note: null }],
  );
  check("currency mismatch never matches", !wrongCurrency.matchedTransactionIds.has("tx-3"));
  const noDoubleMatch = matchRecurringToTransactions(
    [netflixItem, { ...spotifyItem, id: "item-spotify-2", categoryId: "cat-subscriptions" }],
    [{ id: "tx-4", amount: 15, currency: "USD", categoryId: "cat-subscriptions", note: null }],
  );
  check(
    "one transaction satisfies at most one recurring item",
    noDoubleMatch.matchedTransactionIds.size === 1,
  );

  console.log("\n-- compareToAverage (pure) --");
  eq("within tolerance reads as on pace", compareToAverage(102, 100).direction, "onPace");
  eq("clearly above the average", compareToAverage(150, 100).direction, "above");
  eq("clearly below the average", compareToAverage(50, 100).direction, "below");

  console.log("\n-- classification: lifestyle vs committed vs savings vs excluded --");
  const monthlyAccount = await prisma.account.create({
    data: { name: "Verify Monthly Checking", currency: "USD", type: "CHECKING" },
  });
  const subscriptionsCategory = await prisma.category.findFirstOrThrow({ where: { name: "Subscriptions" } });
  const savingsCategory = await prisma.category.findFirstOrThrow({ where: { name: "Savings/Investment" } });
  check("the seeded Savings/Investment category is flagged, not name-matched", savingsCategory.isSavingsDefault);

  const julyWindow = monthWindow({ year: 2026, month: 7 });
  await prisma.transaction.createMany({
    data: [
      { date: civilDate(2026, 7, 5), amount: 60, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: groceries!.id, source: "MANUAL" },
      { date: civilDate(2026, 7, 6), amount: 12, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, source: "MANUAL" },
      { date: civilDate(2026, 7, 7), amount: 15, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: subscriptionsCategory.id, note: "Netflix", source: "MANUAL" },
      { date: civilDate(2026, 7, 8), amount: 25, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: savingsCategory.id, source: "MANUAL" },
      { date: civilDate(2026, 7, 9), amount: 500, currency: "USD", type: "INCOME", accountId: monthlyAccount.id, source: "MANUAL" },
    ],
  });
  const julyTransferId = crypto.randomUUID();
  await prisma.$transaction([
    prisma.transaction.create({ data: { date: civilDate(2026, 7, 10), amount: 200, currency: "USD", type: "TRANSFER", accountId: monthlyAccount.id, transferId: julyTransferId, transferDirection: "OUT", source: "MANUAL" } }),
    prisma.transaction.create({ data: { date: civilDate(2026, 7, 10), amount: 200, currency: "USD", type: "TRANSFER", accountId: monthlyAccount.id, transferId: julyTransferId, transferDirection: "IN", source: "MANUAL" } }),
  ]);
  const monthlyGoal = await prisma.goal.create({ data: { name: "Verify Monthly Goal", targetAmount: 1000, currency: "USD" } });
  await prisma.goalContribution.create({ data: { goalId: monthlyGoal.id, amount: 50, currency: "USD", date: civilDate(2026, 7, 11) } });
  await prisma.recurringItem.createMany({
    data: [
      { name: "Verify Netflix Monthly", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 7), active: true, categoryId: subscriptionsCategory.id, createdAt: civilDate(2026, 1, 1) },
      { name: "Verify Spotify Monthly", amount: 10, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 25), active: true, createdAt: civilDate(2026, 1, 1) },
      { name: "Verify Auto-Invest", amount: 100, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 1), active: true, createdAt: civilDate(2026, 1, 1) },
    ],
  });

  const monthlyContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 7, 31), currentPeriod: periodForDate(civilDate(2026, 7, 31)) };
  const recurringForMatch = (await prisma.recurringItem.findMany({
    where: { active: true, kind: { in: ["SUBSCRIPTION", "CONTRIBUTION"] }, name: { startsWith: "Verify" } },
    select: { id: true, name: true, amount: true, currency: true, categoryId: true, kind: true, frequency: true, nextDate: true, anchorDay: true, secondAnchorDay: true, createdAt: true },
  })).map((item) => ({ ...item, amount: Number(item.amount) }));
  const categoryMeta = await prisma.category.findMany({ select: { id: true, name: true, color: true, isSavingsDefault: true } });

  const julyBreakdown = await classifyCompletedMonth(julyWindow, monthlyContext, recurringForMatch, categoryMeta);
  eq("lifestyle counts groceries + uncategorized expenses", julyBreakdown.lifestyle, 72);
  eq("committed dedupes the matched Netflix charge (15) + Spotify's scheduled fallback (10)", julyBreakdown.committed, 25);
  eq(
    "savings/investing = category expense + goal contribution + unmatched contribution's scheduled fallback",
    julyBreakdown.savingsInvesting,
    175,
  );
  eq("normal spending excludes savings/investing", julyBreakdown.normalSpending, 97);
  eq("total outflow = lifestyle + committed + savings", julyBreakdown.totalOutflow, 272);
  eq(
    "the $500 income and $200 transfer never inflate any bucket",
    julyBreakdown.lifestyle + julyBreakdown.committed + julyBreakdown.savingsInvesting,
    272,
  );

  console.log("\n-- current-month projection --");
  await prisma.recurringItem.createMany({
    data: [
      { name: "Verify Pace HBO", amount: 8, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 10), active: true },
      { name: "Verify Pace EuroSub", amount: 20, currency: "EUR", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 25), active: true },
      { name: "Verify Pace DOPSub", amount: 600, currency: "DOP", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 25), active: true },
    ],
  });
  await prisma.transaction.createMany({
    data: [
      { date: civilDate(2026, 8, 5), amount: 30, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: groceries!.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 20), amount: 100, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: groceries!.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 3), amount: 15, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: subscriptionsCategory.id, note: "Netflix", source: "MANUAL" },
      { date: civilDate(2026, 8, 2), amount: 5, currency: "USD", type: "EXPENSE", accountId: monthlyAccount.id, categoryId: savingsCategory.id, source: "MANUAL" },
    ],
  });
  await prisma.goalContribution.createMany({
    data: [
      { goalId: monthlyGoal.id, amount: 20, currency: "USD", date: civilDate(2026, 8, 4) },
      { goalId: monthlyGoal.id, amount: 30, currency: "USD", date: civilDate(2026, 8, 20) },
    ],
  });
  const paceContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 8, 15), currentPeriod: periodForDate(civilDate(2026, 8, 15)) };
  const pace = await getCurrentMonthPace(paceContext);
  eq("current month is August (31 days)", pace.window.totalDays, 31);
  eq("day 15 of 31 elapsed", pace.daysElapsed, 15);
  eq("lifestyle so far excludes the future-dated (Aug 20) transaction", pace.lifestyleSpentSoFar, 30);
  eq("projected lifestyle = (spent so far / days elapsed) * days in month", pace.projectedLifestyle, 62);
  eq("committed so far is the matched Netflix charge only, no scheduled fallback for the current month", pace.committedSpentSoFar, 15);
  eq(
    "still-due keeps an overdue unposted item (HBO 8) but drops the occurrence Netflix's charge settled, and converts EUR/DOP",
    pace.committedStillDueThisMonth,
    68,
  );
  eq("projected normal spending = projected lifestyle + committed so far + still due", pace.projectedNormalSpending, 145);
  eq("savings/investing this month is actual only, never projected", pace.savingsInvestingSoFar, 25);

  await prisma.transaction.deleteMany({ where: { accountId: monthlyAccount.id } });
  await prisma.account.delete({ where: { id: monthlyAccount.id } });
  await prisma.goalContribution.deleteMany({ where: { goalId: monthlyGoal.id } });
  await prisma.goal.delete({ where: { id: monthlyGoal.id } });
  await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify" } } });
  console.log("  ok   monthly pace fixtures removed");

  console.log("\n-- completed month windows: current month excluded, capped by history, insufficient states (pure) --");
  // computeCompletedMonthWindows is pure (no DB), so these are exact and don't
  // depend on whatever real activity already exists in the target database -
  // getCompletedMonthWindows itself is just this function wired to real dates
  // (checked against real data below, without hardcoding what that data is).
  const threeMonths = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 5 }, 6);
  eq("stops at the first-recorded-activity month instead of inventing zero months", threeMonths.length, 3);
  eq("oldest included month is the activity month itself", threeMonths[0].key, "2026-05");
  eq("current month (August) is never included", threeMonths.some((w) => w.key === "2026-08"), false);

  const oneMonth = computeCompletedMonthWindows({ year: 2026, month: 6 }, { year: 2026, month: 5 }, 6);
  eq("only one completed month exists yet", oneMonth.length, 1);
  eq("fewer than three completed months would read as insufficient", oneMonth.length < MIN_HISTORICAL_MONTHS, true);

  const zeroMonths = computeCompletedMonthWindows({ year: 2026, month: 5 }, { year: 2026, month: 5 }, 6);
  eq("no completed months before the first activity's own month has even ended", zeroMonths.length, 0);

  const sixMonths = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2020, month: 1 }, 6);
  eq("caps at MAX_HISTORICAL_MONTHS even with years of history", sixMonths.length, 6);
  eq("uses the most recent six, not the oldest six", sixMonths[0].key, "2026-02");
  eq("newest completed month is the one right before the current month", sixMonths[5].key, "2026-07");

  eq("no recorded activity at all returns no completed months", computeCompletedMonthWindows({ year: 2026, month: 8 }, null, 6).length, 0);

  console.log("\n-- completed month windows: a second, independent boundary (count income history from) --");
  // Mirrors firstActivityMonth's own mechanism - not a parallel one: the
  // break condition is against whichever of the two boundaries is later
  // (more restrictive), same comparison, same loop.
  eq(
    "omitting the boundary (3 args) is byte-for-byte the same as before - the regression this exists to prevent",
    computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 1 }, 6).map((w) => w.key).join(","),
    computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 1 }, 6, null).map((w) => w.key).join(","),
  );
  const boundaryLater = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 1 }, 6, { year: 2026, month: 4 });
  eq("a boundary later than first activity wins: it, not first activity, is where the walk stops", boundaryLater[0].key, "2026-04");
  eq("months on/after the boundary are all still included, up to maxCount", boundaryLater.map((w) => w.key).join(","), "2026-04,2026-05,2026-06,2026-07");
  const boundaryEarlier = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 5 }, 6, { year: 2026, month: 1 });
  eq("a boundary earlier than first activity loses: first activity still wins, exactly as with no boundary at all", boundaryEarlier.map((w) => w.key).join(","), threeMonths.map((w) => w.key).join(","));
  const boundaryTied = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 5 }, 6, { year: 2026, month: 5 });
  eq("a boundary equal to first activity changes nothing", boundaryTied.map((w) => w.key).join(","), threeMonths.map((w) => w.key).join(","));
  const boundaryLeavesTooFew = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 1 }, 6, { year: 2026, month: 7 });
  eq("a boundary set this recently leaves one month, correctly below the minimum - not an error, not forced to average over too few", `${boundaryLeavesTooFew.length}:${boundaryLeavesTooFew.length < MIN_HISTORICAL_MONTHS}`, "1:true");
  const boundaryPastEverything = computeCompletedMonthWindows({ year: 2026, month: 8 }, { year: 2026, month: 1 }, 6, { year: 2026, month: 9 });
  eq("a boundary past even the current month leaves nothing", boundaryPastEverything.length, 0);

  console.log("\n-- getCompletedMonthWindows / getHistoricalMonthlyAverage wiring (against real data) --");
  const wiringContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 8, 20), currentPeriod: periodForDate(civilDate(2026, 8, 20)) };
  const actualFirstActivity = await prisma.transaction.aggregate({ _min: { date: true } });
  const expectedWindows = computeCompletedMonthWindows(
    monthForDate(wiringContext.today),
    actualFirstActivity._min.date ? monthForDate(actualFirstActivity._min.date) : null,
  );
  const wiredWindows = await getCompletedMonthWindows(wiringContext);
  eq(
    "getCompletedMonthWindows applies the same boundary logic to the real first-activity date",
    wiredWindows.map((w) => w.key).join(","),
    expectedWindows.map((w) => w.key).join(","),
  );
  const wiredAverage = await getHistoricalMonthlyAverage(wiringContext);
  eq("sufficient reflects whether the wired months meet the minimum", wiredAverage.sufficient, expectedWindows.length >= MIN_HISTORICAL_MONTHS);
  eq("monthsUsed matches the wired window count", wiredAverage.monthsUsed, expectedWindows.length);

  // context.incomeHistoryStartDate (Settings' "count income history from")
  // wired through to the same pure boundary, converted to a month the same
  // way monthForDate already converts every other date here.
  const boundedContext = { ...wiringContext, incomeHistoryStartDate: civilDate(2026, 7, 1) };
  const expectedBoundedWindows = computeCompletedMonthWindows(
    monthForDate(wiringContext.today),
    actualFirstActivity._min.date ? monthForDate(actualFirstActivity._min.date) : null,
    MAX_HISTORICAL_MONTHS,
    monthForDate(civilDate(2026, 7, 1)),
  );
  const boundedWindows = await getCompletedMonthWindows(boundedContext);
  eq(
    "getCompletedMonthWindows reads context.incomeHistoryStartDate and applies the same second boundary, whatever the real first-activity date turns out to be",
    boundedWindows.map((w) => w.key).join(","),
    expectedBoundedWindows.map((w) => w.key).join(","),
  );
  const nullDateContext = { ...wiringContext, incomeHistoryStartDate: null };
  const nullDateWindows = await getCompletedMonthWindows(nullDateContext);
  eq("an explicit null on the context is the same as leaving it unset", nullDateWindows.map((w) => w.key).join(","), wiredWindows.map((w) => w.key).join(","));
  const boundedAverage = await getHistoricalMonthlyAverage(boundedContext);
  eq("the average's own monthsUsed and sufficiency follow the bounded window count, unmodified by getHistoricalMonthlyAverage itself", `${boundedAverage.monthsUsed}:${boundedAverage.sufficient}`, `${expectedBoundedWindows.length}:${expectedBoundedWindows.length >= MIN_HISTORICAL_MONTHS}`);

  console.log("\n== payday planner (pure) ==");
  // Sep 2026: the 15th is a Tuesday and the 30th a Wednesday, so neither
  // boundary shifts - the weekday baseline.
  eq("a weekday 15th is a payday date (Tue Sep 15 2026)", isPaydayDate(civilDate(2026, 9, 15)), true);
  eq("the day before a weekday 15th is not a payday date", isPaydayDate(civilDate(2026, 9, 14)), false);
  eq("the day after a weekday 15th is not a payday date", isPaydayDate(civilDate(2026, 9, 16)), false);
  eq("a weekday last day is a payday date (Wed Sep 30 2026)", isPaydayDate(civilDate(2026, 9, 30)), true);
  eq("the day before a weekday last day is not a payday date", isPaydayDate(civilDate(2026, 9, 29)), false);

  eq("Aug 31 2026 (Monday) is a payday date", isPaydayDate(civilDate(2026, 8, 31)), true);
  eq("Feb 29 2024 (leap, Thursday) is a payday date", isPaydayDate(civilDate(2024, 2, 29)), true);
  eq("Feb 28 2024 (leap, not last day) is not a payday date", isPaydayDate(civilDate(2024, 2, 28)), false);
  eq("the 1st is not a payday date", isPaydayDate(civilDate(2026, 8, 1)), false);

  // A boundary on a weekend is paid the preceding Friday: Saturday moves back
  // one day, Sunday two.
  // Aug 2026: the 15th is a Saturday.
  eq("a Saturday 15th pays on the Friday before (Aug 14 2026)", isPaydayDate(civilDate(2026, 8, 14)), true);
  eq("a Saturday 15th is not itself a payday date", isPaydayDate(civilDate(2026, 8, 15)), false);
  eq("the Sunday after a Saturday 15th is not a payday date", isPaydayDate(civilDate(2026, 8, 16)), false);

  // Mar 2026: the 15th is a Sunday, and the 31st a Tuesday.
  eq("a Sunday 15th pays on the Friday two days before (Mar 13 2026)", isPaydayDate(civilDate(2026, 3, 13)), true);
  eq("the Saturday before a Sunday 15th is not a payday date", isPaydayDate(civilDate(2026, 3, 14)), false);
  eq("a Sunday 15th is not itself a payday date", isPaydayDate(civilDate(2026, 3, 15)), false);
  eq("that month's weekday last day still pays on the day (Tue Mar 31 2026)", isPaydayDate(civilDate(2026, 3, 31)), true);

  // Jan 2026: the 31st is a Saturday, the 15th a Thursday.
  eq("a Saturday last day pays on the Friday before (Jan 30 2026)", isPaydayDate(civilDate(2026, 1, 30)), true);
  eq("a Saturday last day is not itself a payday date", isPaydayDate(civilDate(2026, 1, 31)), false);
  eq("that month's weekday 15th is unaffected (Thu Jan 15 2026)", isPaydayDate(civilDate(2026, 1, 15)), true);

  // May 2026: the 31st is a Sunday, the 15th a Friday.
  eq("a Sunday last day pays on the Friday two days before (May 29 2026)", isPaydayDate(civilDate(2026, 5, 29)), true);
  eq("the Saturday before a Sunday last day is not a payday date", isPaydayDate(civilDate(2026, 5, 30)), false);
  eq("a Sunday last day is not itself a payday date", isPaydayDate(civilDate(2026, 5, 31)), false);

  // Feb 2026: both boundaries land on a weekend (Sun 15th, Sat 28th).
  eq("both weekend boundaries shift in the same month (Fri Feb 13 2026)", isPaydayDate(civilDate(2026, 2, 13)), true);
  eq("both weekend boundaries shift in the same month (Fri Feb 27 2026)", isPaydayDate(civilDate(2026, 2, 27)), true);
  eq("a Sunday 15th in that month is not a payday date", isPaydayDate(civilDate(2026, 2, 15)), false);
  eq("a Saturday last day in that month is not a payday date", isPaydayDate(civilDate(2026, 2, 28)), false);

  {
    // Every month of 2026 has exactly two paydays, both on weekdays.
    let paydayCount = 0;
    let weekendPaydays = 0;
    for (let month = 1; month <= 12; month += 1) {
      for (let dayOfMonth = 1; dayOfMonth <= daysInMonth(2026, month); dayOfMonth += 1) {
        const date = civilDate(2026, month, dayOfMonth);
        if (!isPaydayDate(date)) continue;
        paydayCount += 1;
        const weekday = date.getUTCDay();
        if (weekday === 0 || weekday === 6) weekendPaydays += 1;
      }
    }
    eq("2026 has exactly two paydays a month", paydayCount, 24);
    eq("no 2026 payday falls on a weekend", weekendPaydays, 0);
  }

  eq("buffer = 10% of income when that beats the floor", defaultProtectedBuffer(50000, 10, 2000), 5000);
  eq("buffer falls back to the floor when 10% of income is smaller", defaultProtectedBuffer(1000, 10, 2000), 2000);
  eq("zero income still yields the floor, never zero", defaultProtectedBuffer(0, 10, 2000), 2000);

  eq(
    "available flexible money follows the exact formula",
    availableForFlexibleCategories({
      income: 40000,
      includedCarryover: 2000,
      subscriptions: 3000,
      recurringContributions: 5000,
      goalPlan: 6000,
      essentialFixed: 8000,
      buffer: 4000,
    }),
    16000,
  );
  eq(
    "a shortfall shows as a negative amount, not zero",
    availableForFlexibleCategories({
      income: 10000,
      includedCarryover: 0,
      subscriptions: 3000,
      recurringContributions: 5000,
      goalPlan: 6000,
      essentialFixed: 0,
      buffer: 2000,
    }),
    -6000,
  );
  {
    // The reconciliation gap (every flagged account's reportedGap, in the
    // display currency) is a ceiling applied after the seven-input formula,
    // never a change to it: a zero gap is byte-for-byte the old result.
    const sevenInputs = {
      income: 40000,
      includedCarryover: 2000,
      subscriptions: 3000,
      recurringContributions: 5000,
      goalPlan: 6000,
      essentialFixed: 8000,
      buffer: 4000,
    };
    eq(
      "a reconciliation gap of zero leaves the available figure exactly as the seven-input formula had it",
      availableForFlexibleCategories({ ...sevenInputs, reconciliationGap: 0 }),
      16000,
    );
    eq(
      "a reconciliation gap caps the available figure by exactly that amount, after the seven-input formula",
      availableForFlexibleCategories({ ...sevenInputs, reconciliationGap: 5000 }),
      11000,
    );
    eq(
      "the cap can take the available figure below zero - a deficit shown as such, never clamped",
      availableForFlexibleCategories({ ...sevenInputs, reconciliationGap: 20000 }),
      -4000,
    );
  }

  {
    // summarizePaydayDraft is what both the Dashboard check-in summary line
    // and the period hero's recommended overall budget read - it must convert
    // income per account and apply the same formula as above.
    const draftRates: RateTable = {
      rates: { USD: 1, DOP: 60 },
      fetchedAt: new Date(),
      stale: false,
      source: "open-er-api",
      asOf: null,
    };
    const draft = {
      displayCurrency: "DOP",
      accounts: [
        { accountId: "dop", name: "DOP account", currency: "DOP", incomeEntered: 30000, bufferFloor: 2000, reportedBalance: 10000 },
        { accountId: "usd", name: "USD account", currency: "USD", incomeEntered: 100, bufferFloor: 33.33, reportedBalance: null },
      ],
      subscriptions: [],
      bufferPercent: 10,
      goals: [{ plannedAmount: 4000 }],
      essentialCategories: [{ plannedAmount: 5000 }, { plannedAmount: 1000 }],
      flexibleCategories: [
        { suggestedAmount: 900, plannedAmount: 2500.5, held: true },
        { suggestedAmount: 0, plannedAmount: 0, held: true },
      ],
      includedCarryover: 2000,
      subscriptionsTotal: 3000,
      contributionsTotal: 1500,
      plannedBuffer: 3600,
    } as unknown as Parameters<typeof summarizePaydayDraft>[0];
    const summary = summarizePaydayDraft(draft, draftRates);
    eq("draft summary converts every account's income into the display currency", summary.totalIncome, 36000);
    eq("draft summary sums essential fixed planned amounts", summary.essentialFixedTotal, 6000);
    eq("draft summary sums flexible planned amounts", summary.flexibleTotal, 2500.5);
    eq(
      "draft summary resolves an unheld flexible row against its own available figure, like the wizard does",
      summarizePaydayDraft(
        { ...draft, flexibleCategories: [{ suggestedAmount: 25000, plannedAmount: 25000, held: false }] } as typeof draft,
        draftRates,
      ).flexibleTotal,
      19900,
    );
    eq(
      "draft summary's available figure follows availableForFlexibleCategories",
      summary.available,
      availableForFlexibleCategories({
        income: 36000,
        includedCarryover: 2000,
        subscriptions: 3000,
        recurringContributions: 1500,
        goalPlan: 4000,
        essentialFixed: 6000,
        buffer: 3600,
      }),
    );
    eq("draft summary available is 19,900 for that plan", summary.available, 19900);
    eq(
      "an over-committed draft summarises to a negative available, not zero",
      summarizePaydayDraft({ ...draft, plannedBuffer: 30000 }, draftRates).available,
      -6500,
    );
    eq(
      "a draft whose reported balances are all positive or absent reports a zero reconciliation gap",
      summary.reconciliationGap,
      0,
    );
    {
      // The DOP account was already 4,000 in the hole before its pay landed
      // (Step 1's reported balance is the pre-income figure), so the draft
      // summary - the Dashboard card and the period hero's suggestion - caps
      // its available figure by that gap, and its unheld flexible rows follow
      // the capped figure exactly as the wizard's Step 4 does.
      const gappedDraft = {
        ...draft,
        accounts: [{ ...draft.accounts[0], reportedBalance: -4000 }, draft.accounts[1]],
      } as typeof draft;
      const gapped = summarizePaydayDraft(gappedDraft, draftRates);
      eq("a negative reported balance on a draft account caps the draft summary's available figure by that gap", gapped.available, 15900);
      eq("the draft summary reports the gap it applied, in the display currency", gapped.reconciliationGap, 4000);
      eq(
        "the draft summary's unheld flexible rows resolve against the capped figure",
        summarizePaydayDraft(
          { ...gappedDraft, flexibleCategories: [{ suggestedAmount: 25000, plannedAmount: 25000, held: false }] } as typeof draft,
          draftRates,
        ).flexibleTotal,
        15900,
      );
    }
  }

  {
    const bufferAccounts = [
      { accountId: "bsc", name: "BSC", currency: "USD", income: 1000, bufferFloor: 33.33 },
      { accountId: "popular", name: "Popular", currency: "DOP", income: 30000, bufferFloor: 2000 },
      { accountId: "cash", name: "Cash", currency: "USD", income: 0, bufferFloor: 33.33 },
    ];
    const bufferSubs = [
      { recurringItemId: "rent", accountId: "bsc", nativeAmount: 950, currency: "USD", alreadyLogged: false },
      { recurringItemId: "netflix", accountId: "bsc", nativeAmount: 500, currency: "USD", alreadyLogged: true },
      { recurringItemId: "gym", accountId: null, nativeAmount: 40, currency: "USD", alreadyLogged: false },
      { recurringItemId: "phone", accountId: "cash", nativeAmount: 25, currency: "USD", alreadyLogged: false },
    ];
    const perAccount = planAccountBuffers(bufferAccounts, bufferSubs, {
      bufferPercent: 10,
      displayCurrency: "USD",
      rates,
    });
    const bsc = perAccount.accounts.find((a) => a.accountId === "bsc")!;
    const popular = perAccount.accounts.find((a) => a.accountId === "popular")!;
    eq("an account with no income entered gets no buffer row of its own", perAccount.accounts.length, 2);
    eq("each account's buffer is 10% of its own income, not a share of the total", bsc.suggestedBuffer, 100);
    eq("a second account's buffer is computed in its own currency", popular.suggestedBuffer, 3000);
    eq(
      "an already-paid subscription is not counted against its account's buffer a second time",
      bsc.subscriptionsTotal,
      950,
    );
    check(
      "an account whose due subscriptions would breach its own buffer is flagged with the shortfall",
      bsc.belowBuffer === true && bsc.shortfall === 50,
      JSON.stringify({ belowBuffer: bsc.belowBuffer, shortfall: bsc.shortfall }),
    );
    eq("the flagged account names the account with the most room this period", bsc.suggestedAccountName, "Popular");
    check(
      "an account that stays above its own buffer is not flagged and reports its headroom",
      popular.belowBuffer === false && popular.headroom === 27000,
      JSON.stringify({ belowBuffer: popular.belowBuffer, headroom: popular.headroom }),
    );
    eq(
      "subscriptions with no account, or on an account with no income, stay listed as unassigned",
      perAccount.unassignedRecurringItemIds.join(","),
      "gym,phone",
    );
    eq(
      "the per-account buffers sum into the display currency for the single protectedBuffer figure",
      perAccount.total,
      150,
    );
  }

  {
    // Step 1's reported balance is the account's balance *before* this
    // check-in's income (see ledgerBefore in src/lib/data/payday.ts), so what
    // the account can really support this period is that balance plus the
    // income, less its due subscriptions and its own buffer. Measured against
    // the income-only headroom, the shortfall is exactly how far the account
    // was already in the hole when the pay landed - money that left before the
    // check-in, which the period-income figure cannot see. Advisory only.
    const reconcileSubs = [
      { recurringItemId: "internet", accountId: "hole", nativeAmount: 2500, currency: "DOP", alreadyLogged: false },
      { recurringItemId: "gym", accountId: "hole", nativeAmount: 1500, currency: "DOP", alreadyLogged: false },
      { recurringItemId: "paid", accountId: "hole", nativeAmount: 900, currency: "DOP", alreadyLogged: true },
      { recurringItemId: "spotify", accountId: "flush", nativeAmount: 500, currency: "DOP", alreadyLogged: false },
    ];
    const reconciled = planAccountBuffers(
      [
        { accountId: "hole", name: "Hole", currency: "DOP", income: 40000, bufferFloor: 2000, reportedBalance: -11919 },
        { accountId: "flush", name: "Flush", currency: "DOP", income: 20000, bufferFloor: 2000, reportedBalance: 6000 },
        { accountId: "even", name: "Even", currency: "DOP", income: 20000, bufferFloor: 2000, reportedBalance: 0 },
        { accountId: "silent", name: "Silent", currency: "DOP", income: 20000, bufferFloor: 2000 },
      ],
      reconcileSubs,
      { bufferPercent: 10, displayCurrency: "DOP", rates },
    );
    const hole = reconciled.accounts.find((a) => a.accountId === "hole")!;
    const flush = reconciled.accounts.find((a) => a.accountId === "flush")!;
    const even = reconciled.accounts.find((a) => a.accountId === "even")!;
    const silent = reconciled.accounts.find((a) => a.accountId === "silent")!;
    eq(
      "reported-balance support is reported balance + income - due subscriptions - own buffer, skipping already-paid ones",
      hole.reportedSupports,
      -11919 + 40000 - 4000 - 4000,
    );
    check(
      "an account already in the hole before the pay landed is flagged with exactly that gap against its income-only headroom",
      hole.belowReported === true && hole.reportedGap === 11919 && hole.headroom === 32000,
      JSON.stringify({ belowReported: hole.belowReported, reportedGap: hole.reportedGap, headroom: hole.headroom }),
    );
    check(
      "an account with money to spare before the pay landed supports more than its headroom and is not flagged",
      flush.belowReported === false && flush.reportedGap === 0 && flush.reportedSupports === 6000 + 20000 - 500 - 2000,
      JSON.stringify({ belowReported: flush.belowReported, reportedGap: flush.reportedGap, supports: flush.reportedSupports }),
    );
    check(
      "a reported balance of zero supports exactly the income-only headroom, with no flag",
      even.belowReported === false && even.reportedGap === 0 && even.reportedSupports === even.headroom,
      JSON.stringify({ belowReported: even.belowReported, reportedGap: even.reportedGap, supports: even.reportedSupports, headroom: even.headroom }),
    );
    check(
      "an account with no reported balance given reports null support and is never flagged",
      silent.reportedSupports === null && silent.reportedGap === 0 && silent.belowReported === false,
      JSON.stringify({ supports: silent.reportedSupports, reportedGap: silent.reportedGap, belowReported: silent.belowReported }),
    );
    check(
      "the reported-balance check never changes the income-only headroom, shortfall, or buffer figures",
      hole.belowBuffer === false && hole.shortfall === 0 && hole.suggestedBuffer === 4000 && reconciled.total === 10000,
      JSON.stringify({ belowBuffer: hole.belowBuffer, shortfall: hole.shortfall, buffer: hole.suggestedBuffer, total: reconciled.total }),
    );
    // The breakdown's own gap total, summed into the display currency the way
    // `total` sums the buffers: 11,919 DOP from Hole plus 10 USD (600 DOP) from
    // a USD account in the hole; accounts with no gap contribute nothing.
    const gapTotal = planAccountBuffers(
      [
        { accountId: "hole", name: "Hole", currency: "DOP", income: 40000, bufferFloor: 2000, reportedBalance: -11919 },
        { accountId: "usdhole", name: "USD hole", currency: "USD", income: 1000, bufferFloor: 33.33, reportedBalance: -10 },
        { accountId: "flush", name: "Flush", currency: "DOP", income: 20000, bufferFloor: 2000, reportedBalance: 6000 },
      ],
      reconcileSubs,
      { bufferPercent: 10, displayCurrency: "DOP", rates },
    );
    eq(
      "the breakdown sums every flagged account's gap into the display currency, ignoring accounts with no gap",
      gapTotal.reconciliationGap,
      12519,
    );
    eq(
      "with no account flagged the breakdown's gap is exactly zero",
      planAccountBuffers(
        [
          { accountId: "flush", name: "Flush", currency: "DOP", income: 20000, bufferFloor: 2000, reportedBalance: 6000 },
          { accountId: "silent", name: "Silent", currency: "DOP", income: 20000, bufferFloor: 2000 },
        ],
        reconcileSubs,
        { bufferPercent: 10, displayCurrency: "DOP", rates },
      ).reconciliationGap,
      0,
    );

    // suggestCoverShortfall composes the same reconciliationGap and headroom
    // figures into a recommendation: which other account to draw from. Hole
    // is flagged for 11,919 DOP; Even and Silent both have 18,000 DOP of
    // headroom (tied, Even listed first) and neither is itself flagged, so
    // Even is picked and the whole gap is covered.
    const coverFull = suggestCoverShortfall("hole", reconciled.accounts, {
      displayCurrency: "DOP",
      rates,
    });
    check(
      "the best unflagged account with the most headroom is recommended, covering the gap in full",
      coverFull?.sourceAccountId === "even" && coverFull.amount === 11919 && coverFull.fullyCovers === true,
      JSON.stringify(coverFull),
    );
  }

  {
    // Plain "nothing to spare anywhere" case: the only other account exists
    // but its headroom is exactly zero (its due subscriptions already use up
    // everything past its own buffer) - not a candidate, so null rather than
    // an empty or unhelpful suggestion.
    const noHeadroomAccounts = [
      { accountId: "gap", name: "Gap", currency: "DOP", income: 20000, bufferFloor: 2000, reportedBalance: -1000 },
      { accountId: "tapped", name: "Tapped", currency: "DOP", income: 20000, bufferFloor: 2000 },
    ];
    const noHeadroomSubs = [
      { recurringItemId: "rent2", accountId: "tapped", nativeAmount: 18000, currency: "DOP", alreadyLogged: false },
    ];
    const noHeadroomPlan = planAccountBuffers(noHeadroomAccounts, noHeadroomSubs, {
      bufferPercent: 10,
      displayCurrency: "DOP",
      rates,
    });
    const tapped = noHeadroomPlan.accounts.find((a) => a.accountId === "tapped")!;
    eq("the scenario's own setup: tapped's due subscription leaves exactly zero headroom", tapped.headroom, 0);
    eq(
      "no other account has any headroom to spare - nothing safe to suggest",
      suggestCoverShortfall("gap", noHeadroomPlan.accounts, { displayCurrency: "DOP", rates }),
      null,
    );
  }

  {
    // A rich account that is itself flagged belowReported must never be
    // offered as a source - its own headroom is the pre-correction figure.
    // flaggedRich has 90,000 DOP of headroom but a 1 DOP reconciliation gap
    // of its own; poorHelper (unflagged) has only 8,000 (10,000 income less
    // its 2,000 buffer), less than short's 50,000 gap, so the honest answer
    // is a partial suggestion for exactly poorHelper's headroom - never
    // flaggedRich's, and never poorHelper's headroom summed with
    // tinyHelper's to manufacture full coverage.
    const excludeAccounts = [
      { accountId: "short", name: "Short", currency: "DOP", income: 40000, bufferFloor: 2000, reportedBalance: -50000 },
      { accountId: "flaggedRich", name: "Flagged Rich", currency: "DOP", income: 100000, bufferFloor: 2000, reportedBalance: -1 },
      { accountId: "poorHelper", name: "Poor Helper", currency: "DOP", income: 10000, bufferFloor: 2000 },
      { accountId: "tinyHelper", name: "Tiny Helper", currency: "DOP", income: 5000, bufferFloor: 2000 },
    ];
    const excludePlan = planAccountBuffers(excludeAccounts, [], { bufferPercent: 10, displayCurrency: "DOP", rates });
    const short = excludePlan.accounts.find((a) => a.accountId === "short")!;
    const flaggedRich = excludePlan.accounts.find((a) => a.accountId === "flaggedRich")!;
    check(
      "the scenario's own setup: short is flagged with a large gap, flaggedRich is flagged despite huge headroom",
      short.belowReported === true && short.reportedGap === 50000 && flaggedRich.belowReported === true,
      JSON.stringify({ shortGap: short.reportedGap, flaggedRichFlagged: flaggedRich.belowReported }),
    );
    const coverExcluding = suggestCoverShortfall("short", excludePlan.accounts, {
      displayCurrency: "DOP",
      rates,
    });
    check(
      "a source account that is itself flagged belowReported is skipped even though it has the most headroom, and the honest partial amount is the best eligible account's headroom alone",
      coverExcluding?.sourceAccountId === "poorHelper" &&
        coverExcluding.amount === 8000 &&
        coverExcluding.fullyCovers === false,
      JSON.stringify(coverExcluding),
    );

    // With the only two candidates removed, nothing eligible is left even
    // though flaggedRich still has headroom to spare - null, not a fallback
    // to the flagged account.
    const noneEligible = suggestCoverShortfall(
      "short",
      excludePlan.accounts.filter((a) => a.accountId !== "poorHelper" && a.accountId !== "tinyHelper"),
      { displayCurrency: "DOP", rates },
    );
    eq("with every other account either flagged or gone, there is nothing safe to suggest", noneEligible, null);
  }

  {
    // Two accounts each flagged with their own reconciliation gap: neither
    // should be recommended to cover the other, even though each has some
    // headroom - suggestCoverShortfall must return null for both rather than
    // pointing one flagged account at another.
    const bothFlaggedAccounts = [
      { accountId: "alpha", name: "Alpha", currency: "DOP", income: 30000, bufferFloor: 2000, reportedBalance: -5000 },
      { accountId: "beta", name: "Beta", currency: "DOP", income: 30000, bufferFloor: 2000, reportedBalance: -3000 },
    ];
    const bothFlaggedPlan = planAccountBuffers(bothFlaggedAccounts, [], {
      bufferPercent: 10,
      displayCurrency: "DOP",
      rates,
    });
    const alpha = bothFlaggedPlan.accounts.find((a) => a.accountId === "alpha")!;
    const beta = bothFlaggedPlan.accounts.find((a) => a.accountId === "beta")!;
    check(
      "the scenario's own setup: both accounts are flagged belowReported",
      alpha.belowReported === true && beta.belowReported === true,
      JSON.stringify({ alphaFlagged: alpha.belowReported, betaFlagged: beta.belowReported }),
    );
    eq(
      "neither flagged account recommends the other as a source",
      suggestCoverShortfall("alpha", bothFlaggedPlan.accounts, { displayCurrency: "DOP", rates }),
      null,
    );
    eq(
      "the same holds in the other direction",
      suggestCoverShortfall("beta", bothFlaggedPlan.accounts, { displayCurrency: "DOP", rates }),
      null,
    );
  }

  {
    // Goal funding draws on the same headroom the buffer view reports: what an
    // account has left after its subscriptions and its own buffer. Popular has
    // 27,000 DOP (450 USD) to spare, BSC 150 USD, and Cash is below its buffer.
    const goalPool = [
      { accountId: "popular", name: "Popular", currency: "DOP", headroom: 27000 },
      { accountId: "bsc", name: "BSC", currency: "USD", headroom: 150 },
      { accountId: "cash", name: "Cash", currency: "USD", headroom: -20 },
    ];
    const fundingOptions = { displayCurrency: "USD", rates };
    const car = recommendGoalFunding({ goalId: "car", amount: 300 }, goalPool, fundingOptions);
    eq("only accounts with room to spare get a funding row", car.draws.map((d) => d.accountId).join(","), "popular,bsc");
    eq(
      "each account's recommended draw is proportional to its headroom, in its own currency",
      car.draws.map((d) => `${d.accountId}:${d.recommendedAmount}`).join(","),
      "popular:13500,bsc:75",
    );
    eq("the shares explain the split: 75% of the room is in Popular", round2(car.draws[0].share * 100), 75);
    eq("the draws sum to the goal's amount in the display currency", car.recommendedTotal, 300);
    eq("no shortfall when the room covers the goal", car.shortfall, 0);

    const house = recommendGoalFunding({ goalId: "house", amount: 1000 }, goalPool, fundingOptions);
    eq(
      "a goal bigger than all the room takes every account's full headroom and no more",
      house.draws.map((d) => `${d.accountId}:${d.recommendedAmount}`).join(","),
      "popular:27000,bsc:150",
    );
    eq("what the room could not cover is reported as a shortfall, not quietly dropped", house.shortfall, 400);
    eq("the recommended total is what the room could cover", house.recommendedTotal, 600);

    const thirds = recommendGoalFunding(
      { goalId: "thirds", amount: 100 },
      [
        { accountId: "a", name: "A", currency: "USD", headroom: 100 },
        { accountId: "b", name: "B", currency: "USD", headroom: 100 },
        { accountId: "c", name: "C", currency: "USD", headroom: 100 },
      ],
      fundingOptions,
    );
    eq("rounding never loses a cent: the residual lands on one account", thirds.draws.map((d) => d.recommendedAmount).join(","), "33.34,33.33,33.33");
    eq("and the rounded draws still sum to the goal exactly", thirds.recommendedTotal, 100);

    const nothing = recommendGoalFunding({ goalId: "nothing", amount: 0 }, goalPool, fundingOptions);
    eq("a goal needing nothing keeps its rows at zero", nothing.draws.map((d) => d.recommendedAmount).join(","), "0,0");
    const dry = recommendGoalFunding({ goalId: "dry", amount: 100 }, [goalPool[2]], fundingOptions);
    check("with no room anywhere there are no rows and the whole goal is the shortfall", dry.draws.length === 0 && dry.shortfall === 100 && dry.recommendedTotal === 0);

    // Two goals in one check-in: the first claims its share of the pool, and
    // the second is recommended only what the first left - never the same
    // headroom twice. After the car takes 225 USD of Popular and 75 of BSC,
    // 300 USD of room is left; a 400 USD trip takes all of it and is 100 short.
    const both = planGoalFunding(
      [
        { goalId: "car", amount: 300 },
        { goalId: "trip", amount: 400 },
      ],
      goalPool,
      fundingOptions,
    );
    eq("the first goal in draft order is recommended exactly as if it were alone", JSON.stringify(both[0].draws), JSON.stringify(car.draws));
    eq(
      "the second goal draws only from the headroom the first left unclaimed",
      both[1].draws.map((d) => `${d.accountId}:${d.recommendedAmount}`).join(","),
      "popular:13500,bsc:75",
    );
    eq("the second goal's rows show the room that was still free for it", both[1].draws.map((d) => d.headroom).join(","), "13500,75");
    eq("the second goal reports the shortfall the shared pool leaves it with", both[1].shortfall, 100);

    // What the user actually types for an earlier goal feeds the pool, live:
    // a held row counts at the user's figure and an unheld one at its own
    // recommendation. Zeroing the car's Popular row frees all 27,000 DOP for
    // the trip (525 USD of room now covers its 400), while holding it at every
    // peso leaves the trip only BSC's 75 USD.
    const freed = planGoalFunding(
      [
        {
          goalId: "car",
          amount: 300,
          funding: [
            { accountId: "popular", plannedAmount: 0, held: true },
            { accountId: "bsc", plannedAmount: 999, held: false },
            { accountId: "cash", plannedAmount: 500, held: true },
          ],
        },
        { goalId: "trip", amount: 400 },
      ],
      goalPool,
      fundingOptions,
    );
    eq("a goal's own recommendation ignores its edits: only the pool for later goals moves", JSON.stringify(freed[0].draws), JSON.stringify(car.draws));
    eq(
      "zeroing an earlier goal's row frees that room for the goals after it",
      freed[1].draws.map((d) => `${d.accountId}:${d.recommendedAmount}:${d.headroom}`).join(","),
      "popular:20571.6:27000,bsc:57.14:75",
    );
    eq("the later goal's rows show the room the edit left it", freed[1].draws.map((d) => d.headroom).join(","), "27000,75");
    eq("with the room freed the later goal is no longer short", `${freed[1].recommendedTotal}:${freed[1].shortfall}`, "400:0");
    const claimed = planGoalFunding(
      [
        { goalId: "car", amount: 300, funding: [{ accountId: "popular", plannedAmount: 27000, held: true }] },
        { goalId: "trip", amount: 400 },
      ],
      goalPool,
      fundingOptions,
    );
    eq(
      "raising an earlier goal's row above its recommendation takes that room from the goals after it",
      claimed[1].draws.map((d) => `${d.accountId}:${d.recommendedAmount}:${d.headroom}`).join(","),
      "popular:0:0,bsc:75:75",
    );
    eq("and the later goal's shortfall grows by what was taken", claimed[1].shortfall, 325);
    const restored = planGoalFunding(
      [
        { goalId: "car", amount: 300, funding: [{ accountId: "popular", plannedAmount: 13500, held: true }] },
        { goalId: "trip", amount: 400 },
      ],
      goalPool,
      fundingOptions,
    );
    eq("holding a row at its own recommendation leaves later goals exactly as before", JSON.stringify(restored[1]), JSON.stringify(both[1]));

    const exhausted = planGoalFunding(
      [
        { goalId: "first", amount: 150 },
        { goalId: "second", amount: 50 },
      ],
      [goalPool[1], goalPool[2]],
      fundingOptions,
    );
    eq(
      "an account an earlier goal used up keeps a zero row on later goals so it can still be funded by hand",
      exhausted[1].draws.map((d) => `${d.accountId}:${d.recommendedAmount}:${d.headroom}`).join(","),
      "bsc:0:0",
    );
    eq("a later goal with nothing left to draw on is entirely shortfall", exhausted[1].shortfall, 50);

    // What Step 3 shows: the recommendation per account, except where the user
    // has held a row at their own figure - and the goal's total is the rows'
    // sum in the display currency, never a figure of its own.
    const resolved = resolveGoalFunding(
      car,
      [
        { accountId: "bsc", plannedAmount: 20, held: true },
        { accountId: "popular", plannedAmount: 99, held: false },
        { accountId: "cash", plannedAmount: 500, held: true },
      ],
      fundingOptions,
    );
    eq(
      "a held row keeps the user's figure while an unheld one follows the live recommendation",
      resolved.rows.map((r) => `${r.accountId}:${r.plannedAmount}:${r.held}`).join(","),
      "popular:13500:false,bsc:20:true",
    );
    eq("a held figure for an account with no room now is neither shown nor counted", resolved.rows.length, 2);
    eq("the goal's total is the rows summed into the display currency", resolved.total, 245);
    eq("the recommendation's own figures ride along for the card's explanation", `${resolved.recommendedTotal}:${resolved.shortfall}`, "300:0");
  }

  const suggestions = [
    { id: "groceries", suggested: 6000 },
    { id: "dining", suggested: 3000 },
    { id: "shopping", suggested: 1000 },
  ];
  const fits = scaleFlexibleSuggestions(suggestions, 20000);
  eq("suggestions that already fit pass through unscaled", fits.map((s) => s.scaled).join(","), "6000,3000,1000");
  const scaled = scaleFlexibleSuggestions(suggestions, 5000);
  eq("over-budget suggestions scale down proportionally", scaled.map((s) => s.scaled).join(","), "3000,1500,500");
  const deficit = scaleFlexibleSuggestions(suggestions, -500);
  eq("a deficit scales every suggestion to zero, never negative", deficit.every((s) => s.scaled === 0), true);

  {
    // The rounding gap: each row rounded on its own summed to 18,000.01 at
    // 18,000 available (a real Step 4 plan on 2026-09-15), and a plan that
    // only followed the suggestions was flagged as over-allocated by a cent.
    // The largest row absorbs the difference, exactly as seedGoalFunding
    // reconciles a goal's per-account split.
    const centGap = [
      { id: "bills", suggested: 8333.33 },
      { id: "dining", suggested: 5223.52 },
      { id: "entertainment", suggested: 3000 },
      { id: "groceries", suggested: 4000 },
      { id: "other", suggested: 0 },
      { id: "shopping", suggested: 7089.67 },
      { id: "transport", suggested: 0 },
    ];
    const reconciled = scaleFlexibleSuggestions(centGap, 18000);
    eq(
      "independently rounded scaled rows are reconciled so they sum to exactly the available amount",
      round2(reconciled.reduce((sum, s) => sum + s.scaled, 0)),
      18000,
    );
    eq(
      "only the largest row absorbs the rounding difference; every other row keeps its own rounded share",
      reconciled.map((s) => s.scaled).join(","),
      "5425.63,3400.91,1953.23,2604.31,0,4615.92,0",
    );
    eq(
      "suggestions that fit comfortably still pass through unscaled and unchanged",
      scaleFlexibleSuggestions(centGap, 40500).map((s) => s.scaled).join(","),
      "8333.33,5223.52,3000,4000,0,7089.67,0",
    );
    const sameTotal = [
      { id: "a", suggested: 0.1 },
      { id: "b", suggested: 0.1 },
      { id: "c", suggested: 0.1 },
    ];
    eq(
      "with equally large rows the first one absorbs the rounding difference, as seedGoalFunding picks its largest share",
      scaleFlexibleSuggestions(sameTotal, 0.2).map((s) => s.scaled).join(","),
      "0.06,0.07,0.07",
    );
  }

  {
    // The wizard's Step 4 rows: the draft carries each category's raw
    // suggestion, and the dialog resolves them against the live `available`
    // figure exactly as it resolves goal funding - an unedited row follows
    // the scaled suggestion, a held row keeps the user's figure.
    const flexibleRows = [
      { categoryId: "groceries", suggestedAmount: 6000, plannedAmount: 6000, held: false },
      { categoryId: "dining", suggestedAmount: 3000, plannedAmount: 3000, held: false },
      { categoryId: "shopping", suggestedAmount: 1000, plannedAmount: 250, held: true },
    ];
    const describe = (rows: { suggestedAmount: number; plannedAmount: number }[]) =>
      rows.map((r) => `${r.suggestedAmount}:${r.plannedAmount}`).join(",");
    eq(
      "unheld flexible rows plan the live suggestion when it fits; a held row keeps the user's figure",
      describe(resolveFlexibleCategories(flexibleRows, 20000)),
      "6000:6000,3000:3000,1000:250",
    );
    eq(
      "a scaled-down suggestion carries into each unheld row's planned amount",
      describe(resolveFlexibleCategories(flexibleRows, 5000)),
      "3000:3000,1500:1500,500:250",
    );
    eq(
      "before any income is entered every suggestion resolves to 0 and unheld rows plan 0 - held rows still stay put",
      describe(resolveFlexibleCategories(flexibleRows, 0)),
      "0:0,0:0,0:250",
    );
    eq(
      "resolving keeps the rows' other fields (id, held) and never mutates the raw draft",
      `${resolveFlexibleCategories(flexibleRows, 0).map((r) => `${r.categoryId}:${r.held}`).join(",")}|${flexibleRows[0].suggestedAmount}`,
      "groceries:false,dining:false,shopping:true|6000",
    );
  }

  console.log("\n== account archive lifecycle ==");
  const { archiveAccount, restoreAccount, deleteAccountIfSafe, getAccountLedger, setOpeningBalance, correctStartingBalance } =
    await import("../src/lib/data/accounts");
  const archiveTestAccount = await prisma.account.create({
    data: { name: "Verify Archive Me", currency: "USD", type: "CHECKING" },
  });
  let activeList = await getAccountBalances(context);
  check(
    "a fresh account is active by default and appears in the active list",
    activeList.some((a) => a.id === archiveTestAccount.id),
  );

  // archiveAccountAction/restoreAccountAction/deleteAccountAction (in
  // src/server/actions/accounts.ts) are "use server" actions gated by
  // requireAuth() -> next/headers' cookies(), which Next.js throws for
  // ("... called outside a request scope") whenever there's no live HTTP
  // request being handled by the Next.js server - confirmed this isn't
  // specific to this task's new actions by probing the pre-existing,
  // unmodified saveAccountAction the same way. There's no supported way to
  // satisfy that from a plain tsx script, so the guard/transition rules live
  // in plain, non-"use server" functions here in src/lib/data/accounts.ts
  // (archiveAccount/restoreAccount/deleteAccountIfSafe) that the actions
  // delegate to. The checks below call those real functions directly, so
  // this still exercises the actual guard logic end to end - only the
  // requireAuth-gated RPC wrapper itself goes unexercised by this script.
  await archiveAccount(archiveTestAccount.id);
  activeList = await getAccountBalances(context);
  check(
    "an archived account disappears from the active list",
    !activeList.some((a) => a.id === archiveTestAccount.id),
  );
  const archivedList = await getAccountBalances(context, { status: "ARCHIVED" });
  check(
    "the archived account still appears in the archived list",
    archivedList.some((a) => a.id === archiveTestAccount.id),
  );

  await prisma.transaction.create({
    data: {
      date: context.today,
      amount: 25,
      currency: "USD",
      type: "EXPENSE",
      accountId: archiveTestAccount.id,
      source: "MANUAL",
    },
  });
  const archivedLedger = await getAccountLedger(archiveTestAccount.id, context);
  eq(
    "an archived account's transactions and balance stay fully readable",
    archivedLedger?.rows.length,
    1,
  );

  const { deleteAccountAction, restoreAccountAction, archiveAccountAction } = await import(
    "../src/server/actions/accounts"
  );
  check(
    "archiveAccountAction, restoreAccountAction, and deleteAccountAction are exported",
    typeof archiveAccountAction === "function" &&
      typeof restoreAccountAction === "function" &&
      typeof deleteAccountAction === "function",
  );

  const blockedDelete = await deleteAccountIfSafe(archiveTestAccount.id);
  check(
    "permanent delete is blocked while transaction history exists",
    blockedDelete.ok === false,
  );
  const stillThere = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  check("the blocked account was not deleted", Boolean(stillThere));

  await restoreAccount(archiveTestAccount.id);
  const restored = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  eq("restore sets status back to ACTIVE", restored?.status, "ACTIVE");
  eq("restore clears archivedAt", restored?.archivedAt, null);

  await prisma.transaction.deleteMany({ where: { accountId: archiveTestAccount.id } });
  const cleanDelete = await deleteAccountIfSafe(archiveTestAccount.id);
  check("permanent delete succeeds once no history remains", cleanDelete.ok === true);
  const gone = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  check("the account is actually gone", gone === null);

  console.log("\n== opening balance ==");
  const openingBalanceAccount = await prisma.account.create({
    data: { name: "Verify Opening Balance", currency: "DOP", type: "CHECKING" },
  });

  const setResult = await setOpeningBalance(openingBalanceAccount.id, 4061.02, context.today);
  check("setting an opening balance on a fresh account succeeds", setResult.ok === true);

  let obBalances = await getAccountBalances(context, { status: "ALL" });
  let obBalance = obBalances.find((a) => a.id === openingBalanceAccount.id)!;
  eq("an opening balance raises the account's ledger balance", obBalance.balance, 4061.02);

  const summaryWithOpeningBalance = await getPeriodSummary(context.currentPeriod, context);
  check(
    "an opening balance is never counted as income",
    summaryWithOpeningBalance.income === summary.income,
  );
  check(
    "an opening balance is never counted as spending or budget activity",
    summaryWithOpeningBalance.spent === summary.spent,
  );

  const replaceResult = await setOpeningBalance(openingBalanceAccount.id, 5000, context.today);
  check("setting the opening balance again succeeds", replaceResult.ok === true);
  const openingBalanceRowCount = await prisma.transaction.count({
    where: { accountId: openingBalanceAccount.id, type: "OPENING_BALANCE" },
  });
  eq(
    "setting an opening balance again updates the existing row instead of duplicating it",
    openingBalanceRowCount,
    1,
  );
  obBalances = await getAccountBalances(context, { status: "ALL" });
  obBalance = obBalances.find((a) => a.id === openingBalanceAccount.id)!;
  eq("the replaced opening balance is reflected in the ledger balance", obBalance.balance, 5000);

  await prisma.transaction.create({
    data: {
      date: context.today,
      amount: 10,
      currency: "DOP",
      type: "EXPENSE",
      accountId: openingBalanceAccount.id,
      source: "MANUAL",
    },
  });
  const blockedOpeningBalance = await setOpeningBalance(openingBalanceAccount.id, 1, context.today);
  check(
    "an account with ordinary transaction history can no longer have its opening balance set",
    blockedOpeningBalance.ok === false && blockedOpeningBalance.reason === "has_history",
  );

  // The guided correction for exactly that state: an incoming external
  // transfer dated at the start, which raises the balance like an opening
  // balance without ever counting as income or spending.
  {
    const balanceBeforeCorrection = (await getAccountBalances(context, { status: "ALL" })).find((a) => a.id === openingBalanceAccount.id)!.balance;
    const corrected = await correctStartingBalance(openingBalanceAccount.id, 250, civilDate(2026, 1, 1), "Verify starting balance correction");
    check("the starting balance correction is recorded", corrected.ok);
    if (!corrected.ok) throw new Error("correctStartingBalance refused the fixture");
    const correctionRow = await prisma.transaction.findUniqueOrThrow({ where: { id: corrected.transactionId } });
    eq("it is a real incoming EXTERNAL_TRANSFER in the account's currency, not an opening balance", `${correctionRow.type}:${correctionRow.transferDirection}:${correctionRow.currency}:${correctionRow.source}:${num(correctionRow.amount)}:${toISODate(correctionRow.date)}`, "EXTERNAL_TRANSFER:IN:DOP:MANUAL:250:2026-01-01");
    eq("it carries the note the action passes in", correctionRow.note, "Verify starting balance correction");
    const balanceAfterCorrection = (await getAccountBalances(context, { status: "ALL" })).find((a) => a.id === openingBalanceAccount.id)!.balance;
    eq("the account's balance rises by exactly the amount entered", round2(balanceAfterCorrection - balanceBeforeCorrection), 250);
    eq("it never counts as income or spending", isCashflow(correctionRow.type), false);
    eq("it raises the balance with the same sign as an opening balance", balanceSign(correctionRow.type, correctionRow.transferDirection), balanceSign("OPENING_BALANCE", null));
    eq("the opening balance itself stays locked afterwards", (await setOpeningBalance(openingBalanceAccount.id, 1, context.today) as { ok: boolean; reason?: string }).reason, "has_history");
    eq("a missing account is reported", (await correctStartingBalance("missing", 1, context.today, "x") as { ok: boolean; reason?: string }).reason, "not_found");
    await prisma.transaction.delete({ where: { id: corrected.transactionId } });
  }

  const obCheckin = await prisma.paydayCheckin.create({
    data: { year: 2099, month: 1, period: "A", checkinDate: context.today, currency: "DOP", status: "CONFIRMED" },
  });
  await prisma.paydayAccountSnapshot.create({
    data: {
      paydayCheckinId: obCheckin.id,
      accountId: openingBalanceAccount.id,
      expectedLedgerBalance: 4990,
      reportedBalance: 9999,
      difference: 9999 - 4990,
      currency: "DOP",
    },
  });
  const obBalancesAfterSnapshot = await getAccountBalances(context, { status: "ALL" });
  const obBalanceAfterSnapshot = obBalancesAfterSnapshot.find((a) => a.id === openingBalanceAccount.id)!;
  eq(
    "a payday reconciliation snapshot never mutates the opening-balance-derived ledger balance",
    obBalanceAfterSnapshot.balance,
    4990,
  );

  await prisma.paydayAccountSnapshot.deleteMany({ where: { paydayCheckinId: obCheckin.id } });
  await prisma.paydayCheckin.delete({ where: { id: obCheckin.id } });
  await prisma.transaction.deleteMany({ where: { accountId: openingBalanceAccount.id } });
  await prisma.account.delete({ where: { id: openingBalanceAccount.id } });

  console.log("\n== payday check-in (database) ==");
  const { getPaydayCheckinDraft, confirmPaydayCheckin, getCategorySuggestions, checkinDateForNewCheckin, planPeriodRef, goalRoadmapAmount, getGoalRoadmapAmount } = await import(
    "../src/lib/data/payday"
  );
  const { getSettings } = await import("../src/lib/auth");

  const paydaySettings = await getSettings();
  const paydayContext = {
    displayCurrency: "USD" as const,
    language: "en" as const,
    rates,
    // Aug 15 2026 is a Saturday, so this period's payday is the Friday before
    // it - that is the day the check-in opens and plans the next period.
    today: civilDate(2026, 8, 14),
    currentPeriod: periodForDate(civilDate(2026, 8, 14)),
    bufferPercent: paydaySettings.bufferPercent,
    bufferFloorAmount: num(paydaySettings.bufferFloorAmount),
    bufferFloorCurrency: paydaySettings.bufferFloorCurrency,
  };

  const paydayChecking = await prisma.account.create({
    data: { name: "Verify Payday Checking", currency: "USD", type: "CHECKING" },
  });
  const paydayEuro = await prisma.account.create({
    data: { name: "Verify Payday Euro", currency: "EUR", type: "CHECKING" },
  });
  await prisma.transaction.createMany({
    data: [
      { date: civilDate(2026, 8, 1), amount: 1000, currency: "USD", type: "INCOME", accountId: paydayChecking.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 5), amount: 200, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 2), amount: 100, currency: "EUR", type: "INCOME", accountId: paydayEuro.id, source: "MANUAL" },
    ],
  });

  const billsCategory = await prisma.category.findFirstOrThrow({ where: { name: "Bills" } });
  await prisma.category.update({ where: { id: billsCategory.id }, data: { isEssentialFixed: true } });
  const groceriesForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
  const subsCategoryForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Subscriptions" } });
  const savingsCategoryForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Savings/Investment" } });

  const paydaySub = await prisma.recurringItem.create({
    data: { name: "Verify Payday Netflix", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 20), active: true, categoryId: subsCategoryForPayday.id, accountId: paydayChecking.id },
  });
  const paydayContribution = await prisma.recurringItem.create({
    data: { name: "Verify Payday Auto-Invest", amount: 100, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 20), active: true },
  });

  const datedGoal = await prisma.goal.create({
    data: { name: "Verify Payday Dated Goal", targetAmount: 1000, currency: "USD", targetDate: civilDate(2026, 10, 15) },
  });

  console.log("\n-- draft assembly --");
  const draft = await getPaydayCheckinDraft(paydayContext);
  eq(
    "opened exactly on a payday, the plan targets the next period, not the one ending today",
    `${draft.periodRef.year}-${draft.periodRef.month}-${draft.periodRef.period}`,
    "2026-8-B",
  );
  check(
    "dynamic active accounts include a newly created account",
    draft.accounts.some((a) => a.accountId === paydayChecking.id),
  );
  eq(
    "the draft's ledger balance is transaction-derived, matching getAccountBalances",
    draft.accounts.find((a) => a.accountId === paydayChecking.id)?.expectedLedgerBalance,
    800,
  );
  check(
    "a subscription due in the plan period is reserved separately from contributions",
    draft.subscriptions.some((s) => s.recurringItemId === paydaySub.id) &&
      !draft.contributions.some((c) => c.recurringItemId === paydaySub.id),
  );
  check(
    "a recurring contribution due in the plan period is reserved separately from subscriptions",
    draft.contributions.some((c) => c.recurringItemId === paydayContribution.id) &&
      !draft.subscriptions.some((s) => s.recurringItemId === paydayContribution.id),
  );
  check("the dated goal is reserved in the draft", draft.goals.some((g) => g.goalId === datedGoal.id));
  check(
    "a category marked essential fixed appears in essentialCategories, not flexibleCategories",
    draft.essentialCategories.some((c) => c.categoryId === billsCategory.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === billsCategory.id),
  );
  check(
    "the Subscriptions category is never offered as an essential or flexible suggestion",
    !draft.essentialCategories.some((c) => c.categoryId === subsCategoryForPayday.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === subsCategoryForPayday.id),
  );
  check(
    "the Savings/Investment category is never offered as an essential or flexible suggestion",
    !draft.essentialCategories.some((c) => c.categoryId === savingsCategoryForPayday.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === savingsCategoryForPayday.id),
  );
  check(
    "a non-essential expense category appears as a flexible suggestion",
    draft.flexibleCategories.some((c) => c.categoryId === groceriesForPayday.id),
  );

  eq(
    "a subscription draft carries the account funding it, so Step 3 can group by account",
    draft.subscriptions.find((s) => s.recurringItemId === paydaySub.id)?.accountId,
    paydayChecking.id,
  );
  eq(
    "each account draft carries the buffer floor converted into that account's own currency",
    draft.accounts.find((a) => a.accountId === paydayEuro.id)?.bufferFloor,
    round2(convert(num(paydaySettings.bufferFloorAmount), paydaySettings.bufferFloorCurrency, "EUR", rates)),
  );

  await prisma.account.update({
    where: { id: paydayEuro.id },
    data: { status: "ARCHIVED", archivedAt: paydayContext.today },
  });
  const draftAfterArchive = await getPaydayCheckinDraft(paydayContext);
  check(
    "archiving an account removes it from the next check-in's active list",
    !draftAfterArchive.accounts.some((a) => a.accountId === paydayEuro.id),
  );
  await prisma.account.update({ where: { id: paydayEuro.id }, data: { status: "ACTIVE", archivedAt: null } });

  console.log("\n-- already-logged subscriptions are excluded from the reserved total, but still listed --");
  const dedupSub = await prisma.recurringItem.create({
    data: { name: "Verify Payday Spotify", amount: 12, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 22), active: true, categoryId: subsCategoryForPayday.id },
  });
  const dedupTransaction = await prisma.transaction.create({
    data: { date: civilDate(2026, 8, 18), amount: 12, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Spotify", source: "MANUAL" },
  });
  const draftWithDedup = await getPaydayCheckinDraft(paydayContext);
  const dedupItem = draftWithDedup.subscriptions.find((s) => s.recurringItemId === dedupSub.id);
  check(
    "an already-logged subscription still appears in the list, flagged as already logged",
    Boolean(dedupItem) && dedupItem!.alreadyLogged === true,
  );
  const stillDueItem = draftWithDedup.subscriptions.find((s) => s.recurringItemId === paydaySub.id);
  check(
    "a still-due subscription in the same draft is not flagged as already logged",
    Boolean(stillDueItem) && stillDueItem!.alreadyLogged === false,
  );
  eq(
    "the already-logged item is excluded from subscriptionsTotal - only the still-due Netflix item counts",
    draftWithDedup.subscriptionsTotal,
    15,
  );
  await prisma.transaction.delete({ where: { id: dedupTransaction.id } });
  await prisma.recurringItem.delete({ where: { id: dedupSub.id } });

  console.log("\n-- already-logged is counted per occurrence, not per item --");
  {
    const { loggedOccurrencesByItem } = await import("../src/lib/data/payday");
    const { planAccountBuffers: planBuffers } = await import("../src/lib/payday");
    // The plan period is Aug 16-31; a weekly item next due on the 20th owes the
    // 20th and the 27th, so two occurrences of 9 each.
    const weeklySub = await prisma.recurringItem.create({
      data: { name: "Verify Payday Weekly", amount: 9, currency: "USD", frequency: "WEEKLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 20), anchorDay: 20, active: true, categoryId: subsCategoryForPayday.id, accountId: paydayChecking.id },
    });
    // Posting's own output for an occurrence already rolled past: a candidate
    // for nothing, whatever its amount and note say.
    const weeklyPosted = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 17), amount: 9, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Weekly", source: "RECURRING", externalId: `${weeklySub.id}:2026-08-17` },
    });
    const weeklyNone = (await getPaydayCheckinDraft(paydayContext)).subscriptions.find((s) => s.recurringItemId === weeklySub.id);
    eq("a weekly item owes both of its occurrences in the plan period", weeklyNone?.occurrenceCount, 2);
    eq(
      "a RECURRING row of the item's own is never taken as a logged charge",
      `${weeklyNone?.loggedOccurrences}:${weeklyNone?.outstandingAmount}:${weeklyNone?.alreadyLogged}`,
      "0:18:false",
    );

    const weeklyManualOne = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 18), amount: 9, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Weekly", source: "MANUAL" },
    });
    const draftOneLogged = await getPaydayCheckinDraft(paydayContext);
    const weeklyOne = draftOneLogged.subscriptions.find((s) => s.recurringItemId === weeklySub.id);
    eq(
      "one logged charge covers one occurrence: the other still counts, and the item is not flagged as already paid",
      `${weeklyOne?.loggedOccurrences}:${weeklyOne?.outstandingAmount}:${weeklyOne?.outstandingNativeAmount}:${weeklyOne?.alreadyLogged}`,
      "1:9:9:false",
    );
    eq(
      "subscriptionsTotal reserves the still-unposted occurrence (9) on top of the monthly Netflix item (15)",
      draftOneLogged.subscriptionsTotal,
      24,
    );
    const bufferOneLogged = planBuffers(
      [{ accountId: paydayChecking.id, name: paydayChecking.name, currency: "USD", income: 1000, bufferFloor: 100 }],
      draftOneLogged.subscriptions.map((s) => ({
        recurringItemId: s.recurringItemId,
        accountId: s.accountId,
        nativeAmount: s.outstandingNativeAmount,
        currency: s.currency,
        alreadyLogged: s.alreadyLogged,
      })),
      { bufferPercent: 10, displayCurrency: "USD", rates },
    );
    eq(
      "the per-account buffer counts the one still-unposted occurrence against the account, not zero and not both",
      bufferOneLogged.accounts.find((a) => a.accountId === paydayChecking.id)?.subscriptionsTotal,
      24,
    );

    const weeklyManualTwo = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 19), amount: 9, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Weekly", source: "MANUAL" },
    });
    const weeklyManualThree = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 21), amount: 9, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Weekly", source: "MANUAL" },
    });
    const draftAllLogged = await getPaydayCheckinDraft(paydayContext);
    const weeklyAll = draftAllLogged.subscriptions.find((s) => s.recurringItemId === weeklySub.id);
    eq(
      "with both occurrences logged the item is fully covered; a third charge cannot log more than is owed",
      `${weeklyAll?.loggedOccurrences}:${weeklyAll?.outstandingAmount}:${weeklyAll?.alreadyLogged}`,
      "2:0:true",
    );
    eq("a fully covered weekly item drops out of subscriptionsTotal entirely", draftAllLogged.subscriptionsTotal, 15);

    eq(
      "the shared helper caps logged occurrences at what the item still owes",
      JSON.stringify([...loggedOccurrencesByItem(
        [{ id: "w", occurrenceCount: 2 }, { id: "m", occurrenceCount: 1 }, { id: "none", occurrenceCount: 1 }],
        new Map([["w", 5], ["m", 1]]),
      ).entries()]),
      JSON.stringify([["w", 2], ["m", 1], ["none", 0]]),
    );

    await prisma.transaction.deleteMany({
      where: { id: { in: [weeklyPosted.id, weeklyManualOne.id, weeklyManualTwo.id, weeklyManualThree.id] } },
    });
    await prisma.recurringItem.delete({ where: { id: weeklySub.id } });

    // A monthly item owes one occurrence, so one logged charge covers it
    // completely - exactly the per-item verdict it had before.
    const netflixManual = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 21), amount: 15, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, categoryId: subsCategoryForPayday.id, note: "Verify Payday Netflix", source: "MANUAL" },
    });
    const draftMonthlyLogged = await getPaydayCheckinDraft(paydayContext);
    const netflixLogged = draftMonthlyLogged.subscriptions.find((s) => s.recurringItemId === paydaySub.id);
    eq(
      "a monthly item with its one charge logged is fully covered, flagged as already paid, and reserves nothing",
      `${netflixLogged?.occurrenceCount}:${netflixLogged?.loggedOccurrences}:${netflixLogged?.outstandingAmount}:${netflixLogged?.alreadyLogged}:${draftMonthlyLogged.subscriptionsTotal}`,
      "1:1:0:true:0",
    );
    await prisma.transaction.delete({ where: { id: netflixManual.id } });
  }

  console.log("\n-- budgets already set for the plan period seed the planned amounts --");
  // The "database invariants" section above already created this period's
  // Groceries budget; point it at a distinctive amount for this check and put
  // it back afterwards.
  const preExistingBudget = await prisma.budget.findFirstOrThrow({
    where: { year: 2026, month: 8, period: "B", categoryId: groceriesForPayday.id },
  });
  await prisma.budget.update({ where: { id: preExistingBudget.id }, data: { amount: 77, currency: "USD" } });
  const draftWithExistingBudget = await getPaydayCheckinDraft(paydayContext);
  const seededGroceries = draftWithExistingBudget.flexibleCategories.find((c) => c.categoryId === groceriesForPayday.id);
  eq(
    "a budget the user already set for the plan period pre-fills that category's planned amount instead of being silently overwritten",
    seededGroceries?.plannedAmount,
    77,
  );
  eq("the fresh suggestion is still shown separately (no history here, so 0)", seededGroceries?.suggestedAmount, 0);
  const draftWithExistingBudgetInEur = await getPaydayCheckinDraft({ ...paydayContext, displayCurrency: "EUR" as const });
  eq(
    "an existing budget in another currency is converted into the display currency",
    draftWithExistingBudgetInEur.flexibleCategories.find((c) => c.categoryId === groceriesForPayday.id)?.plannedAmount,
    round2(convert(77, "USD", "EUR", rates)),
  );
  await prisma.budget.update({
    where: { id: preExistingBudget.id },
    data: { amount: preExistingBudget.amount, currency: preExistingBudget.currency },
  });

  console.log("\n-- smart flexible-category budget recommendations --");
  {
    const diningCat = await prisma.category.findFirstOrThrow({ where: { name: "Dining" } });
    const transportCat = await prisma.category.findFirstOrThrow({ where: { name: "Transport" } });
    const entertainmentCat = await prisma.category.findFirstOrThrow({ where: { name: "Entertainment" } });
    const shoppingCat = await prisma.category.findFirstOrThrow({ where: { name: "Shopping" } });
    const recCategories = [diningCat, transportCat, entertainmentCat, shoppingCat].map((c) => ({ id: c.id }));

    // planRef for this section's draft is 2026-08-B; the comparable prior
    // period (same half-of-month, one cycle back) is 2026-07-B, not the
    // opposite-half 2026-08-A that a plain previousPeriod() step would land on.
    eq(
      "previousComparablePeriod lands on the same half one month back, not the opposite half",
      JSON.stringify(previousComparablePeriod({ year: 2026, month: 8, period: "B" })),
      JSON.stringify({ year: 2026, month: 7, period: "B" }),
    );

    const recHistoryAccount = await prisma.account.create({
      data: { name: "Verify Payday History", currency: "USD", type: "CHECKING" },
    });

    // Priority 1: a budget in the most recent comparable period wins outright,
    // even though this same category also has spending history in the
    // lookback window - history must never blend with or override a match.
    const comparableDiningBudget = await prisma.budget.create({
      data: { year: 2026, month: 7, period: "B", categoryId: diningCat.id, amount: 150, currency: "USD" },
    });
    // Priority 2: Transport has no comparable-period budget, only categorized
    // spending across two of the six same-half lookback periods.
    await prisma.transaction.createMany({
      data: [
        { date: civilDate(2026, 7, 20), amount: 80, currency: "USD", type: "EXPENSE", accountId: recHistoryAccount.id, categoryId: transportCat.id, source: "MANUAL" },
        { date: civilDate(2026, 5, 20), amount: 100, currency: "USD", type: "EXPENSE", accountId: recHistoryAccount.id, categoryId: transportCat.id, source: "MANUAL" },
        { date: civilDate(2026, 7, 20), amount: 500, currency: "USD", type: "EXPENSE", accountId: recHistoryAccount.id, categoryId: null, source: "MANUAL" },
      ],
    });
    // Also give Dining spending history, to prove the budget match still wins.
    await prisma.transaction.create({
      data: { date: civilDate(2026, 6, 20), amount: 40, currency: "USD", type: "EXPENSE", accountId: recHistoryAccount.id, categoryId: diningCat.id, source: "MANUAL" },
    });

    const txCountBefore = await prisma.transaction.count();
    const goalContributionCountBefore = await prisma.goalContribution.count();

    const suggestions = await getCategorySuggestions(draft.periodRef, recCategories, paydayContext);

    check(
      "recommendation generation never creates transactions or goal contributions",
      (await prisma.transaction.count()) === txCountBefore &&
        (await prisma.goalContribution.count()) === goalContributionCountBefore,
    );

    eq(
      "most recent comparable budget is used when available (priority 1)",
      JSON.stringify(suggestions.get(diningCat.id)),
      JSON.stringify({ amount: 150, basis: "last_budget" }),
    );
    eq(
      "same category with no comparable budget falls back to categorized spending history (priority 2)",
      JSON.stringify(suggestions.get(transportCat.id)),
      JSON.stringify({ amount: 60, basis: "average" }), // (80 + 100) / the 3 comparable periods since this category first had spending
    );
    eq(
      "no useful history produces zero (priority 3/4), never a fabricated guess",
      JSON.stringify(suggestions.get(entertainmentCat.id)),
      JSON.stringify({ amount: 0, basis: "none" }),
    );
    eq(
      "an uncategorized transaction in the same window does not leak into an unrelated category's recommendation",
      JSON.stringify(suggestions.get(shoppingCat.id)),
      JSON.stringify({ amount: 0, basis: "none" }),
    );
    check(
      "recommendations are generated independently per category, not one shared figure",
      suggestions.get(diningCat.id)?.amount !== suggestions.get(transportCat.id)?.amount,
    );

    const periodASuggestions = await getCategorySuggestions(
      { year: 2026, month: 8, period: "A" },
      [{ id: diningCat.id }],
      paydayContext,
    );
    eq(
      "same-half matching: a Period A plan does not pick up the Period B comparable-period budget",
      JSON.stringify(periodASuggestions.get(diningCat.id)),
      JSON.stringify({ amount: 0, basis: "none" }),
    );

    // Settings.incomeHistoryStartDate bounds this walk exactly as it bounds
    // Afford's: a comparable period that ended before it is not walked, and
    // the average runs over the periods left from the oldest with spending.
    const suggestFrom = (incomeHistoryStartDate: Date | null) =>
      getCategorySuggestions(draft.periodRef, recCategories, { ...paydayContext, incomeHistoryStartDate });
    eq(
      "a null start date changes nothing",
      JSON.stringify((await suggestFrom(null)).get(transportCat.id)),
      JSON.stringify({ amount: 60, basis: "average" }),
    );
    eq(
      "from June 1 the May 16-31 period is not walked: Transport averages its one remaining period with spending (80 / 1)",
      JSON.stringify((await suggestFrom(civilDate(2026, 6, 1))).get(transportCat.id)),
      JSON.stringify({ amount: 80, basis: "average" }),
    );
    eq(
      "a period ending on the start date still counts: from May 31 the walk is Jul, Jun and May and the average is unchanged",
      JSON.stringify((await suggestFrom(civilDate(2026, 5, 31))).get(transportCat.id)),
      JSON.stringify({ amount: 60, basis: "average" }),
    );
    const fromAugust = await suggestFrom(civilDate(2026, 8, 1));
    eq(
      "a start date past every comparable period leaves no history to average",
      JSON.stringify(fromAugust.get(transportCat.id)),
      JSON.stringify({ amount: 0, basis: "none" }),
    );
    eq(
      "the comparable period's own budget is the user's figure, not history, so the boundary leaves it alone",
      JSON.stringify(fromAugust.get(diningCat.id)),
      JSON.stringify({ amount: 150, basis: "last_budget" }),
    );

    console.log("\n-- scaling flexible recommendations against available money --");
    const rawSuggestions = [
      { id: diningCat.id, suggested: suggestions.get(diningCat.id)!.amount },
      { id: transportCat.id, suggested: suggestions.get(transportCat.id)!.amount },
    ];
    const rawTotal = rawSuggestions.reduce((sum, s) => sum + s.suggested, 0);
    eq("raw recommendations total 210 before any scaling", rawTotal, 210);

    const comfortablyAvailable = scaleFlexibleSuggestions(rawSuggestions, 500);
    eq(
      "recommendations that already fit the available money pass through unscaled",
      JSON.stringify(comfortablyAvailable.map((s) => s.scaled)),
      JSON.stringify([150, 60]),
    );

    const tightlyAvailable = scaleFlexibleSuggestions(rawSuggestions, 90);
    const scaledTotal = tightlyAvailable.reduce((sum, s) => sum + s.scaled, 0);
    check("scaled recommendations never exceed available flexible money", scaledTotal <= 90);
    eq("proportional scaling: total lands exactly on the available amount here", scaledTotal, 90);
    const rawRatio = rawSuggestions[0].suggested / rawSuggestions[1].suggested;
    const scaledDining = tightlyAvailable.find((s) => s.id === diningCat.id)!.scaled;
    const scaledTransport = tightlyAvailable.find((s) => s.id === transportCat.id)!.scaled;
    // Scaled amounts are rounded to whole cents, so the ratio survives to within
    // that rounding rather than exactly.
    check(
      "proportional scaling preserves the relative ratio between categories",
      Math.abs(scaledDining / scaledTransport - rawRatio) < 0.01,
    );

    const negativeAvailable = scaleFlexibleSuggestions(rawSuggestions, -50);
    check(
      "negative available flexible money preserves the existing deficit behavior - every suggestion scales to zero, none negative",
      negativeAvailable.every((s) => s.scaled === 0),
    );

    // No income has been entered yet on this unconfirmed plan, so the draft
    // cannot know what is available: it carries the raw recommendation and
    // leaves the scaling to the wizard, which resolves every unheld row live
    // against the income Step 2 records (resolveFlexibleCategories). Scaling
    // here against the not-yet-known figure froze every suggestion at 0.
    const draftDuringDeficit = await getPaydayCheckinDraft(paydayContext);
    const draftDining = draftDuringDeficit.flexibleCategories.find((c) => c.categoryId === diningCat.id);
    eq(
      "wired end-to-end: the draft carries the raw last_budget recommendation unscaled, as an unheld row the wizard resolves live",
      JSON.stringify(draftDining && { basis: draftDining.basis, suggestedAmount: draftDining.suggestedAmount, plannedAmount: draftDining.plannedAmount, held: draftDining.held }),
      JSON.stringify({ basis: "last_budget", suggestedAmount: 150, plannedAmount: 150, held: false }),
    );

    await prisma.transaction.deleteMany({ where: { accountId: recHistoryAccount.id } });
    await prisma.account.delete({ where: { id: recHistoryAccount.id } });
    await prisma.budget.delete({ where: { id: comparableDiningBudget.id } });
    console.log("  ok   flexible-category recommendation fixtures removed");
  }

  console.log("\n-- confirming a plan --");
  const draftForConfirm = await getPaydayCheckinDraft(paydayContext);
  const initialPayload = {
    year: draftForConfirm.periodRef.year,
    month: draftForConfirm.periodRef.month,
    period: draftForConfirm.periodRef.period,
    accounts: draftForConfirm.accounts.map((a) => ({
      accountId: a.accountId,
      reportedBalance: a.expectedLedgerBalance + (a.accountId === paydayChecking.id ? 50 : 0),
      incomeEntered: a.accountId === paydayChecking.id ? 500 : 0,
      incomeNote: a.accountId === paydayChecking.id ? "Salary" : null,
    })),
    // The goal's roadmap amount, drawn from the checking account the income
    // above lands in - what the wizard's per-account rows would send.
    goals: draftForConfirm.goals.map((g) => ({
      goalId: g.goalId,
      funding: [{ accountId: paydayChecking.id, plannedAmount: g.recommendedAmount }],
    })),
    essentialCategories: draftForConfirm.essentialCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    flexibleCategories: draftForConfirm.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    includedCarryover: 0,
    acknowledgedDeficit: true,
    acknowledgedZeroBuffer: true,
  };

  const confirmResult = await confirmPaydayCheckin(initialPayload, paydayContext);
  check("confirming a payday check-in succeeds", confirmResult.ok === true);

  const checkinRow = await prisma.paydayCheckin.findFirst({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  check("exactly one confirmed PaydayCheckin row exists for the period", Boolean(checkinRow) && checkinRow!.status === "CONFIRMED");

  const checkingSnapshot = await prisma.paydayAccountSnapshot.findFirst({
    where: { paydayCheckinId: checkinRow!.id, accountId: paydayChecking.id },
  });
  eq("the snapshot stores the expected ledger balance for audit", num(checkingSnapshot!.expectedLedgerBalance), 800);
  eq("the snapshot stores the reported balance separately from the ledger balance", num(checkingSnapshot!.reportedBalance), 850);
  eq("the difference is reported minus expected - a diagnostic figure only", num(checkingSnapshot!.difference), 50);

  const balancesAfterConfirm = await getAccountBalances(paydayContext, { status: "ACTIVE" });
  const checkingBalanceAfterConfirm = balancesAfterConfirm.find((a) => a.id === paydayChecking.id)!;
  eq(
    "the reconciliation difference never changes the transaction-derived ledger balance - only the new income transaction does",
    checkingBalanceAfterConfirm.balance,
    1300,
  );

  const incomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  check("a confirmed check-in creates an INCOME transaction sourced as PAYDAY_CHECKIN", Boolean(incomeTransaction));
  eq("the income transaction amount matches what was entered", num(incomeTransaction!.amount), 500);
  eq(
    "the income transaction is dated with today's business date",
    toISODate(incomeTransaction!.date),
    toISODate(paydayContext.today),
  );

  const euroIncomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayEuro.id, source: "PAYDAY_CHECKIN" } });
  check("zero/blank income for an active account is valid and creates no income transaction", euroIncomeTransaction === null);

  const goalContributionsAfterConfirm = await prisma.goalContribution.count({ where: { goalId: datedGoal.id } });
  eq("confirming a plan never creates an actual GoalContribution row", goalContributionsAfterConfirm, 0);

  const subscriptionExpenseAfterConfirm = await prisma.transaction.count({
    where: { accountId: paydayChecking.id, type: "EXPENSE", note: { contains: "Netflix" } },
  });
  eq("confirming a plan never creates an actual expense transaction for a reserved subscription", subscriptionExpenseAfterConfirm, 0);

  const goalAllocations = await prisma.paydayPlanAllocation.findMany({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
  });
  const datedGoalDraft = draftForConfirm.goals.find((g) => g.goalId === datedGoal.id)!;
  eq("a goal's plan is one GOAL row per account it draws on, each stamped with its account", goalAllocations.map((a) => a.accountId).join(","), paydayChecking.id);
  check(
    "the goal's roadmap recommendation is recorded in the allocation audit trail, in the account's own currency",
    goalAllocations.length === 1 && num(goalAllocations[0].recommendedAmount) > 0 && goalAllocations[0].currency === "USD",
    JSON.stringify(goalAllocations.map((a) => ({ recommended: num(a.recommendedAmount), currency: a.currency }))),
  );
  eq("the draw the wizard sent for that account is stored as its planned amount", num(goalAllocations[0]?.plannedAmount), datedGoalDraft.recommendedAmount);

  console.log("\n-- reopening a confirmed check-in carries its goal funding rows --");
  const draftReopened = await getPaydayCheckinDraft(paydayContext);
  const reopenedGoal = draftReopened.goals.find((g) => g.goalId === datedGoal.id)!;
  eq(
    "the confirmed per-account draw comes back held, so it does not follow the live recommendation",
    JSON.stringify(reopenedGoal.funding),
    JSON.stringify([{ accountId: paydayChecking.id, plannedAmount: datedGoalDraft.recommendedAmount, held: true }]),
  );
  eq("the goal's total is the sum of its funding rows in the display currency", reopenedGoal.plannedAmount, datedGoalDraft.recommendedAmount);

  // A check-in confirmed before goal funding was per-account: one accountless
  // GOAL row in the check-in's currency. Still a valid row, never an error -
  // its total is spread over today's room and held.
  await prisma.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id } });
  await prisma.paydayPlanAllocation.create({
    data: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id, recommendedAmount: 250, plannedAmount: 40, currency: "USD", basis: "roadmap" },
  });
  const legacyGoal = (await getPaydayCheckinDraft(paydayContext)).goals.find((g) => g.goalId === datedGoal.id)!;
  eq(
    "an accountless GOAL row from before per-account funding is spread over the accounts with room today and held",
    JSON.stringify(legacyGoal.funding),
    JSON.stringify([{ accountId: paydayChecking.id, plannedAmount: 40, held: true }]),
  );
  eq("its confirmed total survives the upgrade", legacyGoal.plannedAmount, 40);
  eq("the roadmap figure is still recomputed live, not read back from the old row", legacyGoal.recommendedAmount, datedGoalDraft.recommendedAmount);

  console.log("\n-- the protected buffer is one recommendation per account with income --");
  const checkingBufferFloorInUsd = round2(
    convert(num(paydaySettings.bufferFloorAmount), paydaySettings.bufferFloorCurrency, "USD", rates),
  );
  const expectedCheckingBuffer = defaultProtectedBuffer(500, paydaySettings.bufferPercent, checkingBufferFloorInUsd);
  const bufferAllocations = await prisma.paydayPlanAllocation.findMany({
    where: { paydayCheckinId: checkinRow!.id, type: "BUFFER" },
  });
  eq("only an account that received income gets a buffer allocation", bufferAllocations.length, 1);
  eq("the buffer allocation is stamped with the account it protects", bufferAllocations[0]?.accountId, paydayChecking.id);
  eq("the buffer allocation is recorded in that account's own currency", bufferAllocations[0]?.currency, "USD");
  eq(
    "the buffer is that account's own income-based recommendation, not a share of the total",
    num(bufferAllocations[0]!.recommendedAmount),
    expectedCheckingBuffer,
  );
  eq(
    "PaydayCheckin.protectedBuffer stays a single figure - the per-account buffers summed into the check-in's currency",
    num(checkinRow!.protectedBuffer),
    expectedCheckingBuffer,
  );
  const subscriptionAllocation = await prisma.paydayPlanAllocation.findFirst({
    where: { paydayCheckinId: checkinRow!.id, type: "SUBSCRIPTION", recurringItemId: paydaySub.id },
  });
  eq(
    "a subscription allocation is stamped with the account its recurring item is funded from",
    subscriptionAllocation?.accountId,
    paydayChecking.id,
  );

  console.log("\n-- reassigning a subscription's account from the check-in --");
  const { setRecurringItemAccount, listRecurringItems } = await import("../src/lib/data/recurring");
  check("reassigning an existing item reports the write", (await setRecurringItemAccount(paydaySub.id, paydayEuro.id)) === true);
  const draftAfterReassign = await getPaydayCheckinDraft(paydayContext);
  eq(
    "the check-in draft immediately shows the subscription under its new account",
    draftAfterReassign.subscriptions.find((s) => s.recurringItemId === paydaySub.id)?.accountId,
    paydayEuro.id,
  );
  const recurringAfterReassign = await listRecurringItems(paydayContext);
  eq(
    "the Recurring page reads back the same row - one account field, not a plan-local override",
    recurringAfterReassign.subscriptions.find((r) => r.id === paydaySub.id)?.accountId,
    paydayEuro.id,
  );
  check(
    "reassigning an item that no longer exists reports no write instead of throwing",
    (await setRecurringItemAccount("verify-missing-recurring-item", paydayChecking.id)) === false,
  );
  await setRecurringItemAccount(paydaySub.id, paydayChecking.id);

  const essentialAndFlexibleIds = [
    ...draftForConfirm.essentialCategories.map((c) => c.categoryId),
    ...draftForConfirm.flexibleCategories.map((c) => c.categoryId),
  ];
  const budgetRowsAfterConfirm = await prisma.budget.count({
    where: {
      year: draftForConfirm.periodRef.year,
      month: draftForConfirm.periodRef.month,
      period: draftForConfirm.periodRef.period,
      categoryId: { in: essentialAndFlexibleIds },
    },
  });
  eq(
    "an essential/flexible category Budget row is created for every reserved category",
    budgetRowsAfterConfirm,
    essentialAndFlexibleIds.length,
  );

  console.log("\n-- revisiting a confirmed check-in --");
  const reconfirmedEssentialCategoryId = draftForConfirm.essentialCategories[0].categoryId;
  const reconfirmedFlexibleCategoryId = draftForConfirm.flexibleCategories[0].categoryId;
  const updatedPayload = {
    ...initialPayload,
    accounts: initialPayload.accounts.map((a) =>
      a.accountId === paydayChecking.id ? { ...a, incomeEntered: 750, incomeNote: "Salary + bonus" } : a,
    ),
    // Give the essential/flexible category and buffer overlays checked below something
    // non-zero to convert - the fresh suggestions for this scratch DB are 0.
    essentialCategories: initialPayload.essentialCategories.map((c) =>
      c.categoryId === reconfirmedEssentialCategoryId ? { ...c, plannedAmount: 20 } : c,
    ),
    flexibleCategories: initialPayload.flexibleCategories.map((c) =>
      c.categoryId === reconfirmedFlexibleCategoryId ? { ...c, plannedAmount: 45 } : c,
    ),
    // Also give includedCarryover something non-zero to convert below -
    // acknowledgedDeficit is already true, inherited from initialPayload.
    includedCarryover: 10,
  };
  const reconfirmResult = await confirmPaydayCheckin(updatedPayload, paydayContext);
  check("re-confirming the same period succeeds", reconfirmResult.ok === true);

  const checkinCountAfterReconfirm = await prisma.paydayCheckin.count({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  eq("re-confirming the same period never creates a second PaydayCheckin row", checkinCountAfterReconfirm, 1);

  const snapshotCountAfterReconfirm = await prisma.paydayAccountSnapshot.count({
    where: { paydayCheckinId: checkinRow!.id, accountId: paydayChecking.id },
  });
  eq("re-confirming never creates a duplicate snapshot for the same account", snapshotCountAfterReconfirm, 1);

  const incomeTransactionCountAfterReconfirm = await prisma.transaction.count({
    where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" },
  });
  eq("re-confirming updates the existing income transaction instead of creating another", incomeTransactionCountAfterReconfirm, 1);

  const updatedIncomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  eq("the updated income transaction reflects the newly entered amount", num(updatedIncomeTransaction!.amount), 750);

  console.log("\n-- a budget edited on the Budgets page after confirming wins over the stale allocation --");
  const confirmedFlexibleBudget = await prisma.budget.findFirstOrThrow({
    where: { year: 2026, month: 8, period: "B", categoryId: reconfirmedFlexibleCategoryId },
  });
  await prisma.budget.update({ where: { id: confirmedFlexibleBudget.id }, data: { amount: 60 } });
  const draftAfterManualEdit = await getPaydayCheckinDraft(paydayContext);
  eq(
    "reopening the plan shows the manually edited budget, not the amount confirmed earlier",
    draftAfterManualEdit.flexibleCategories.find((c) => c.categoryId === reconfirmedFlexibleCategoryId)?.plannedAmount,
    60,
  );
  eq(
    "a flexible row seeded from an existing budget comes back held, so it does not follow the live suggestion",
    draftAfterManualEdit.flexibleCategories.find((c) => c.categoryId === reconfirmedFlexibleCategoryId)?.held,
    true,
  );
  await prisma.budget.update({ where: { id: confirmedFlexibleBudget.id }, data: { amount: 45 } });

  console.log("\n-- reopening the confirmed check-in after the display currency changed converts, not just relabels --");
  const eurPaydayContext = { ...paydayContext, displayCurrency: "EUR" as const };
  const draftAfterCurrencySwitch = await getPaydayCheckinDraft(eurPaydayContext);
  eq(
    "the buffer is recomputed from each account's own income and summed into the newly selected display currency",
    draftAfterCurrencySwitch.plannedBuffer,
    round2(
      convert(
        defaultProtectedBuffer(750, paydaySettings.bufferPercent, checkingBufferFloorInUsd),
        "USD",
        "EUR",
        rates,
      ),
    ),
  );
  eq(
    "a stored essential category amount is converted from the currency it was confirmed in, not read back raw",
    draftAfterCurrencySwitch.essentialCategories.find((c) => c.categoryId === reconfirmedEssentialCategoryId)?.plannedAmount,
    round2(convert(20, "USD", "EUR", rates)),
  );
  eq(
    "a stored flexible category amount is converted from the currency it was confirmed in, not read back raw",
    draftAfterCurrencySwitch.flexibleCategories.find((c) => c.categoryId === reconfirmedFlexibleCategoryId)?.plannedAmount,
    round2(convert(45, "USD", "EUR", rates)),
  );
  // The prior period has no budget here, so the server measured no carryover at
  // all and clamped the 10 the payload asked for down to nothing before storing
  // it. The conversion path itself is covered by the category and goal checks
  // just above, which do have a stored amount to convert.
  eq(
    "a carryover the server did not measure is clamped away rather than persisted",
    draftAfterCurrencySwitch.includedCarryover,
    0,
  );
  const goalAfterCurrencySwitch = draftAfterCurrencySwitch.goals.find((g) => g.goalId === datedGoal.id);
  const goalBeforeCurrencySwitch = draftAfterManualEdit.goals.find((g) => g.goalId === datedGoal.id)!;
  eq(
    "a stored goal amount is converted from the currency it was confirmed in, not read back raw",
    goalAfterCurrencySwitch?.plannedAmount,
    round2(convert(goalBeforeCurrencySwitch.plannedAmount, "USD", "EUR", rates)),
  );
  eq(
    "the goal roadmap figure follows the display currency like every other planning value",
    goalAfterCurrencySwitch?.recommendedAmount,
    round2(convert(goalBeforeCurrencySwitch.recommendedAmount, "USD", "EUR", rates)),
  );
  const datedGoalRowAfterSwitch = await prisma.goal.findUniqueOrThrow({ where: { id: datedGoal.id } });
  check(
    "reopening a plan in another currency never rewrites the goal's stored currency",
    datedGoalRowAfterSwitch.currency === "USD" && num(datedGoalRowAfterSwitch.targetAmount) === 1000,
  );

  console.log("\n-- zeroing income removes the transaction, never leaves a stale one --");
  const zeroedPayload = {
    ...initialPayload,
    accounts: initialPayload.accounts.map((a) =>
      a.accountId === paydayChecking.id ? { ...a, incomeEntered: 0, incomeNote: null } : a,
    ),
  };
  await confirmPaydayCheckin(zeroedPayload, paydayContext);
  const incomeTransactionAfterZeroing = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  check("zeroing income on re-confirm removes the previously created income transaction", incomeTransactionAfterZeroing === null);

  console.log("\n-- deficit and zero-buffer acknowledgement gates --");
  const deficitPayload = {
    ...zeroedPayload,
    flexibleCategories: draftForConfirm.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount + 100000,
    })),
    acknowledgedDeficit: false,
  };
  const deficitResult = await confirmPaydayCheckin(deficitPayload, paydayContext);
  check("confirming an overallocated plan without acknowledging the deficit is rejected", deficitResult.ok === false && deficitResult.reason === "deficit_not_acknowledged");
  const deficitResultAcknowledged = await confirmPaydayCheckin({ ...deficitPayload, acknowledgedDeficit: true }, paydayContext);
  check("acknowledging the deficit allows the same overallocated plan through", deficitResultAcknowledged.ok === true);

  {
    // Confirm only ever scales flexible budgets down when a reconciliation
    // gap is capping the plan. Without one, an acknowledged over-allocation
    // is written exactly as typed - the behaviour every earlier check relies
    // on. With one, the written budgets are scaled proportionally (largest
    // row absorbing the rounding, as scaleFlexibleSuggestions does) so they
    // sum to exactly the capped available figure - which is what the
    // Dashboard's safe-to-spend reads, without its own formula changing.
    const flexibleCategoryIds = deficitPayload.flexibleCategories.map((c) => c.categoryId);
    const writtenFlexibleTotal = async () => {
      const rows = await prisma.budget.findMany({
        where: {
          year: deficitPayload.year,
          month: deficitPayload.month,
          period: deficitPayload.period,
          categoryId: { in: flexibleCategoryIds },
        },
      });
      return round2(rows.reduce((sum, row) => sum + num(row.amount), 0));
    };
    const submittedTotal = round2(deficitPayload.flexibleCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
    check(
      "without a reconciliation gap, confirm reports that nothing was scaled",
      deficitResultAcknowledged.ok === true && deficitResultAcknowledged.flexibleScaled === null,
      JSON.stringify(deficitResultAcknowledged),
    );
    eq(
      "without a reconciliation gap, over-allocated flexible budgets are written exactly as typed",
      await writtenFlexibleTotal(),
      submittedTotal,
    );

    console.log("\n-- a reconciliation gap caps what confirm writes --");
    const gapPayload = {
      ...deficitPayload,
      accounts: deficitPayload.accounts.map((a) =>
        a.accountId === paydayChecking.id
          ? { ...a, reportedBalance: -200, incomeEntered: 5000, incomeNote: "Salary" }
          : a,
      ),
      acknowledgedDeficit: true,
    };
    const gapResult = await confirmPaydayCheckin(gapPayload, paydayContext);
    const scaled = gapResult.ok ? gapResult.flexibleScaled : null;
    check(
      "with a gap, confirming an over-allocated plan succeeds and reports the scaling",
      gapResult.ok === true && scaled !== null && scaled !== undefined,
      JSON.stringify(gapResult),
    );
    eq("the scaling report's 'from' is the submitted flexible total", scaled?.from, submittedTotal);
    check(
      "the scaled-to figure is positive here and below what was submitted",
      scaled ? scaled.to > 0 && scaled.to < scaled.from : false,
      JSON.stringify(scaled),
    );
    const writtenAfterGap = await writtenFlexibleTotal();
    eq("the flexible budgets written sum to exactly the scaled-to figure", writtenAfterGap, scaled?.to);
    const writtenRows = await prisma.budget.findMany({
      where: { year: gapPayload.year, month: gapPayload.month, period: gapPayload.period, categoryId: { in: flexibleCategoryIds } },
    });
    check(
      "no written flexible budget exceeds what was submitted for it",
      writtenRows.every((row) => {
        const submitted = gapPayload.flexibleCategories.find((c) => c.categoryId === row.categoryId)?.plannedAmount ?? 0;
        return num(row.amount) <= submitted;
      }),
    );
    const gappedDraft = await getPaydayCheckinDraft(paydayContext);
    const gappedSummary = summarizePaydayDraft(gappedDraft, rates);
    eq("the reopened draft reports the gap that capped the plan", gappedSummary.reconciliationGap, 200);
    eq(
      "the reopened draft's capped available figure is exactly what the budgets were scaled to",
      Math.max(0, gappedSummary.available),
      scaled?.to,
    );
    const gapSnapshot = await prisma.paydayAccountSnapshot.findFirst({
      where: { paydayCheckinId: checkinRow!.id, accountId: paydayChecking.id },
    });
    eq("the Step 1 diagnostic is untouched by the cap: the snapshot still stores the reported balance as entered", num(gapSnapshot!.reportedBalance), -200);
  }

  const zeroBufferPayload = { ...zeroedPayload, buffer: 0, acknowledgedDeficit: true, acknowledgedZeroBuffer: false };
  const zeroBufferResult = await confirmPaydayCheckin(zeroBufferPayload, paydayContext);
  check("confirming a zero-buffer plan without acknowledging it is rejected", zeroBufferResult.ok === false && zeroBufferResult.reason === "zero_buffer_not_acknowledged");

  console.log("\n-- multi-currency income totals --");
  const eurIncomePayload = {
    ...zeroedPayload,
    accounts: zeroedPayload.accounts.map((a) => (a.accountId === paydayEuro.id ? { ...a, incomeEntered: 20 } : a)),
  };
  await confirmPaydayCheckin(eurIncomePayload, paydayContext);
  const checkinAfterEur = await prisma.paydayCheckin.findFirst({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  eq(
    "multi-currency income is converted through USD before summing into the check-in total",
    num(checkinAfterEur!.totalIncome),
    40,
  );

  console.log("\n-- a lowered goal amount is preserved, never silently raised back --");
  const lowGoalPayload = {
    ...zeroedPayload,
    // Income back on checking, so the account has room and a recommendation to lower.
    accounts: initialPayload.accounts,
    goals: draftForConfirm.goals.map((g) => ({
      goalId: g.goalId,
      funding: [{ accountId: paydayChecking.id, plannedAmount: 5 }],
    })),
    acknowledgedDeficit: true,
  };
  await confirmPaydayCheckin(lowGoalPayload, paydayContext);
  const lowGoalAllocation = await prisma.paydayPlanAllocation.findFirst({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
  });
  eq(
    "a user-lowered goal planned amount is stored exactly as entered",
    num(lowGoalAllocation!.plannedAmount),
    5,
  );
  check(
    "the roadmap recommendation stays recorded alongside it, never overwritten to match",
    Boolean(lowGoalAllocation) && num(lowGoalAllocation!.recommendedAmount) > 5,
  );

  console.log("\n-- a goal drawn from two accounts writes one row per account, each in its own currency --");
  const splitPayload = {
    ...lowGoalPayload,
    accounts: initialPayload.accounts.map((a) => (a.accountId === paydayEuro.id ? { ...a, incomeEntered: 100 } : a)),
    goals: draftForConfirm.goals.map((g) => ({
      goalId: g.goalId,
      funding: [
        { accountId: paydayChecking.id, plannedAmount: 5 },
        { accountId: paydayEuro.id, plannedAmount: 4 },
      ],
    })),
  };
  const splitResult = await confirmPaydayCheckin(splitPayload, paydayContext);
  check("confirming a goal split across two accounts succeeds", splitResult.ok === true);
  const splitRows = await prisma.paydayPlanAllocation.findMany({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
    orderBy: { currency: "desc" },
  });
  eq(
    "one GOAL row per (goal, account), each planned amount in that account's own currency",
    splitRows.map((r) => `${r.accountId === paydayChecking.id ? "checking" : "euro"}:${num(r.plannedAmount)}:${r.currency}`).join(","),
    "checking:5:USD,euro:4:EUR",
  );
  check(
    "each row's recommendation is that account's share of the roadmap, never more than its room",
    splitRows.every((r) => num(r.recommendedAmount) > 0) &&
      round2(num(splitRows[0].recommendedAmount) + convert(num(splitRows[1].recommendedAmount), "EUR", "USD", rates)) <= datedGoalDraft.recommendedAmount + 0.01,
    JSON.stringify(splitRows.map((r) => ({ currency: r.currency, recommended: num(r.recommendedAmount) }))),
  );
  const splitGoal = (await getPaydayCheckinDraft(paydayContext)).goals.find((g) => g.goalId === datedGoal.id)!;
  eq(
    "reopening shows both draws held, each converted into its account's currency",
    JSON.stringify(splitGoal.funding),
    JSON.stringify([
      { accountId: paydayChecking.id, plannedAmount: 5, held: true },
      { accountId: paydayEuro.id, plannedAmount: 4, held: true },
    ]),
  );
  eq("and the goal's total sums both draws into the display currency", splitGoal.plannedAmount, round2(5 + convert(4, "EUR", "USD", rates)));

  console.log("\n-- the goal page measures a plan against the real pace, not against what the accounts could fund --");
  eq("goalRoadmapAmount is remaining over the periods left, net of contributions already due", goalRoadmapAmount({ displayRemaining: 1000, targetDate: civilDate(2026, 10, 15) }, civilDate(2026, 8, 16), 50), round2(1000 / periodsRemaining(civilDate(2026, 8, 16), civilDate(2026, 10, 15)) - 50));
  eq("it never goes below zero when contributions already cover the pace", goalRoadmapAmount({ displayRemaining: 100, targetDate: civilDate(2026, 10, 15) }, civilDate(2026, 8, 16), 500), 0);
  eq("the live roadmap figure for the plan period is the one the draft recommends", await getGoalRoadmapAmount(datedGoal.id, draftForConfirm.periodRef, paydayContext), datedGoalDraft.recommendedAmount);
  // Income too small to fund the pace: the rows' recommendations are capped
  // by the account's room, while the roadmap figure stays the real pace.
  const cappedPayload = {
    ...lowGoalPayload,
    accounts: initialPayload.accounts.map((a) => (a.accountId === paydayChecking.id ? { ...a, incomeEntered: 150 } : a)),
    goals: draftForConfirm.goals.map((g) => ({ goalId: g.goalId, funding: [{ accountId: paydayChecking.id, plannedAmount: 60 }] })),
  };
  await confirmPaydayCheckin(cappedPayload, paydayContext);
  const cappedRows = await prisma.paydayPlanAllocation.findMany({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id } });
  const cappedRecommended = round2(cappedRows.reduce((sum, r) => sum + num(r.recommendedAmount), 0));
  const checkingRoom = round2(150 - 15 - defaultProtectedBuffer(150, paydaySettings.bufferPercent, checkingBufferFloorInUsd));
  eq("the stored per-account recommendation is capped at the account's room", cappedRecommended, checkingRoom);
  check("so the room shortfall the goal page shows is the pace less what the rows could fund, above zero", datedGoalDraft.recommendedAmount - cappedRecommended > 0.005, `${datedGoalDraft.recommendedAmount} vs ${cappedRecommended}`);
  check("while 'behind the roadmap' is measured against the pace, not the capped sum", datedGoalDraft.recommendedAmount - 60 > cappedRecommended - 60);

  console.log("\n-- the stored recommendation is the one Step 3 showed: later goals see what earlier goals actually drew --");
  {
    // A second dated goal, listed after the first, sharing checking's 101.67
    // USD of room. Untouched, the first goal takes all of it and the second is
    // recommended nothing; with the first goal's row zeroed on screen, Step 3
    // recommends the whole room to the second goal - and that is what confirm
    // must record next to the user's figure, not the context-free zero.
    const secondGoal = await prisma.goal.create({
      data: { name: "Verify Payday Second Goal", targetAmount: 1000, currency: "USD", targetDate: civilDate(2026, 10, 15) },
    });
    const secondRows = async () =>
      prisma.paydayPlanAllocation.findMany({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: secondGoal.id } });
    const untouchedPayload = {
      ...cappedPayload,
      goals: [
        { goalId: datedGoal.id, funding: [{ accountId: paydayChecking.id, plannedAmount: checkingRoom }] },
        { goalId: secondGoal.id, funding: [{ accountId: paydayChecking.id, plannedAmount: 1 }] },
      ],
    };
    await confirmPaydayCheckin(untouchedPayload, paydayContext);
    const firstUntouched = await prisma.paydayPlanAllocation.findFirst({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id } });
    eq("with no goal edited, the first goal's stored recommendation is its plain default: all the room", num(firstUntouched!.recommendedAmount), checkingRoom);
    eq(
      "and the second goal's is the default too: nothing left after the first",
      (await secondRows()).map((r) => `${num(r.recommendedAmount)}:${num(r.plannedAmount)}`).join(","),
      "0:1",
    );
    const freedPayload = {
      ...cappedPayload,
      goals: [
        { goalId: datedGoal.id, funding: [{ accountId: paydayChecking.id, plannedAmount: 0 }] },
        { goalId: secondGoal.id, funding: [{ accountId: paydayChecking.id, plannedAmount: checkingRoom }] },
      ],
    };
    await confirmPaydayCheckin(freedPayload, paydayContext);
    const firstFreed = await prisma.paydayPlanAllocation.findFirst({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id } });
    eq("a zeroed first goal keeps its own recommendation on record", `${num(firstFreed!.recommendedAmount)}:${num(firstFreed!.plannedAmount)}`, `${checkingRoom}:0`);
    eq(
      "and the second goal's stored recommendation is the freed-room figure Step 3 showed, not the context-free zero",
      (await secondRows()).map((r) => `${num(r.recommendedAmount)}:${num(r.plannedAmount)}`).join(","),
      `${checkingRoom}:${checkingRoom}`,
    );
    await prisma.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: secondGoal.id } });
    await prisma.goal.delete({ where: { id: secondGoal.id } });
  }

  console.log("\n-- payday check-in cleanup --");
  await prisma.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
  await prisma.paydayAccountSnapshot.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
  console.log("\n-- a late check-in for an earlier period, and dates that stay put --");
  {
    // July A 2026 is funded by June's second payday: June 30 2026 (a Tuesday).
    const lateRef = { year: 2026, month: 7, period: "A" as const };
    eq("nothing is checked in for the late period yet", await prisma.paydayCheckin.count({ where: lateRef }), 0);
    eq("paydayDateFor: the 16th-end period is paid on the 15th, pulled back off a weekend", toISODate(paydayDateFor({ year: 2026, month: 8, period: "B" })), "2026-08-14");
    eq("paydayDateFor: the 1st-15th period is paid at the end of the previous month", toISODate(paydayDateFor({ year: 2026, month: 9, period: "A" })), "2026-08-31");
    eq("paydayDateFor: July A is paid on June 30", toISODate(paydayDateFor(lateRef)), "2026-06-30");
    eq("a draft without a target still plans the payday period", periodKey((await getPaydayCheckinDraft(paydayContext)).periodRef), periodKey(planPeriodRef(paydayContext)));
    const lateDraft = await getPaydayCheckinDraft(paydayContext, lateRef);
    eq("a draft can target an explicit earlier period", periodKey(lateDraft.periodRef), periodKey(lateRef));
    eq("the late draft is not editing a confirmed check-in", lateDraft.isEditingConfirmed, false);
    eq("a new check-in for the payday period is dated today", toISODate(checkinDateForNewCheckin(planPeriodRef(paydayContext), paydayContext)), "2026-08-14");
    eq("a new check-in for a period already paid is dated on that payday, not today", toISODate(checkinDateForNewCheckin(lateRef, paydayContext)), "2026-06-30");
    eq("a new check-in for a period ahead of its payday is dated today", toISODate(checkinDateForNewCheckin({ year: 2026, month: 10, period: "A" }, paydayContext)), "2026-08-14");
    eq("the previous period of July A is June B (the period whose payday funds it)", periodKey(previousPeriod(lateRef)), "2026-06-B");

    const latePayload = {
      year: lateRef.year,
      month: lateRef.month,
      period: lateRef.period,
      accounts: lateDraft.accounts.map((a) => ({
        accountId: a.accountId,
        reportedBalance: a.expectedLedgerBalance,
        incomeEntered: a.accountId === paydayChecking.id ? 300 : 0,
        incomeNote: a.accountId === paydayChecking.id ? "Late salary" : null,
      })),
      goals: lateDraft.goals.map((g) => ({ goalId: g.goalId, funding: [] })),
      essentialCategories: lateDraft.essentialCategories.map((c) => ({ categoryId: c.categoryId, plannedAmount: 0 })),
      flexibleCategories: lateDraft.flexibleCategories.map((c) => ({ categoryId: c.categoryId, plannedAmount: 0 })),
      includedCarryover: 0,
      acknowledgedDeficit: true,
      acknowledgedZeroBuffer: true,
    };
    const lateResult = await confirmPaydayCheckin(latePayload, paydayContext);
    check("a late check-in for an earlier period confirms", lateResult.ok === true);
    const lateRow = await prisma.paydayCheckin.findFirstOrThrow({ where: lateRef, include: { snapshots: true } });
    eq("the late check-in is dated on the period's payday", toISODate(lateRow.checkinDate), "2026-06-30");
    const lateSnapshot = lateRow.snapshots.find((s) => s.accountId === paydayChecking.id);
    const latePaycheck = await prisma.transaction.findUniqueOrThrow({ where: { id: lateSnapshot!.incomeTransactionId! } });
    eq("its paycheck lands in the ledger on that payday too", `${toISODate(latePaycheck.date)}:${num(latePaycheck.amount)}:${latePaycheck.source}`, "2026-06-30:300:PAYDAY_CHECKIN");

    // Re-confirm days later with a corrected amount: the dates must not move.
    const laterContext = { ...paydayContext, today: civilDate(2026, 8, 20) };
    const reconfirmLate = await confirmPaydayCheckin(
      { ...latePayload, accounts: latePayload.accounts.map((a) => (a.accountId === paydayChecking.id ? { ...a, incomeEntered: 350 } : a)) },
      laterContext,
    );
    check("re-confirming the late check-in on a later day succeeds", reconfirmLate.ok === true);
    const lateRowAfter = await prisma.paydayCheckin.findUniqueOrThrow({ where: { id: lateRow.id } });
    eq("re-confirming keeps the check-in's original date", toISODate(lateRowAfter.checkinDate), "2026-06-30");
    const latePaycheckAfter = await prisma.transaction.findUniqueOrThrow({ where: { id: latePaycheck.id } });
    eq("re-confirming updates the paycheck's amount but never its date", `${toISODate(latePaycheckAfter.date)}:${num(latePaycheckAfter.amount)}`, "2026-06-30:350");
    eq("still exactly one paycheck row for it", await prisma.transaction.count({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN", note: "Late salary" } }), 1);

    await prisma.transaction.deleteMany({ where: { id: latePaycheck.id } });
    await prisma.budget.deleteMany({ where: { year: lateRef.year, month: lateRef.month, period: lateRef.period } });
    await prisma.paydayCheckin.delete({ where: { id: lateRow.id } });
  }

  console.log("\n-- a goal with no target date is funded as fast as the accounts' room allows --");
  {
    // There is no date to pace a debt-repayment goal against, so its
    // recommendation is the whole remaining balance, and planGoalFunding caps
    // it by the room the dated goals above it leave - the same machinery.
    const { logManualContribution: logForUndated, rebuildGoalSaved: rebuildForUndated } = await import("../src/lib/goals");
    eq("goalRoadmapAmount with no target date is the whole remaining balance, net of contributions already due", goalRoadmapAmount({ displayRemaining: 1000, targetDate: null }, civilDate(2026, 8, 16), 50), 950);
    eq("and never below zero", goalRoadmapAmount({ displayRemaining: 100, targetDate: null }, civilDate(2026, 8, 16), 500), 0);
    eq("a dated goal's pace is untouched", goalRoadmapAmount({ displayRemaining: 1000, targetDate: civilDate(2026, 10, 15) }, civilDate(2026, 8, 16), 50), round2(1000 / periodsRemaining(civilDate(2026, 8, 16), civilDate(2026, 10, 15)) - 50));

    const beforeUndated = await getPaydayCheckinDraft(paydayContext);
    const datedBefore = beforeUndated.goals.find((g) => g.goalId === datedGoal.id);
    const undatedGoal = await prisma.goal.create({ data: { name: "Verify Payday Undated Goal", targetAmount: 1000, currency: "USD" } });
    const withUndated = await getPaydayCheckinDraft(paydayContext);
    const undatedCard = withUndated.goals.find((g) => g.goalId === undatedGoal.id);
    const datedAfter = withUndated.goals.find((g) => g.goalId === datedGoal.id);
    check("the undated goal now has a card in the draft", Boolean(undatedCard));
    eq("its recommendation is the full remaining balance, with no date and no period count", `${undatedCard?.recommendedAmount}:${undatedCard?.targetDate}:${undatedCard?.periodsLeft}`, "1000:null:null");
    eq("the live roadmap figure agrees", await getGoalRoadmapAmount(undatedGoal.id, withUndated.periodRef, paydayContext), 1000);
    eq("the dated goal, funded first, is exactly as it was before the undated goal existed", JSON.stringify(datedAfter), JSON.stringify(datedBefore));
    eq("it still carries its date and period count", `${datedAfter?.targetDate?.getTime() === civilDate(2026, 10, 15).getTime()}:${datedAfter?.periodsLeft}`, `true:${datedBefore?.periodsLeft}`);
    eq("the undated goal is listed after the dated one, so it draws on what that one leaves", withUndated.goals.map((g) => g.goalId).indexOf(undatedGoal.id) > withUndated.goals.map((g) => g.goalId).indexOf(datedGoal.id), true);

    // Confirm with enough income for both goals to draw on checking.
    const undatedPayload = {
      year: withUndated.periodRef.year,
      month: withUndated.periodRef.month,
      period: withUndated.periodRef.period,
      accounts: withUndated.accounts.map((a) => ({
        accountId: a.accountId,
        reportedBalance: a.expectedLedgerBalance,
        incomeEntered: a.accountId === paydayChecking.id ? 5000 : 0,
        incomeNote: null,
      })),
      goals: withUndated.goals.map((g) => ({
        goalId: g.goalId,
        funding: [{ accountId: paydayChecking.id, plannedAmount: g.goalId === undatedGoal.id ? 700 : g.recommendedAmount }],
      })),
      essentialCategories: [],
      flexibleCategories: [],
      includedCarryover: 0,
      acknowledgedDeficit: true,
      acknowledgedZeroBuffer: true,
    };
    const undatedConfirm = await confirmPaydayCheckin(undatedPayload, paydayContext);
    check("a plan funding the undated goal confirms", undatedConfirm.ok === true);
    const undatedRows = await prisma.paydayPlanAllocation.findMany({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: undatedGoal.id } });
    eq("the confirm stores the undated goal's GOAL row with the planned draw, recommended against the whole remaining balance", undatedRows.map((r) => `${r.accountId === paydayChecking.id}:${num(r.plannedAmount)}:${num(r.recommendedAmount) > 0 && num(r.recommendedAmount) <= 1000}`).join(","), "true:700:true");
    eq("the dated goal's GOAL row is stored beside it", await prisma.paydayPlanAllocation.count({ where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id } }), 1);
    const reopened = (await getPaydayCheckinDraft(paydayContext)).goals.find((g) => g.goalId === undatedGoal.id);
    eq("reopening the plan holds the undated goal's draw", JSON.stringify(reopened?.funding), JSON.stringify([{ accountId: paydayChecking.id, plannedAmount: 700, held: true }]));

    // Half of it paid back: the recommendation follows the reduced balance.
    const partial = await logForUndated({ goalId: undatedGoal.id, accountId: paydayChecking.id, amount: 400, date: civilDate(2026, 8, 15), note: null }, rates);
    await rebuildForUndated(undatedGoal.id);
    const afterPartial = (await getPaydayCheckinDraft(paydayContext)).goals.find((g) => g.goalId === undatedGoal.id);
    eq("after a partial contribution the recommendation is the reduced remaining balance", afterPartial?.recommendedAmount, 600);
    eq("and the live roadmap figure with it", await getGoalRoadmapAmount(undatedGoal.id, withUndated.periodRef, paydayContext), 600);
    eq("the dated goal's recommendation did not move", (await getPaydayCheckinDraft(paydayContext)).goals.find((g) => g.goalId === datedGoal.id)?.recommendedAmount, datedBefore?.recommendedAmount);
    await prisma.goal.update({ where: { id: undatedGoal.id }, data: { savedAmount: 1000, achievedAt: civilDate(2026, 8, 15) } });
    eq("an achieved undated goal drops out of the draft like any achieved goal", (await getPaydayCheckinDraft(paydayContext)).goals.some((g) => g.goalId === undatedGoal.id), false);
    eq("and has no roadmap figure", await getGoalRoadmapAmount(undatedGoal.id, withUndated.periodRef, paydayContext), null);
    await prisma.transaction.deleteMany({ where: { id: partial.transactionId } });
    await prisma.goal.delete({ where: { id: undatedGoal.id } });
  }

  await prisma.paydayCheckin.deleteMany({ where: { id: checkinRow!.id } });
  await prisma.transaction.deleteMany({ where: { accountId: { in: [paydayChecking.id, paydayEuro.id] } } });
  await prisma.account.deleteMany({ where: { id: { in: [paydayChecking.id, paydayEuro.id] } } });
  await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Payday" } } });
  await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify Payday" } } });
  await prisma.category.update({ where: { id: billsCategory.id }, data: { isEssentialFixed: false } });
  console.log("  ok   payday fixtures removed");

  console.log("\n-- Gmail OAuth redirect URI --");
  {
    const env = process.env as Record<string, string | undefined>;
    const savedAppUrl = env.APP_URL;
    const savedNodeEnv = env.NODE_ENV;
    const fakeRequest = (url: string) => ({ url }) as unknown as NextRequest;

    try {
      env.APP_URL = "https://cadence.example.com";
      env.NODE_ENV = "production";
      eq(
        "production uses the configured APP_URL regardless of the request's own host",
        gmailRedirectUri(fakeRequest("https://random-preview-abc123.vercel.app/api/auth/gmail/start")),
        "https://cadence.example.com/api/auth/gmail/callback",
      );
      eq(
        "a spoofed Host-derived request URL cannot override the configured redirect URI",
        gmailRedirectUri(fakeRequest("https://attacker.example.net/api/auth/gmail/start")),
        "https://cadence.example.com/api/auth/gmail/callback",
      );

      delete env.APP_URL;
      let threw = false;
      try {
        gmailRedirectUri(fakeRequest("https://random-preview-abc123.vercel.app/api/auth/gmail/start"));
      } catch {
        threw = true;
      }
      check("production without APP_URL refuses to fall back to the request host", threw);

      env.NODE_ENV = "development";
      eq(
        "local dev without APP_URL still builds the redirect URI from localhost",
        gmailRedirectUri(fakeRequest("http://localhost:3000/api/auth/gmail/start")),
        "http://localhost:3000/api/auth/gmail/callback",
      );
    } finally {
      if (savedAppUrl === undefined) delete env.APP_URL;
      else env.APP_URL = savedAppUrl;
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
    }
  }

  console.log("\n-- Automatic transaction categorization --");
  {
    eq("clear merchant match: Uber Eats -> Dining", suggestCategoryName("UBER EATS ORDER #4821", "EXPENSE"), "Dining");
    eq("clear merchant match: bare Uber -> Transport", suggestCategoryName("Uber Trip Help.uber.com", "EXPENSE"), "Transport");
    eq("clear merchant match: Shell -> Transport", suggestCategoryName("SHELL OIL 12345678", "EXPENSE"), "Transport");
    eq("clear merchant match: McDonald's -> Dining", suggestCategoryName("MCDONALD'S #3021", "EXPENSE"), "Dining");
    eq("clear merchant match: Amazon -> Shopping", suggestCategoryName("AMAZON.COM*A1B2C3D4", "EXPENSE"), "Shopping");
    eq("clear merchant match: Anthropic -> Subscriptions", suggestCategoryName("ANTHROPIC", "EXPENSE"), "Subscriptions");
    eq("clear merchant match: Whole Foods -> Groceries", suggestCategoryName("WHOLE FOODS MARKET #123", "EXPENSE"), "Groceries");
    eq(
      "case/spacing variation still matches: '  uber   eats  '",
      suggestCategoryName("  uber   EATS  ", "EXPENSE"),
      "Dining",
    );
    eq(
      "unknown merchant remains uncategorized",
      suggestCategoryName("BOB'S WIDGET FACTORY", "EXPENSE"),
      null,
    );
    eq(
      "income rows are never auto-categorized, even with a matching description",
      suggestCategoryName("AMAZON.COM REFUND", "INCOME"),
      null,
    );
    eq("empty/missing description stays uncategorized", suggestCategoryName(null, "EXPENSE"), null);

    const categoryIdByName = new Map(
      (await prisma.category.findMany({ select: { id: true, name: true } })).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ]),
    );
    const diningId = categoryIdByName.get("dining");
    const transportId = categoryIdByName.get("transport");
    const knownCategoryIds = new Set([diningId, transportId].filter((id): id is string => Boolean(id)));

    if (diningId && transportId) {
      eq(
        "explicit import category wins over automatic categorization",
        resolveImportCategoryId({
          explicitCategoryId: transportId,
          note: "UBER EATS ORDER #4821",
          type: "EXPENSE",
          knownCategoryIds,
          categoryIdByName,
        }),
        transportId,
      );
      eq(
        "no explicit category falls back to the automatic suggestion",
        resolveImportCategoryId({
          explicitCategoryId: null,
          note: "UBER EATS ORDER #4821",
          type: "EXPENSE",
          knownCategoryIds,
          categoryIdByName,
        }),
        diningId,
      );
      eq(
        "an explicit category id that no longer exists falls back to automatic categorization",
        resolveImportCategoryId({
          explicitCategoryId: "stale-deleted-category-id",
          note: "UBER EATS ORDER #4821",
          type: "EXPENSE",
          knownCategoryIds,
          categoryIdByName,
        }),
        diningId,
      );
    } else {
      check("Dining and Transport categories exist for the resolveImportCategoryId checks", false);
    }
    eq(
      "no explicit category and no rule match leaves the row uncategorized",
      resolveImportCategoryId({
        explicitCategoryId: null,
        note: "BOB'S WIDGET FACTORY",
        type: "EXPENSE",
        knownCategoryIds,
        categoryIdByName,
      }),
      null,
    );

    // Existing categorized transactions are never touched by import: CSV
    // import only ever inserts new rows (createMany), so a pre-existing
    // categorized transaction must be unaffected by an unrelated import run.
    if (diningId) {
      const existing = await prisma.transaction.create({
        data: {
          date: new Date("2026-08-15"),
          amount: 42,
          currency: "USD",
          type: "EXPENSE",
          accountId: checking.id,
          categoryId: diningId,
          note: "Existing manually categorized row",
          source: "MANUAL",
        },
      });
      await prisma.transaction.createMany({
        data: [
          {
            date: new Date("2026-08-16"),
            amount: 10,
            currency: "USD",
            type: "EXPENSE",
            accountId: checking.id,
            categoryId: resolveImportCategoryId({
              explicitCategoryId: null,
              note: "UBER EATS ORDER #9999",
              type: "EXPENSE",
              knownCategoryIds,
              categoryIdByName,
            }),
            note: "UBER EATS ORDER #9999",
            source: "CSV",
          },
        ],
      });
      const reloaded = await prisma.transaction.findUnique({ where: { id: existing.id } });
      eq(
        "an unrelated CSV import does not change an existing manually categorized transaction",
        reloaded?.categoryId,
        diningId,
      );
      await prisma.transaction.deleteMany({ where: { accountId: checking.id, note: { in: ["Existing manually categorized row", "UBER EATS ORDER #9999"] } } });
    }
  }

  console.log("\n-- backfillUncategorizedTransactions (historical CSV imports) --");
  {
    const { backfillUncategorizedTransactions } = await import("../src/lib/categorization");

    const categoryByName = new Map(
      (await prisma.category.findMany({ select: { id: true, name: true } })).map((c) => [c.name, c.id]),
    );
    const shoppingId = categoryByName.get("Shopping")!;
    const transportId = categoryByName.get("Transport")!;
    const diningId = categoryByName.get("Dining")!;
    const entertainmentId = categoryByName.get("Entertainment")!;

    const backfillAccount = await prisma.account.create({
      data: { name: "Verify Backfill", currency: "USD", type: "CHECKING" },
    });

    const uncategorizedAmazon = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 5), amount: 55, currency: "USD", type: "EXPENSE", accountId: backfillAccount.id, categoryId: null, note: "AMAZON.COM*A1B2C3D4", source: "CSV" },
    });
    const uncategorizedTransport = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 6), amount: 40, currency: "USD", type: "EXPENSE", accountId: backfillAccount.id, categoryId: null, note: "SHELL OIL 12345678", source: "CSV" },
    });
    const uncategorizedDining = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 7), amount: 25, currency: "USD", type: "EXPENSE", accountId: backfillAccount.id, categoryId: null, note: "MCDONALD'S #3021", source: "CSV" },
    });
    const uncategorizedUnknown = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 8), amount: 60, currency: "USD", type: "EXPENSE", accountId: backfillAccount.id, categoryId: null, note: "BOB'S WIDGET FACTORY", source: "CSV" },
    });
    const alreadyCategorized = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 9), amount: 30, currency: "USD", type: "EXPENSE", accountId: backfillAccount.id, categoryId: entertainmentId, note: "AMAZON.COM*Z9Y8X7", source: "CSV" },
    });
    const uncategorizedIncome = await prisma.transaction.create({
      data: { date: civilDate(2026, 3, 10), amount: 200, currency: "USD", type: "INCOME", accountId: backfillAccount.id, categoryId: null, note: "AMAZON.COM REFUND", source: "MANUAL" },
    });
    const transferId = crypto.randomUUID();
    await prisma.$transaction([
      prisma.transaction.create({
        data: { date: civilDate(2026, 3, 11), amount: 75, currency: "USD", type: "TRANSFER", accountId: backfillAccount.id, categoryId: null, transferId, transferDirection: "OUT", note: "SHELL OIL transfer-shaped note", source: "MANUAL" },
      }),
      prisma.transaction.create({
        data: { date: civilDate(2026, 3, 11), amount: 75, currency: "USD", type: "TRANSFER", accountId: backfillAccount.id, categoryId: null, transferId, transferDirection: "IN", note: "SHELL OIL transfer-shaped note", source: "MANUAL" },
      }),
    ]);

    const firstRunCount = await backfillUncategorizedTransactions();

    const reloadedAmazon = await prisma.transaction.findUnique({ where: { id: uncategorizedAmazon.id } });
    eq("an existing uncategorized Amazon expense becomes Shopping", reloadedAmazon?.categoryId, shoppingId);

    const reloadedTransport = await prisma.transaction.findUnique({ where: { id: uncategorizedTransport.id } });
    eq("an existing uncategorized transport merchant becomes Transport", reloadedTransport?.categoryId, transportId);

    const reloadedDining = await prisma.transaction.findUnique({ where: { id: uncategorizedDining.id } });
    eq("an existing uncategorized dining merchant becomes Dining", reloadedDining?.categoryId, diningId);

    const reloadedUnknown = await prisma.transaction.findUnique({ where: { id: uncategorizedUnknown.id } });
    eq("an unknown merchant remains uncategorized after the backfill", reloadedUnknown?.categoryId, null);

    const reloadedAlreadyCategorized = await prisma.transaction.findUnique({ where: { id: alreadyCategorized.id } });
    eq(
      "an existing manually/explicitly categorized transaction is never changed by the backfill",
      reloadedAlreadyCategorized?.categoryId,
      entertainmentId,
    );

    const reloadedIncome = await prisma.transaction.findUnique({ where: { id: uncategorizedIncome.id } });
    eq("income is never categorized by the backfill, even with a matching merchant note", reloadedIncome?.categoryId, null);

    const reloadedTransferLegs = await prisma.transaction.findMany({ where: { transferId } });
    check(
      "transfer legs are never touched by the backfill, even with a matching merchant-shaped note",
      reloadedTransferLegs.length === 2 && reloadedTransferLegs.every((leg) => leg.categoryId === null),
    );

    eq(
      "the backfill only changes rows that were null - it categorized exactly the 3 matchable uncategorized rows, not the already-categorized/income/transfer rows",
      firstRunCount,
      3,
    );

    const secondRunCount = await backfillUncategorizedTransactions();
    eq("running the backfill again finds nothing left to do - it's idempotent", secondRunCount, 0);

    const afterSecondRun = await prisma.transaction.findMany({
      where: { id: { in: [uncategorizedAmazon.id, uncategorizedTransport.id, uncategorizedDining.id, uncategorizedUnknown.id, alreadyCategorized.id, uncategorizedIncome.id] } },
      select: { id: true, categoryId: true },
    });
    const afterSecondRunById = new Map(afterSecondRun.map((t) => [t.id, t.categoryId]));
    check(
      "a second run produces the exact same result as the first run - no row changes on re-run",
      afterSecondRunById.get(uncategorizedAmazon.id) === shoppingId &&
        afterSecondRunById.get(uncategorizedTransport.id) === transportId &&
        afterSecondRunById.get(uncategorizedDining.id) === diningId &&
        afterSecondRunById.get(uncategorizedUnknown.id) === null &&
        afterSecondRunById.get(alreadyCategorized.id) === entertainmentId &&
        afterSecondRunById.get(uncategorizedIncome.id) === null,
    );

    await prisma.transaction.deleteMany({ where: { accountId: backfillAccount.id } });
    await prisma.account.delete({ where: { id: backfillAccount.id } });
    console.log("  ok   backfill fixtures removed");
  }

  console.log("\n-- CSV import review: resolveImportCategoryId 'leave uncategorized' override --");
  {
    const categoryIdByName = new Map(
      (await prisma.category.findMany({ select: { id: true, name: true } })).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ]),
    );
    const shoppingId = categoryIdByName.get("shopping")!;
    const knownCategoryIds = new Set([shoppingId]);

    eq(
      "explicit EXPLICIT_NO_CATEGORY sentinel forces Uncategorized even though the note would otherwise auto-suggest Shopping",
      resolveImportCategoryId({
        explicitCategoryId: EXPLICIT_NO_CATEGORY,
        note: "AMAZON.COM*A1B2C3D4",
        type: "EXPENSE",
        knownCategoryIds,
        categoryIdByName,
      }),
      null,
    );
    eq(
      "an explicit real category id still overrides the sentinel's sibling automatic path",
      resolveImportCategoryId({
        explicitCategoryId: shoppingId,
        note: "SOME OTHER MERCHANT",
        type: "EXPENSE",
        knownCategoryIds,
        categoryIdByName,
      }),
      shoppingId,
    );
  }

  console.log("\n-- CSV import review: grouped pattern detection (import-grouping, pure) --");
  {
    const rowSpecs: {
      date: Date;
      amount: number;
      note: string;
      type: "EXPENSE" | "INCOME";
    }[] = [
      // Amazon: same merchant, varying order-id suffix and casing noise -> one group.
      { date: civilDate(2026, 3, 1), amount: 20, note: "AMAZON.COM*A1B2C3", type: "EXPENSE" },
      { date: civilDate(2026, 3, 10), amount: 45.5, note: "AMAZON.COM*D4E5F6", type: "EXPENSE" },
      { date: civilDate(2026, 3, 20), amount: 12.99, note: "AMAZON.COM*G7H8I9", type: "EXPENSE" },
      // Uber (rides) vs Uber Eats: both repeated, must stay distinct groups.
      { date: civilDate(2026, 3, 2), amount: 15, note: "UBER TRIP HELP.UBER.COM", type: "EXPENSE" },
      { date: civilDate(2026, 3, 12), amount: 18, note: "Uber Trip Help.uber.com", type: "EXPENSE" },
      { date: civilDate(2026, 3, 3), amount: 22, note: "UBER EATS ORDER #4821", type: "EXPENSE" },
      { date: civilDate(2026, 3, 13), amount: 19, note: "UBER EATS ORDER #7733", type: "EXPENSE" },
      // A single unknown merchant - too rare to be a "pattern", goes to the unknown bucket.
      { date: civilDate(2026, 3, 4), amount: 60, note: "BOB'S WIDGET FACTORY", type: "EXPENSE" },
      // Repeated unknown merchant with irregular gaps - still a group (same merchant), but not a subscription.
      { date: civilDate(2026, 3, 5), amount: 500, note: "CIVEX POLIZAS MADRID 001", type: "EXPENSE" },
      { date: civilDate(2026, 6, 22), amount: 500, note: "CIVEX POLIZAS MADRID 002", type: "EXPENSE" },
      // Whoop: unknown category, but perfectly periodic + same amount -> possible subscription.
      { date: civilDate(2026, 1, 15), amount: 49.99, note: "WHOOP MEMBERSHIP", type: "EXPENSE" },
      { date: civilDate(2026, 2, 14), amount: 49.99, note: "WHOOP MEMBERSHIP", type: "EXPENSE" },
      { date: civilDate(2026, 3, 16), amount: 49.99, note: "WHOOP MEMBERSHIP", type: "EXPENSE" },
      // Spotify: known Subscriptions merchant, repeated -> possible subscription via the category itself.
      { date: civilDate(2026, 1, 5), amount: 9.99, note: "SPOTIFY USA", type: "EXPENSE" },
      { date: civilDate(2026, 2, 5), amount: 9.99, note: "SPOTIFY USA", type: "EXPENSE" },
      // Transfer-shaped rows: three distinct patterns, an outgoing debit, an ACH transfer, and an incoming credit.
      { date: civilDate(2026, 3, 6), amount: 5000, note: "Debito Por Transferencia", type: "EXPENSE" },
      { date: civilDate(2026, 3, 7), amount: 3000, note: "Por Transferencia ACH", type: "EXPENSE" },
      { date: civilDate(2026, 3, 8), amount: 7000, note: "Transferencia Recibida De Juan", type: "INCOME" },
      // Income that happens to share the Amazon merchant text must never join the expense group.
      { date: civilDate(2026, 3, 9), amount: 100, note: "AMAZON.COM REFUND", type: "INCOME" },
    ];
    const rows: GroupableRow[] = rowSpecs.map((spec, index) => ({ index, ...spec }));

    const recurringCountBefore = await prisma.recurringItem.count();
    const transferTxCountBefore = await prisma.transaction.count({ where: { type: "TRANSFER" } });
    const { groups, unknownRowIndexes } = detectImportGroups(rows);
    eq(
      "10. detecting patterns (including possible subscriptions) never itself creates a RecurringItem",
      await prisma.recurringItem.count(),
      recurringCountBefore,
    );
    eq(
      "9. detecting patterns (including possible transfers) never itself creates a linked transfer transaction",
      await prisma.transaction.count({ where: { type: "TRANSFER" } }),
      transferTxCountBefore,
    );

    const byRowIndex = (index: number) => groups.find((g) => g.rowIndexes.includes(index));

    const amazon = byRowIndex(0);
    check(
      "1. repeated Amazon rows form exactly one group covering exactly those 3 rows",
      Boolean(amazon) && amazon!.rowIndexes.slice().sort().join(",") === "0,1,2",
    );
    eq("3. Amazon group gets the deterministic Shopping suggestion", amazon?.suggestedCategoryName, "Shopping");
    eq(
      "7. grouping never changes the underlying amounts - the group total is exactly the sum of its rows",
      amazon?.totalAmount,
      round2(20 + 45.5 + 12.99),
    );

    const uberTrip = byRowIndex(3);
    const uberEats = byRowIndex(5);
    check(
      "2. repeated Uber rides and repeated Uber Eats orders form two distinct groups",
      Boolean(uberTrip) && Boolean(uberEats) && uberTrip!.id !== uberEats!.id,
    );
    check(
      "6. the Uber-rides group covers only rows 3 and 4 - not the Uber Eats rows",
      uberTrip!.rowIndexes.slice().sort().join(",") === "3,4",
    );
    check(
      "6. the Uber Eats group covers only rows 5 and 6 - not the Uber-rides rows",
      uberEats!.rowIndexes.slice().sort().join(",") === "5,6",
    );
    eq("3. Uber rides suggest Transport", uberTrip?.suggestedCategoryName, "Transport");
    eq("3. Uber Eats suggests Dining", uberEats?.suggestedCategoryName, "Dining");

    check(
      "4. a one-off unknown merchant (Bob's Widget Factory) is never categorized and lands in the unknown bucket, not a group",
      unknownRowIndexes.includes(7) && !byRowIndex(7),
    );

    const civex = byRowIndex(8);
    check(
      "repeated-but-unrecognized merchants (Civex Polizas) still form their own group for review, without a category suggestion",
      Boolean(civex) &&
        civex!.rowIndexes.slice().sort().join(",") === "8,9" &&
        civex!.suggestedCategoryName === null &&
        civex!.kind === "unknown",
    );

    const whoop = byRowIndex(10);
    check(
      "10. Whoop (unknown merchant, same amount, ~monthly cadence) is flagged 'possible subscription' without a category suggestion",
      Boolean(whoop) &&
        whoop!.possibleSubscription === true &&
        whoop!.suggestedCategoryName === null &&
        whoop!.kind === "subscription",
    );

    const spotify = byRowIndex(13);
    check(
      "10. Spotify (known Subscriptions merchant, repeated) is also flagged 'possible subscription'",
      Boolean(spotify) && spotify!.possibleSubscription === true && spotify!.suggestedCategoryName === "Subscriptions",
    );

    const debito = byRowIndex(15);
    const ach = byRowIndex(16);
    const recibida = byRowIndex(17);
    check(
      "9. the three transfer-shaped patterns are each flagged for review as distinct groups",
      Boolean(debito) &&
        Boolean(ach) &&
        Boolean(recibida) &&
        debito!.kind === "transfer" &&
        ach!.kind === "transfer" &&
        recibida!.kind === "transfer" &&
        new Set([debito!.id, ach!.id, recibida!.id]).size === 3,
    );
    eq("9. an incoming transfer-shaped row keeps its own row index in its transfer group", recibida?.rowIndexes.join(","), "17");

    check(
      "8. an income row is never pulled into an ordinary expense merchant group, even sharing the Amazon merchant text",
      !byRowIndex(18) && !unknownRowIndexes.includes(18),
    );

    eq(
      "no CSV rows are silently dropped - every row is either in a group or in the unknown bucket, except singleton rows the existing engine already categorizes on its own",
      groups.reduce((sum, g) => sum + g.count, 0) + unknownRowIndexes.length,
      rows.length - 1,
    );
  }

  console.log("\n-- CSV import review: no detected patterns falls through to a normal import --");
  {
    const rows: GroupableRow[] = [
      { index: 0, date: civilDate(2026, 4, 1), amount: 40, note: "SHELL OIL 998877", type: "EXPENSE" },
      { index: 1, date: civilDate(2026, 4, 2), amount: 12, note: "STARBUCKS #221", type: "EXPENSE" },
      { index: 2, date: civilDate(2026, 4, 3), amount: 2500, note: "PAYCHECK DEPOSIT", type: "INCOME" },
    ];
    const { groups, unknownRowIndexes } = detectImportGroups(rows);
    check(
      "12. a file with no repeated/unknown patterns produces no groups and no unknown bucket - import proceeds normally",
      groups.length === 0 && unknownRowIndexes.length === 0,
    );
  }

  console.log("\n-- CSV import review: unknown-merchant bulk selection (buildRowCategoryOverrides, pure) --");
  {
    const categoryIdByName = new Map(
      (await prisma.category.findMany({ select: { id: true, name: true } })).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ]),
    );
    const groceriesId = categoryIdByName.get("groceries")!;
    const diningId = categoryIdByName.get("dining")!;

    // Single-row selection: picking exactly one unknown row applies the
    // chosen category to that row only.
    {
      const decisions: RowCategoryDecision[] = [{ rowIndexes: [4], categoryId: groceriesId }];
      const overrides = buildRowCategoryOverrides(decisions);
      eq("single-row selection: the selected row gets the chosen category", overrides.get(4), groceriesId);
      eq("single-row selection: an unrelated row is left with no override", overrides.get(5), undefined);
      eq("single-row selection: produces exactly one override", overrides.size, 1);
    }

    // Multi-row categorization: selecting several unknown rows at once and
    // applying one category covers all and only the selected rows.
    {
      const decisions: RowCategoryDecision[] = [
        { rowIndexes: [1, 3, 7], categoryId: diningId },
      ];
      const overrides = buildRowCategoryOverrides(decisions);
      check(
        "multi-row categorization: all three selected rows get the same category",
        overrides.get(1) === diningId && overrides.get(3) === diningId && overrides.get(7) === diningId,
      );
      check(
        "multi-row categorization: rows outside the selection are untouched",
        !overrides.has(0) && !overrides.has(2) && !overrides.has(4) && !overrides.has(5) && !overrides.has(6),
      );
      eq("multi-row categorization: produces exactly the 3 selected overrides, no more", overrides.size, 3);
    }

    // Leave uncategorized: an explicit EXPLICIT_NO_CATEGORY decision on a
    // multi-row selection is preserved verbatim (resolveImportCategoryId is
    // what turns it into a forced-null category at import time).
    {
      const decisions: RowCategoryDecision[] = [
        { rowIndexes: [2, 9], categoryId: EXPLICIT_NO_CATEGORY },
      ];
      const overrides = buildRowCategoryOverrides(decisions);
      eq("leave uncategorized: row 2 carries the explicit sentinel", overrides.get(2), EXPLICIT_NO_CATEGORY);
      eq("leave uncategorized: row 9 carries the explicit sentinel", overrides.get(9), EXPLICIT_NO_CATEGORY);
      eq(
        "leave uncategorized: resolves to Uncategorized even for a note that would otherwise auto-suggest",
        resolveImportCategoryId({
          explicitCategoryId: overrides.get(2)!,
          note: "SHELL OIL 998877",
          type: "EXPENSE",
          knownCategoryIds: new Set([groceriesId]),
          categoryIdByName,
        }),
        null,
      );
    }

    // A later decision on the same row (e.g. re-selecting and re-applying)
    // overwrites the earlier one, and unrelated group decisions combine
    // cleanly with individually-selected unknown rows.
    {
      const decisions: RowCategoryDecision[] = [
        { rowIndexes: [10, 11, 12], categoryId: groceriesId }, // a detected group's decision
        { rowIndexes: [4], categoryId: diningId }, // an individually-selected unknown row
        { rowIndexes: [4], categoryId: groceriesId }, // re-selected and re-applied with a different category
      ];
      const overrides = buildRowCategoryOverrides(decisions);
      eq("re-applying a decision to the same row wins over the earlier one", overrides.get(4), groceriesId);
      check(
        "a group decision and an individual unknown-row decision coexist without interference",
        overrides.get(10) === groceriesId &&
          overrides.get(11) === groceriesId &&
          overrides.get(12) === groceriesId,
      );
    }
  }

  console.log("\n-- CSV import review: transfer direction (incoming vs outgoing) --");
  {
    const currentAccountId = "acct-checking";
    // An empty prefill string proves the review never falls back to some
    // other active account (e.g. "Popular") - see the eq() checks below.

    const rows: GroupableRow[] = [
      // Negative/outgoing: "Debito Por Transferencia".
      { index: 0, date: civilDate(2026, 3, 6), amount: 5000, note: "Debito Por Transferencia", type: "EXPENSE" },
      // Positive/incoming: "Transferencia Recibida de CMS Business Consulting Group".
      {
        index: 1,
        date: civilDate(2026, 3, 8),
        amount: 42000,
        note: "Transferencia Recibida de CMS Business Consulting Group",
        type: "INCOME",
      },
      // Same cleaned merchant text as row 1 but the outgoing leg - must not
      // join the incoming group just because the text (after cleaning)
      // matches, since direction is part of group identity.
      {
        index: 2,
        date: civilDate(2026, 3, 9),
        amount: 1500,
        note: "Transferencia Recibida de CMS Business Consulting Group",
        type: "EXPENSE",
      },
    ];
    const { groups } = detectImportGroups(rows);

    const outgoing = groups.find((g) => g.rowIndexes.includes(0))!;
    const incoming = groups.find((g) => g.rowIndexes.includes(1))!;
    const outgoingTwin = groups.find((g) => g.rowIndexes.includes(2))!;

    check(
      "negative 'Debito Por Transferencia' is grouped as an outgoing transfer",
      outgoing.kind === "transfer" && outgoing.transferDirection === "OUT",
    );
    check(
      "positive 'Transferencia Recibida...' is grouped as an incoming transfer",
      incoming.kind === "transfer" && incoming.transferDirection === "IN",
    );
    check(
      "6. an outgoing row never shares a group with an incoming row, even with identical merchant text",
      incoming.id !== outgoingTwin.id && !incoming.rowIndexes.includes(2) && outgoingTwin.transferDirection === "OUT",
    );
    eq("6. the incoming group covers only its own row", incoming.rowIndexes.join(","), "1");
    check(
      "the direction-aware grouping key never leaks into the displayed group name (no 'Income:'/'Expense:' prefix)",
      !incoming.displayName.toLowerCase().includes("income") &&
        !outgoing.displayName.toLowerCase().includes("expense"),
    );

    // Existing grouped category review (a non-transfer kind) is unaffected -
    // transferDirection is simply null for it.
    const shoppingRows: GroupableRow[] = [
      { index: 10, date: civilDate(2026, 3, 1), amount: 20, note: "AMAZON.COM*A1B2C3", type: "EXPENSE" },
      { index: 11, date: civilDate(2026, 3, 2), amount: 30, note: "AMAZON.COM*D4E5F6", type: "EXPENSE" },
    ];
    const { groups: shoppingGroups } = detectImportGroups(shoppingRows);
    eq(
      "existing grouped category review is untouched: a category-kind group has transferDirection null",
      shoppingGroups[0]?.transferDirection,
      null,
    );

    // 2/3/4/5: TransferDialog prefill direction, and that no arbitrary
    // "other active account" is ever inferred for the unset side.
    const outgoingPrefill = buildTransferPrefill({
      direction: "OUT",
      accountId: currentAccountId,
      date: "2026-03-06",
      amount: 5000,
      currency: "USD",
      note: outgoing.sampleNote,
    });
    check(
      "4. an outgoing review defaults From to the current account",
      outgoingPrefill.fromAccountId === currentAccountId,
    );
    eq(
      "2/5. an outgoing review never infers a destination account - not even another active one - it's left blank",
      outgoingPrefill.toAccountId,
      "",
    );

    const incomingPrefill = buildTransferPrefill({
      direction: "IN",
      accountId: currentAccountId,
      date: "2026-03-08",
      amount: 42000,
      currency: "USD",
      note: incoming.sampleNote,
    });
    check(
      "1/3. an incoming review never defaults From to the current account (that direction is wrong for money coming in)",
      incomingPrefill.fromAccountId !== currentAccountId,
    );
    check(
      "3. an incoming review puts the current account on the To side, matching the money's actual direction",
      incomingPrefill.toAccountId === currentAccountId,
    );
    eq(
      "2/5. an incoming review never infers a source account - not even another active one - it's left blank",
      incomingPrefill.fromAccountId,
      "",
    );

    // 7/8/9: an explicit "Mark as income" type override is a distinct
    // decision channel from category decisions, and survives into the final
    // per-row payload the same way a category override does.
    const typeOverrides = buildRowCategoryOverrides([
      { rowIndexes: incoming.rowIndexes, categoryId: "INCOME" },
    ]);
    eq(
      "7. marking an incoming transfer group as income overrides exactly its own row",
      typeOverrides.get(1),
      "INCOME",
    );
    eq(
      "7. an unrelated row's type is untouched by the income override",
      typeOverrides.get(0),
      undefined,
    );
    const categoryOverrides = buildRowCategoryOverrides([]); // no category decision was ever made for row 1
    check(
      "9. an income decision is never recorded as a category assignment - the category-override map has no entry for it",
      !categoryOverrides.has(1),
    );
    const simulatedPayloadType = (rowIndex: number, originalType: string) =>
      typeOverrides.get(rowIndex) ?? originalType;
    eq(
      "7. the final import payload uses the explicit income override, not the row's original type",
      simulatedPayloadType(1, "EXPENSE"), // even if the original type were somehow EXPENSE, the override wins
      "INCOME",
    );
    eq(
      "8. an ordinary expense row with no type decision keeps its original type - ordinary category logic is untouched",
      simulatedPayloadType(0, "EXPENSE"),
      "EXPENSE",
    );

    // 10/11/12: "Record as external transfer" is a distinct decision from
    // both "mark as income" and "leave as expense" - same channel
    // (typeDecisions) as income, but resolves to EXTERNAL_TRANSFER with the
    // group's own direction, never invented independently.
    const externalOverrides = buildRowCategoryOverrides([
      { rowIndexes: outgoing.rowIndexes, categoryId: "EXTERNAL_TRANSFER" },
    ]);
    eq(
      "10. recording an outgoing transfer group as external overrides exactly its own row",
      externalOverrides.get(0),
      "EXTERNAL_TRANSFER",
    );
    const simulatedPayloadRow = (
      originalType: "EXPENSE" | "INCOME",
      group: (typeof groups)[number],
      typeOverride: string | undefined,
    ) => {
      const type = typeOverride ?? originalType;
      return {
        type,
        transferDirection: type === "EXTERNAL_TRANSFER" ? group.transferDirection : null,
        categoryId: type === "EXTERNAL_TRANSFER" ? null : "would-be-resolved-category-id",
      };
    };
    const outgoingExternalRow = simulatedPayloadRow("EXPENSE", outgoing, externalOverrides.get(0));
    eq("11. an outgoing external-transfer row gets the group's own OUT direction", outgoingExternalRow.transferDirection, "OUT");
    eq("12. an outgoing external-transfer row forces categoryId null even if a default category was set", outgoingExternalRow.categoryId, null);

    const incomingExternalOverrides = buildRowCategoryOverrides([
      { rowIndexes: incoming.rowIndexes, categoryId: "EXTERNAL_TRANSFER" },
    ]);
    const incomingExternalRow = simulatedPayloadRow("INCOME", incoming, incomingExternalOverrides.get(1));
    eq("11. an incoming external-transfer row gets the group's own IN direction", incomingExternalRow.transferDirection, "IN");
    eq("12. an incoming external-transfer row forces categoryId null too", incomingExternalRow.categoryId, null);

    const ordinaryOutgoingRow = simulatedPayloadRow("EXPENSE", outgoing, undefined);
    eq("13. a row with no type decision keeps direction null - it's not an external transfer", ordinaryOutgoingRow.transferDirection, null);

    // 14: the submit-time guard - the Import button stays disabled while any
    // detected transfer-shaped group has neither a category nor a type decision.
    const unresolvedTransferGroups = (
      allGroups: typeof groups,
      categoryDecisions: Record<string, string>,
      typeDecisions: Record<string, string>,
    ) =>
      allGroups.filter(
        (group) =>
          group.kind === "transfer" &&
          categoryDecisions[group.id] === undefined &&
          typeDecisions[group.id] === undefined,
      );
    eq(
      "14. with no decisions at all, every transfer group is unresolved and blocks import",
      unresolvedTransferGroups(groups, {}, {}).length,
      groups.filter((g) => g.kind === "transfer").length,
    );
    eq(
      "14. resolving the outgoing group via a type decision (external transfer) clears it from the unresolved list",
      unresolvedTransferGroups(groups, {}, { [outgoing.id]: "EXTERNAL_TRANSFER" }).some((g) => g.id === outgoing.id),
      false,
    );
    eq(
      "14. resolving the outgoing group via a category decision (leave as expense) also clears it",
      unresolvedTransferGroups(groups, { [outgoing.id]: EXPLICIT_NO_CATEGORY }, {}).some((g) => g.id === outgoing.id),
      false,
    );
    check(
      "14. an ordinary (non-transfer) group never blocks import even with zero decisions",
      unresolvedTransferGroups(shoppingGroups, {}, {}).length === 0,
    );
  }

  console.log("\n== recurring form validation ==");
  {
    const { firstError: firstValidationError, recurringSchema } = await import("../src/lib/validation");
    const baseForm = { name: "Verify Sub", amount: "10", currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: "2026-09-01", categoryId: "none", note: "", active: "true" };
    const noAccount = recurringSchema.safeParse({ ...baseForm, accountId: "" });
    eq("a subscription without an account is rejected", noAccount.success ? "accepted" : noAccount.error.issues[0]?.message, "Pick an account");
    const withAccount = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1" });
    eq("a subscription with an account (and no goal field at all) saves", withAccount.success ? withAccount.data.accountId : "rejected", "acc_1");
    eq("a subscription never keeps a goal", withAccount.success ? withAccount.data.goalId : "rejected", null);
    const staleGoal = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", goalId: "goal_1" });
    eq("a stale goal left over from switching Kind back is dropped", staleGoal.success ? staleGoal.data.goalId : "rejected", null);
    const contributionNoGoal = recurringSchema.safeParse({ ...baseForm, kind: "CONTRIBUTION", accountId: "acc_1", goalId: "" });
    eq("a contribution without a goal is rejected", contributionNoGoal.success ? "accepted" : contributionNoGoal.error.issues[0]?.message, "Pick a goal");
    eq("the goal error is translated for the Spanish UI", contributionNoGoal.success ? "accepted" : firstValidationError(contributionNoGoal.error, "es"), "Elige una meta");
    const contributionNoAccount = recurringSchema.safeParse({ ...baseForm, kind: "CONTRIBUTION", accountId: "none", goalId: "goal_1" });
    eq("a contribution without an account is rejected", contributionNoAccount.success ? "accepted" : contributionNoAccount.error.issues[0]?.message, "Pick an account");
    const contribution = recurringSchema.safeParse({ ...baseForm, kind: "CONTRIBUTION", accountId: "acc_1", goalId: "goal_1" });
    eq("a contribution with both links saves with both", contribution.success ? `${contribution.data.accountId}:${contribution.data.goalId}` : "rejected", "acc_1:goal_1");
    const noCountdownField = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1" });
    eq("a form without the payments-left field at all saves as open-ended", noCountdownField.success ? String(noCountdownField.data.remainingOccurrences) : "rejected", "null");
    const blankCountdown = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", remainingOccurrences: "  " });
    eq("a blank payments-left field is open-ended (null), not 0", blankCountdown.success ? String(blankCountdown.data.remainingOccurrences) : "rejected", "null");
    const countdown = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", remainingOccurrences: "4" });
    eq("a whole number of payments left is kept", countdown.success ? countdown.data.remainingOccurrences : "rejected", 4);
    for (const bad of ["0", "-1", "2.5", "121", "three"]) {
      const rejected = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", remainingOccurrences: bad });
      eq(`payments left of "${bad}" is rejected`, rejected.success ? "accepted" : rejected.error.issues[0]?.message, "Leave payments left blank, or use between 1 and 120");
    }
    const badCountdown = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", remainingOccurrences: "0" });
    eq("the payments-left error is translated for the Spanish UI", badCountdown.success ? "accepted" : firstValidationError(badCountdown.error, "es"), "Deja los pagos restantes en blanco, o usa entre 1 y 120");

    // Anchor day: set from the picked date on create and on a re-picked date,
    // left alone (undefined, so the update skips it) when an edit keeps the
    // date the form was rendered with - which in a short month is the
    // clamped occurrence, not the real anchor.
    const createdOn31 = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", nextDate: "2026-10-31" });
    eq("a new item is anchored on the day picked", createdOn31.success ? createdOn31.data.anchorDay : "rejected", 31);
    const untouchedDate = recurringSchema.safeParse({ ...baseForm, id: "item_1", accountId: "acc_1", nextDate: "2027-02-28", originalNextDate: "2027-02-28" });
    eq("an edit that leaves the (clamped) due date alone leaves the anchor alone", untouchedDate.success ? String(untouchedDate.data.anchorDay) : "rejected", "undefined");
    const repickedDate = recurringSchema.safeParse({ ...baseForm, id: "item_1", accountId: "acc_1", nextDate: "2027-03-15", originalNextDate: "2027-02-28" });
    eq("an edit that re-picks the due date re-anchors to it", repickedDate.success ? repickedDate.data.anchorDay : "rejected", 15);
    const noOriginal = recurringSchema.safeParse({ ...baseForm, id: "item_1", accountId: "acc_1", nextDate: "2027-02-28" });
    eq("an edit that never says what the date was still anchors, as every save used to", noOriginal.success ? noOriginal.data.anchorDay : "rejected", 28);
    const newWithOriginal = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", nextDate: "2027-02-28", originalNextDate: "2027-02-28" });
    eq("a new item anchors even if an original date is sent (nothing to preserve)", newWithOriginal.success ? newWithOriginal.data.anchorDay : "rejected", 28);

    console.log("-- SEMI_MONTHLY: the second due day (pure) --");
    const semiForm = { ...baseForm, frequency: "SEMI_MONTHLY", accountId: "acc_1" };
    const missingSecond = recurringSchema.safeParse(semiForm);
    eq("a semi-monthly item needs a second due day", missingSecond.success ? "accepted" : missingSecond.error.issues[0]?.message, "Pick the second due day");
    for (const bad of ["0", "32", "-1", "2.5", "three"]) {
      const rejected = recurringSchema.safeParse({ ...semiForm, secondAnchorDay: bad });
      eq(`a second due day of "${bad}" is rejected`, rejected.success ? "accepted" : rejected.error.issues[0]?.message, "Use a day from 1 to 31");
    }
    const sameDay = recurringSchema.safeParse({ ...semiForm, secondAnchorDay: "1" }); // nextDate is 2026-09-01
    eq("a second due day equal to the first is rejected", sameDay.success ? "accepted" : sameDay.error.issues[0]?.message, "Pick two different days");
    eq("that error is translated for the Spanish UI", sameDay.success ? "accepted" : firstValidationError(sameDay.error, "es"), "Elige dos días diferentes");
    const semiOk = recurringSchema.safeParse({ ...semiForm, secondAnchorDay: "16" });
    eq("a valid pair saves with both anchors set", semiOk.success ? `${semiOk.data.anchorDay}/${semiOk.data.secondAnchorDay}` : "rejected", "1/16");
    const monthlyDropsSecond = recurringSchema.safeParse({ ...baseForm, accountId: "acc_1", secondAnchorDay: "16" });
    eq("a MONTHLY item drops a stale second due day left over from switching frequency back", monthlyDropsSecond.success ? String(monthlyDropsSecond.data.secondAnchorDay) : "rejected", "null");
    // secondAnchorDay is a plain, directly-entered field, unlike anchorDay -
    // an edit that resubmits the same stored value needs no re-anchor guard
    // and keeps recomputing nextDate exactly as typed, every time.
    const semiEditUnchanged = recurringSchema.safeParse({ ...semiForm, id: "item_1", secondAnchorDay: "16", originalNextDate: "2026-09-01" });
    eq("an edit that resubmits the same second day keeps it, with no special-casing", semiEditUnchanged.success ? semiEditUnchanged.data.secondAnchorDay : "rejected", 16);

    const semiAccount = await prisma.account.create({ data: { name: "Verify Semi Monthly Account", currency: "USD", type: "CHECKING" } });
    const semiCreated = recurringSchema.safeParse({ ...semiForm, secondAnchorDay: "16" });
    if (!semiCreated.success) throw new Error(`semi-monthly form rejected: ${semiCreated.error.issues[0]?.message}`);
    {
      const { createRecurringItem } = await import("../src/lib/data/recurring");
      const { id: _id, updatedAt: _updatedAt, ...values } = semiCreated.data;
      const created = await createRecurringItem({ ...values, accountId: semiAccount.id });
      check("createRecurringItem accepts a SEMI_MONTHLY item built by the form's own schema", created.ok, JSON.stringify(created));
      if (created.ok) {
        const row = await prisma.recurringItem.findUniqueOrThrow({ where: { id: created.id } });
        eq(
          "the row is a real SEMI_MONTHLY item with both anchors, exactly as the form collected them",
          `${row.frequency}/${row.anchorDay}/${row.secondAnchorDay}/${toISODate(row.nextDate)}`,
          "SEMI_MONTHLY/1/16/2026-09-01",
        );
        eq(
          "and owedOccurrences walks it correctly from here",
          owedOccurrences(row, civilDate(2026, 9, 1), civilDate(2026, 10, 1)).map(toISODate).join(","),
          "2026-09-01,2026-09-16,2026-10-01",
        );
        await prisma.recurringItem.delete({ where: { id: created.id } });
      }
    }
    await prisma.account.delete({ where: { id: semiAccount.id } });

    const anchorAccount = await prisma.account.create({ data: { name: "Verify Anchor Account", currency: "USD", type: "CHECKING" } });
    const anchored = await prisma.recurringItem.create({
      data: { name: "Verify Anchor 31", amount: 12, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2027, 2, 28), anchorDay: 31, accountId: anchorAccount.id },
    });
    const editForm = (overrides: Record<string, string>) => ({
      ...baseForm,
      id: anchored.id,
      updatedAt: anchored.updatedAt.toISOString(),
      name: anchored.name,
      accountId: anchorAccount.id,
      nextDate: "2027-02-28",
      originalNextDate: "2027-02-28",
      ...overrides,
    });
    const amountEdit = recurringSchema.safeParse(editForm({ amount: "15" }));
    if (!amountEdit.success) throw new Error(`anchor edit form rejected: ${amountEdit.error.issues[0]?.message}`);
    {
      const { id, updatedAt, ...values } = amountEdit.data;
      eq("the amount-only edit claims the row through the guarded write", (await prisma.recurringItem.updateMany({ where: updatedAt ? { id, updatedAt } : { id }, data: values })).count, 1);
    }
    const afterAmountEdit = await prisma.recurringItem.findUniqueOrThrow({ where: { id: anchored.id } });
    eq("editing the amount in February keeps the item anchored on the 31st", `${num(afterAmountEdit.amount)}:${afterAmountEdit.anchorDay}:${toISODate(afterAmountEdit.nextDate)}`, "15:31:2027-02-28");
    eq("so the next occurrence after the clamped February date is still March 31", toISODate(advanceDate(afterAmountEdit.nextDate, "MONTHLY", afterAmountEdit.anchorDay)), "2027-03-31");
    const dateEdit = recurringSchema.safeParse(editForm({ updatedAt: afterAmountEdit.updatedAt.toISOString(), nextDate: "2027-03-05" }));
    if (!dateEdit.success) throw new Error(`anchor date edit form rejected: ${dateEdit.error.issues[0]?.message}`);
    {
      const { id, updatedAt, ...values } = dateEdit.data;
      await prisma.recurringItem.updateMany({ where: updatedAt ? { id, updatedAt } : { id }, data: values });
    }
    const afterDateEdit = await prisma.recurringItem.findUniqueOrThrow({ where: { id: anchored.id } });
    eq("re-picking the due date re-anchors the item to the new day", `${afterDateEdit.anchorDay}:${toISODate(afterDateEdit.nextDate)}`, "5:2027-03-05");
    await prisma.recurringItem.delete({ where: { id: anchored.id } });
    await prisma.account.delete({ where: { id: anchorAccount.id } });
  }

  console.log("\n== recurring posting ==");
  {
    const { MAX_OCCURRENCES_PER_ITEM, postDueRecurringItems } = await import(
      "../src/lib/recurring-posting"
    );
    const postingToday = civilDate(2026, 8, 20);
    const postingAccount = await prisma.account.create({
      data: { name: "Verify Posting Account", currency: "USD", type: "CHECKING" },
    });
    const archivedPostingAccount = await prisma.account.create({
      data: { name: "Verify Posting Archived", currency: "USD", type: "CHECKING", status: "ARCHIVED", archivedAt: new Date() },
    });
    const postingGoal = await prisma.goal.create({
      data: { name: "Verify Posting Goal", targetAmount: 5000, currency: "USD" },
    });
    const postingSubsCategory = await prisma.category.findFirst({ where: { name: "Subscriptions" } });
    const base = { currency: "USD", frequency: "MONTHLY" as const, active: true };
    const monthlySub = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Netflix", amount: 15, kind: "SUBSCRIPTION", nextDate: civilDate(2026, 6, 15), accountId: postingAccount.id, categoryId: postingSubsCategory?.id ?? null },
    });
    const contribution = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Auto-Invest", amount: 100, kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 20), accountId: postingAccount.id, goalId: postingGoal.id, createdAt: civilDate(2026, 1, 1) },
    });
    const noAccountSub = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting No Account", amount: 9, kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 5) },
    });
    const noGoalContribution = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting No Goal", amount: 50, kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 1), accountId: postingAccount.id },
    });
    const bareContribution = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Bare Contribution", amount: 50, kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 1) },
    });
    const archivedSub = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Archived Sub", amount: 7, kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 10), accountId: archivedPostingAccount.id },
    });
    const pausedSub = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Paused", amount: 8, kind: "SUBSCRIPTION", nextDate: civilDate(2026, 7, 1), accountId: postingAccount.id, active: false },
    });
    const futureSub = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Future", amount: 11, kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 21), accountId: postingAccount.id },
    });
    // Jan 1 + 33 weeks = Aug 20, so 34 weekly occurrences are due on Aug 20.
    const weeklyBacklog = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Weekly Backlog", amount: 5, kind: "SUBSCRIPTION", frequency: "WEEKLY", nextDate: civilDate(2026, 1, 1), accountId: postingAccount.id },
    });
    const postedFor = (itemId: string) =>
      prisma.transaction.findMany({
        where: { source: "RECURRING", externalId: { startsWith: `${itemId}:` } },
        orderBy: { date: "asc" },
      });
    const nextDateOf = async (itemId: string) =>
      toISODate((await prisma.recurringItem.findUniqueOrThrow({ where: { id: itemId } })).nextDate);

    // Savings/investing for August before anything is posted, so the checks
    // below can assert exact deltas regardless of what else the database holds.
    // For a completed month the still-unposted contribution item is already
    // represented by its scheduled monthly amount (100), so posting it must
    // leave the total unchanged: the actual replaces the scheduled amount.
    const augustWindow = monthWindow({ year: 2026, month: 8 });
    const augustContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 8, 31), currentPeriod: periodForDate(civilDate(2026, 8, 31)) };
    const contributionForMatch = [{ ...contribution, amount: num(contribution.amount) }];
    const augustSavingsBefore = (await classifyCompletedMonth(augustWindow, augustContext, contributionForMatch, categoryMeta)).savingsInvesting;

    const firstRun = await postDueRecurringItems(postingToday);
    eq("summary reports the reference day", firstRun.today, "2026-08-20");
    eq("three linked items posted", firstRun.itemsPosted, 3);
    eq("3 monthly + 1 contribution + 24 capped weekly transactions created", firstRun.transactionsCreated, 28);
    eq("one goal contribution created", firstRun.goalContributionsCreated, 1);
    eq("four unlinked/archived items skipped", firstRun.itemsSkipped, 4);
    eq("one item hit the per-run cap with occurrences still due", firstRun.itemsCapped, 1);

    const netflixRows = await postedFor(monthlySub.id);
    eq("one transaction per elapsed monthly occurrence", netflixRows.length, 3);
    eq("occurrences are dated on their own due dates", netflixRows.map((row) => toISODate(row.date)).join(","), "2026-06-15,2026-07-15,2026-08-15");
    const netflixFirst = netflixRows[0];
    eq("posted row is an EXPENSE", netflixFirst.type, "EXPENSE");
    eq("posted row carries the RECURRING source", netflixFirst.source, "RECURRING");
    eq("posted row is charged to the item's account", netflixFirst.accountId, postingAccount.id);
    eq("posted row keeps the item's category", netflixFirst.categoryId, postingSubsCategory?.id ?? null);
    eq("posted row uses the item's amount", num(netflixFirst.amount), 15);
    eq("posted row uses the item's currency", netflixFirst.currency, "USD");
    eq("posted row's note is the item name", netflixFirst.note, "Verify Posting Netflix");
    eq("posted row's externalId pins the item and due date", netflixFirst.externalId, `${monthlySub.id}:2026-06-15`);
    eq("monthly item advanced past today", await nextDateOf(monthlySub.id), "2026-09-15");

    const contributionRows = await postedFor(contribution.id);
    eq("a contribution due today posts exactly once", contributionRows.length, 1);
    eq("the contribution's outgoing transaction is an EXPENSE from its account", `${contributionRows[0].type}:${contributionRows[0].accountId}`, `EXPENSE:${postingAccount.id}`);
    const goalRows = await prisma.goalContribution.findMany({ where: { goalId: postingGoal.id } });
    eq("one GoalContribution logged on the item's goal", goalRows.length, 1);
    eq("GoalContribution matches the item amount/currency/date", `${num(goalRows[0]?.amount)}:${goalRows[0]?.currency}:${toISODate(goalRows[0]!.date)}`, "100:USD:2026-08-20");
    eq("GoalContribution note is the item name", goalRows[0]?.note, "Verify Posting Auto-Invest");
    eq("Goal.savedAmount was recomputed from contributions", num((await prisma.goal.findUniqueOrThrow({ where: { id: postingGoal.id } })).savedAmount), 100);
    eq("contribution item advanced to next month", await nextDateOf(contribution.id), "2026-09-20");
    eq("an auto-posted GoalContribution is linked back to its recurring item", goalRows[0]?.recurringItemId, contribution.id);

    // The posted occurrence is one real contribution represented by two rows
    // (the EXPENSE Transaction the matcher finds, and the GoalContribution).
    // Savings/investing must count it once, not once per row.
    const augustSavingsAfterPosting = (await classifyCompletedMonth(augustWindow, augustContext, contributionForMatch, categoryMeta)).savingsInvesting;
    eq("an auto-posted contribution is counted exactly once in savings/investing", round2(augustSavingsAfterPosting - augustSavingsBefore), 0);
    // A manually-logged contribution has no recurring item behind it and keeps
    // counting on its own, exactly as before.
    const manualContribution = await prisma.goalContribution.create({
      data: { goalId: postingGoal.id, amount: 40, currency: "USD", date: civilDate(2026, 8, 12), note: "Verify Posting Manual Top-up" },
    });
    eq("a manually-logged GoalContribution carries no recurring item link", manualContribution.recurringItemId, null);
    const augustSavingsWithManual = (await classifyCompletedMonth(augustWindow, augustContext, contributionForMatch, categoryMeta)).savingsInvesting;
    eq("a manually-logged contribution still counts in full alongside the auto-posted one", round2(augustSavingsWithManual - augustSavingsBefore), 40);
    await prisma.goalContribution.delete({ where: { id: manualContribution.id } });

    const skipReason = (itemId: string) => firstRun.skipped.find((item) => item.id === itemId)?.reason;
    eq("subscription without an account is skipped", skipReason(noAccountSub.id), "missing_account");
    eq("contribution without a goal is skipped", skipReason(noGoalContribution.id), "missing_goal");
    eq("contribution with neither link is skipped", skipReason(bareContribution.id), "missing_account_and_goal");
    eq("subscription on an archived account is skipped", skipReason(archivedSub.id), "account_archived");
    eq("skipped entries carry the item name for the cron log", firstRun.skipped.find((item) => item.id === noAccountSub.id)?.name, "Verify Posting No Account");
    eq("a skipped item is never advanced", await nextDateOf(noAccountSub.id), "2026-08-05");
    eq("a skipped contribution is never advanced", await nextDateOf(noGoalContribution.id), "2026-08-01");
    eq("a skipped archived-account item is never advanced", await nextDateOf(archivedSub.id), "2026-08-10");
    eq("nothing is posted for skipped items", (await prisma.transaction.count({ where: { source: "RECURRING", externalId: { in: [`${noAccountSub.id}:2026-08-05`, `${noGoalContribution.id}:2026-08-01`, `${bareContribution.id}:2026-08-01`, `${archivedSub.id}:2026-08-10`] } } })), 0);
    eq("nothing is posted to the archived account", await prisma.transaction.count({ where: { accountId: archivedPostingAccount.id } }), 0);
    check("a paused item is neither posted nor reported", firstRun.skipped.every((item) => item.id !== pausedSub.id) && (await postedFor(pausedSub.id)).length === 0);
    eq("a paused item keeps its date", await nextDateOf(pausedSub.id), "2026-07-01");
    eq("an item due tomorrow is untouched", `${(await postedFor(futureSub.id)).length}:${await nextDateOf(futureSub.id)}`, "0:2026-08-21");

    eq("a long backlog posts at most the cap per run", (await postedFor(weeklyBacklog.id)).length, MAX_OCCURRENCES_PER_ITEM);
    eq("the cap is 24 occurrences", MAX_OCCURRENCES_PER_ITEM, 24);
    eq("the capped item's nextDate sits at the first unposted occurrence", await nextDateOf(weeklyBacklog.id), "2026-06-18");

    const secondRun = await postDueRecurringItems(postingToday);
    eq("second run posts only the backlog remainder", secondRun.transactionsCreated, 10);
    eq("second run posts no further goal contributions", secondRun.goalContributionsCreated, 0);
    eq("second run finishes the backlog", `${(await postedFor(weeklyBacklog.id)).length}:${await nextDateOf(weeklyBacklog.id)}`, "34:2026-08-27");
    eq("already-posted items are not posted again", `${(await postedFor(monthlySub.id)).length}:${(await postedFor(contribution.id)).length}`, "3:1");
    eq("the same four items are still reported as skipped", secondRun.itemsSkipped, 4);
    const thirdRun = await postDueRecurringItems(postingToday);
    eq("a fully caught-up run posts nothing", `${thirdRun.itemsPosted}:${thirdRun.transactionsCreated}:${thirdRun.goalContributionsCreated}`, "0:0:0");

    // Two overlapping runs (cron + a page load) must never double-post: the
    // nextDate compare-and-swap inside each occurrence's transaction lets
    // exactly one of them claim each occurrence.
    const contended = await prisma.recurringItem.create({
      data: { ...base, name: "Verify Posting Contended", amount: 3, kind: "CONTRIBUTION", nextDate: civilDate(2026, 5, 20), accountId: postingAccount.id, goalId: postingGoal.id },
    });
    const [runA, runB] = await Promise.all([postDueRecurringItems(postingToday), postDueRecurringItems(postingToday)]);
    eq("overlapping runs together post each occurrence exactly once", runA.transactionsCreated + runB.transactionsCreated, 4);
    eq("overlapping runs create exactly one transaction per occurrence", (await postedFor(contended.id)).length, 4);
    eq("overlapping runs create exactly one goal contribution per occurrence", await prisma.goalContribution.count({ where: { goalId: postingGoal.id, note: "Verify Posting Contended" } }), 4);
    eq("the contended item lands on the right nextDate", await nextDateOf(contended.id), "2026-09-20");
    eq("Goal.savedAmount reflects both items' contributions", num((await prisma.goal.findUniqueOrThrow({ where: { id: postingGoal.id } })).savedAmount), 112);

    // Once the missing link is set, the skipped item catches up from its
    // original (never advanced) nextDate.
    await prisma.recurringItem.update({ where: { id: noAccountSub.id }, data: { accountId: postingAccount.id } });
    const fixedRun = await postDueRecurringItems(postingToday);
    eq("linking the account lets the item post from its original due date", (await postedFor(noAccountSub.id)).map((row) => toISODate(row.date)).join(","), "2026-08-05");
    eq("the fixed item is no longer skipped", fixedRun.skipped.some((item) => item.id === noAccountSub.id), false);

    // A contribution to a goal that is already fully funded is skipped - not
    // posted, not advanced, not paused - and picks itself up again once the
    // target is raised above what has been saved.
    {
      const { describeRecurringPosting } = await import("../src/lib/recurring-posting");
      const { recomputeGoalSaved: recomputeForPosting } = await import("../src/lib/goals");
      const achievedGoal = await prisma.goal.create({ data: { name: "Verify Posting Achieved Goal", targetAmount: 50, currency: "USD" } });
      await prisma.goalContribution.create({ data: { goalId: achievedGoal.id, amount: 60, currency: "USD", date: civilDate(2026, 7, 1), note: "Verify Posting Achieved Seed" } });
      await recomputeForPosting(achievedGoal.id);
      check("the seed contribution marks the goal achieved", (await prisma.goal.findUniqueOrThrow({ where: { id: achievedGoal.id } })).achievedAt !== null);
      const achievedItem = await prisma.recurringItem.create({
        data: { ...base, name: "Verify Posting Achieved Contribution", amount: 10, kind: "CONTRIBUTION", nextDate: civilDate(2026, 7, 15), accountId: postingAccount.id, goalId: achievedGoal.id },
      });
      const achievedRun = await postDueRecurringItems(postingToday);
      eq("a contribution to a fully funded goal is skipped with its own reason", achievedRun.skipped.find((item) => item.id === achievedItem.id)?.reason, "goal_achieved");
      eq("nothing is posted for it", (await postedFor(achievedItem.id)).length, 0);
      eq("its nextDate does not advance", await nextDateOf(achievedItem.id), "2026-07-15");
      eq("it is neither paused nor deactivated", (await prisma.recurringItem.findUniqueOrThrow({ where: { id: achievedItem.id } })).active, true);
      eq("the goal's contributions are untouched", await prisma.goalContribution.count({ where: { goalId: achievedGoal.id } }), 1);
      eq("the cron summary names the reason", describeRecurringPosting(achievedRun).includes("Verify Posting Achieved Contribution (goal fully funded)"), true);
      await prisma.goal.update({ where: { id: achievedGoal.id }, data: { targetAmount: 1000 } });
      await recomputeForPosting(achievedGoal.id);
      eq("raising the target clears achievedAt", (await prisma.goal.findUniqueOrThrow({ where: { id: achievedGoal.id } })).achievedAt, null);
      const resumedRun = await postDueRecurringItems(postingToday);
      eq("the next run posts it normally again, catching up from its original due date", (await postedFor(achievedItem.id)).map((row) => toISODate(row.date)).join(","), "2026-07-15,2026-08-15");
      eq("and no longer reports it skipped", resumedRun.skipped.some((item) => item.id === achievedItem.id), false);
      eq("its nextDate has moved past today", await nextDateOf(achievedItem.id), "2026-09-15");
      eq("both occurrences reached the goal", await prisma.goalContribution.count({ where: { goalId: achievedGoal.id } }), 3);
      await prisma.goal.delete({ where: { id: achievedGoal.id } });
    }

    await prisma.transaction.deleteMany({ where: { accountId: { in: [postingAccount.id, archivedPostingAccount.id] } } });
    await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Posting" } } });
    await prisma.goal.delete({ where: { id: postingGoal.id } });
    await prisma.account.deleteMany({ where: { id: { in: [postingAccount.id, archivedPostingAccount.id] } } });
  }

  console.log("\n== recurring posting: SEMI_MONTHLY ==");
  {
    const { postDueRecurringItems: postSemiMonthly } = await import("../src/lib/recurring-posting");
    // Aug 1 2026 is a Saturday (shifts back into July); Aug 16 is a Sunday
    // (shifts back to Aug 14) - the same weekend- and month-crossing shift
    // the pure owedOccurrences checks exercise, now proven through the real
    // posting job end to end.
    const semiPostingToday = civilDate(2026, 8, 20);
    const semiPostingAccount = await prisma.account.create({
      data: { name: "Verify Semi Posting Account", currency: "USD", type: "CHECKING" },
    });
    const semiPostingItem = await prisma.recurringItem.create({
      data: {
        name: "Verify Semi Posting Rent",
        amount: 500,
        currency: "USD",
        frequency: "SEMI_MONTHLY",
        kind: "SUBSCRIPTION",
        nextDate: civilDate(2026, 7, 1),
        anchorDay: 1,
        secondAnchorDay: 16,
        accountId: semiPostingAccount.id,
      },
    });
    const semiPostedRows = () =>
      prisma.transaction.findMany({
        where: { source: "RECURRING", externalId: { startsWith: `${semiPostingItem.id}:` } },
        orderBy: { date: "asc" },
      });

    const semiRun = await postSemiMonthly(semiPostingToday);
    eq("the item posts", semiRun.itemsPosted, 1);
    eq("four transactions created - one per elapsed monthly occurrence on each anchor", semiRun.transactionsCreated, 4);
    const semiRows = await semiPostedRows();
    eq(
      "both of the item's monthly occurrences post, on their real weekend- and month-shifted dates",
      semiRows.map((row) => toISODate(row.date)).join(","),
      "2026-07-01,2026-07-16,2026-07-31,2026-08-14",
    );
    eq("each posted row carries the item's amount, account and RECURRING source", semiRows.every((row) => num(row.amount) === 500 && row.accountId === semiPostingAccount.id && row.source === "RECURRING"), true);
    eq(
      "the externalId pins the item to its own (real, shifted) due date, not the raw anchor day",
      semiRows.map((row) => row.externalId).join(","),
      [
        `${semiPostingItem.id}:2026-07-01`,
        `${semiPostingItem.id}:2026-07-16`,
        `${semiPostingItem.id}:2026-07-31`,
        `${semiPostingItem.id}:2026-08-14`,
      ].join(","),
    );
    const semiAfterFirstRun = await prisma.recurringItem.findUniqueOrThrow({ where: { id: semiPostingItem.id } });
    eq("the item advances past both anchors, landing on the next unposted (Sep 1, no shift)", toISODate(semiAfterFirstRun.nextDate), "2026-09-01");

    const semiSecondRun = await postSemiMonthly(semiPostingToday);
    eq("a fully caught-up run posts nothing more for it", (await semiPostedRows()).length, 4);
    check("the second run does not report it skipped or failed", !semiSecondRun.skipped.some((item) => item.id === semiPostingItem.id) && !semiSecondRun.failed.some((item) => item.id === semiPostingItem.id));

    await prisma.transaction.deleteMany({ where: { accountId: semiPostingAccount.id } });
    await prisma.recurringItem.delete({ where: { id: semiPostingItem.id } });
    await prisma.account.delete({ where: { id: semiPostingAccount.id } });
  }

  console.log("\n== afford: installment plans ==");
  {
    const affordLib = await import("../src/lib/afford");
    const affordData = await import("../src/lib/data/afford");
    const { postDueRecurringItems: postForAfford } = await import("../src/lib/recurring-posting");
    const { listRecurringItems } = await import("../src/lib/data/recurring");
    const { getPeriodSummary: periodSummaryForAfford } = await import("../src/lib/data/period-summary");
    const { confirmPaydayCheckin: confirmCheckinForAfford } = await import("../src/lib/data/payday");
    const { getDashboardData } = await import("../src/lib/data/dashboard");

    console.log("\n-- installment schedule (pure) --");
    eq("the split is always equal: 100 over 3 is 33.33 each", affordLib.equalInstallmentAmount(100, 3), 33.33);
    eq("the equal amount is rounded to the cent, up or down", `${affordLib.equalInstallmentAmount(1000, 7)}:${affordLib.equalInstallmentAmount(100, 6)}`, "142.86:16.67");
    eq("a single installment is the whole price", affordLib.equalInstallmentAmount(250.5, 1), 250.5);
    eq("zero installments or no price split into nothing", `${affordLib.equalInstallmentAmount(100, 0)}:${affordLib.equalInstallmentAmount(0, 3)}`, "0:0");
    eq("a price that rounds to nothing per installment is 0, not a fraction of a cent", affordLib.equalInstallmentAmount(0.01, 3), 0);
    const equalRows = affordLib.buildInstallments(affordLib.installmentDates(civilDate(2026, 10, 1), "MONTHLY", 3), affordLib.equalInstallmentAmount(100, 3));
    eq("every schedule row carries the same amount - no remainder on the last", equalRows.map((i) => i.amount).join(","), "33.33,33.33,33.33");
    eq("monthly dates anchor on the first payment's day through short months", affordLib.installmentDates(civilDate(2026, 1, 31), "MONTHLY", 3).map(toISODate).join(","), "2026-01-31,2026-02-28,2026-03-31");
    eq("biweekly dates step 14 days", affordLib.installmentDates(civilDate(2026, 10, 1), "BIWEEKLY", 3).map(toISODate).join(","), "2026-10-01,2026-10-15,2026-10-29");
    const biweeklyPlan = affordLib.buildInstallments(affordLib.installmentDates(civilDate(2026, 10, 1), "BIWEEKLY", 3), 100);
    eq("installments are bucketed into their pay periods with periodForDate", biweeklyPlan.map((i) => i.periodKey).join(","), "2026-10-A,2026-10-A,2026-10-B");
    const bucketTotals = affordLib.installmentTotalsByPeriod(biweeklyPlan);
    eq("two installments in one period are summed before evaluation", `${bucketTotals.get("2026-10-A")}:${bucketTotals.get("2026-10-B")}`, "200:100");
    {
      const { affordInputSchema: schema } = await import("../src/lib/validation");
      const base = { name: "Verify Afford Schema", totalAmount: 100, installments: 3, currency: "USD", frequency: "MONTHLY", firstDate: "2026-10-01", accountId: "acc_1", acknowledged: false };
      eq("the payload carries only the price and the count - no per-installment amounts", schema.safeParse(base).success ? Object.keys(schema.safeParse(base).data ?? {}).sort().join(",") : "rejected", "accountId,acknowledged,currency,firstDate,frequency,installments,name,totalAmount");
      const zeroPrice = schema.safeParse({ ...base, totalAmount: 0 });
      eq("a zero price is refused", zeroPrice.success ? "accepted" : zeroPrice.error.issues[0]?.message, "Enter a price greater than 0");
      const tooMany = schema.safeParse({ ...base, installments: 121 });
      eq("more than 120 installments is refused", tooMany.success ? "accepted" : tooMany.error.issues[0]?.message, "Use between 1 and 120 installments");
      const fractional = schema.safeParse({ ...base, installments: 2.5 });
      eq("a fractional count is refused", fractional.success ? "accepted" : fractional.error.issues[0]?.message, "Use between 1 and 120 installments");
      const tooSmall = schema.safeParse({ ...base, totalAmount: 0.01 });
      eq("a price that would post as 0 per installment is refused", tooSmall.success ? "accepted" : tooSmall.error.issues[0]?.message, "That price is too small to split into that many installments");
    }

    console.log("\n-- occurrence walk respects a finite item's countdown (pure) --");
    {
      const { owedOccurrences: owed } = await import("../src/lib/recurring");
      const weekly = { nextDate: civilDate(2026, 10, 1), frequency: "WEEKLY" as const, anchorDay: 1 };
      const window = [civilDate(2026, 10, 1), civilDate(2026, 10, 15)] as const;
      eq("an unbounded weekly item owes every date in the window", owed(weekly, ...window).map(toISODate).join(","), "2026-10-01,2026-10-08,2026-10-15");
      eq("a null countdown is unbounded too", owed({ ...weekly, remainingOccurrences: null }, ...window).length, 3);
      eq("a finite item owes only its remaining occurrences", owed({ ...weekly, remainingOccurrences: 2 }, ...window).map(toISODate).join(","), "2026-10-01,2026-10-08");
      eq("the countdown counts from nextDate, so an overdue backlog spends it too", owed({ ...weekly, nextDate: civilDate(2026, 9, 24), remainingOccurrences: 3 }, ...window).map(toISODate).join(","), "2026-09-24,2026-10-01,2026-10-08");
      eq("nothing left means nothing owed", owed({ ...weekly, remainingOccurrences: 0 }, ...window).length, 0);
    }

    console.log("\n-- comparable history walk --");
    const affordToday = civilDate(2026, 9, 7);
    eq("history skips comparable periods that have not ended yet", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday).map((p) => p.key).join(","), "2026-08-A,2026-07-A,2026-06-A,2026-05-A,2026-04-A,2026-03-A");
    eq("a far-off period resolves to the same completed history", affordData.comparableHistory({ year: 2027, month: 3, period: "A" }, affordToday)[0].key, "2026-08-A");
    eq("B periods walk back through B periods only", affordData.comparableHistory({ year: 2026, month: 10, period: "B" }, affordToday).map((p) => p.key).join(","), "2026-08-B,2026-07-B,2026-06-B,2026-05-B,2026-04-B,2026-03-B");
    eq("a period ending today has not ended", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, civilDate(2026, 9, 15))[0].key, "2026-08-A");
    eq("a period that ended yesterday counts", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, civilDate(2026, 9, 16))[0].key, "2026-09-A");
    // A period whose check-in is already confirmed is complete for this
    // purpose even before its calendar end: its income is known.
    const confirmedSepA = new Set(["2026-09-A"]);
    eq("a comparable period with a confirmed check-in counts before its dates have passed", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, confirmedSepA).map((p) => p.key).join(","), "2026-09-A,2026-08-A,2026-07-A,2026-06-A,2026-05-A,2026-04-A");
    eq("a far-off period walks past the unconfirmed future down to the confirmed one", affordData.comparableHistory({ year: 2027, month: 3, period: "A" }, affordToday, confirmedSepA)[0].key, "2026-09-A");
    eq("a confirmed period of the other half changes nothing for this half", affordData.comparableHistory({ year: 2026, month: 10, period: "B" }, affordToday, confirmedSepA)[0].key, "2026-08-B");
    eq("a confirmed period later than the target is not history for it", affordData.comparableHistory({ year: 2026, month: 9, period: "A" }, affordToday, confirmedSepA)[0].key, "2026-08-A");
    eq("an unconfirmed future period is still excluded", affordData.comparableHistory({ year: 2026, month: 11, period: "A" }, affordToday, new Set(["2026-09-B"]))[0].key, "2026-08-A");
    // Settings.incomeHistoryStartDate ("count income history from") is a
    // second boundary of the same kind as an account's first activity: a
    // comparable period that ended before it is not walked at all, and what
    // remains averages over its own count.
    eq("with no start date the walk is unchanged", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, new Set(), null).map((p) => p.key).join(","), "2026-08-A,2026-07-A,2026-06-A,2026-05-A,2026-04-A,2026-03-A");
    eq("a start date drops every comparable period that ended before it", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, new Set(), civilDate(2026, 6, 1)).map((p) => p.key).join(","), "2026-08-A,2026-07-A,2026-06-A");
    eq("a period ending on the start date itself still counts", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, new Set(), civilDate(2026, 5, 15)).map((p) => p.key).join(","), "2026-08-A,2026-07-A,2026-06-A,2026-05-A");
    eq("a period the start date falls inside counts in full", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, new Set(), civilDate(2026, 5, 10)).map((p) => p.key).join(","), "2026-08-A,2026-07-A,2026-06-A,2026-05-A");
    eq("a start date past every comparable period leaves nothing to average", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, new Set(), civilDate(2026, 9, 1)).length, 0);
    eq("the boundary is by period end, so B periods are bounded the same way (May 16-31 ends before June 1)", affordData.comparableHistory({ year: 2026, month: 10, period: "B" }, affordToday, new Set(), civilDate(2026, 6, 1)).map((p) => p.key).join(","), "2026-08-B,2026-07-B,2026-06-B");
    eq("the confirmed-period rule and the boundary compose", affordData.comparableHistory({ year: 2026, month: 10, period: "A" }, affordToday, confirmedSepA, civilDate(2026, 7, 1)).map((p) => p.key).join(","), "2026-09-A,2026-08-A,2026-07-A");
    {
      const { planningPreferencesSchema: prefs } = await import("../src/lib/validation");
      const prefsForm = { bufferPercent: "10", bufferFloorAmount: "2000", bufferFloorCurrency: "DOP", carryoverIncludedByDefault: "true" };
      const blankStart = prefs.safeParse({ ...prefsForm, incomeHistoryStartDate: "" });
      eq("the Settings form's blank start date saves as null (no boundary)", blankStart.success ? String(blankStart.data.incomeHistoryStartDate) : "refused", "null");
      const datedStart = prefs.safeParse({ ...prefsForm, incomeHistoryStartDate: "2026-06-01" });
      eq("a typed start date saves as that civil date", datedStart.success && datedStart.data.incomeHistoryStartDate instanceof Date ? toISODate(datedStart.data.incomeHistoryStartDate) : "refused", "2026-06-01");
      const junkStart = prefs.safeParse({ ...prefsForm, incomeHistoryStartDate: "June" });
      eq("an unparseable start date is refused", junkStart.success ? "accepted" : junkStart.error.issues[0]?.message, "Enter a valid date");
    }
    eq("averages run from the oldest period with activity, like category suggestions", JSON.stringify(affordData.averageSinceFirstActivity([100, 100, 0, 0, 0, 0])), JSON.stringify({ amount: 100, periods: 2 }));
    eq("zeros inside the active stretch still dilute", affordData.averageSinceFirstActivity([100, 0, 100, 0, 0, 0]).amount, 66.67);
    eq("no activity at all projects zero over zero periods", JSON.stringify(affordData.averageSinceFirstActivity([0, 0, 0])), JSON.stringify({ amount: 0, periods: 0 }));

    console.log("\n-- viability engine (pure) --");
    const projectionFor = (
      key: string,
      account: { income: number; committed: number; buffer: number; currency?: string },
      flexible: { income: number; committed: number; buffer: number },
    ) => {
      const info = periodInfo({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), period: key.slice(8) as "A" | "B" });
      return [key, {
        period: info,
        account: { accountId: "acc", name: "Checking", currency: account.currency ?? "USD", income: account.income, committed: account.committed, buffer: account.buffer, basis: "average" as const, estimatedGoalFunding: 0 },
        flexible: { currency: "USD", income: flexible.income, committed: flexible.committed, buffer: flexible.buffer, estimatedGoalFunding: 0 },
        estimatedGoals: [] as import("../src/lib/afford").EstimatedGoalFunding[],
        goalPlans: [] as import("../src/lib/afford").ProjectedGoalPlan[],
        historyPeriods: 6,
      }] as const;
    };
    const planOf = (dates: Date[], amount: number) => affordLib.buildInstallments(dates, amount);
    const octFirst = civilDate(2026, 10, 1);
    const viablePure = affordLib.evaluateAffordability({
      installments: planOf([octFirst], 500),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 })]),
      rates,
    });
    const vp = viablePure.periods[0];
    eq("account headroom before = income - commitments - buffer", vp.account.headroomBefore, 750);
    eq("account headroom after subtracts the installment", vp.account.headroomAfter, 250);
    eq("flexible available before is the check-in formula with the projected buffer", vp.flexible.availableBefore, 750);
    eq("flexible available after subtracts the installment", vp.flexible.availableAfter, 250);
    eq("both checks pass and the purchase is viable", `${vp.account.passes}:${vp.flexible.passes}:${viablePure.viable}`, "true:true:true");
    const exactBuffer = affordLib.evaluateAffordability({
      installments: planOf([octFirst], 750),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 })]),
      rates,
    });
    eq("landing exactly on the buffer still passes (at or above)", `${exactBuffer.periods[0].account.headroomAfter}:${exactBuffer.viable}`, "0:true");
    const accountBreach = affordLib.evaluateAffordability({
      installments: planOf([octFirst], 800),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 5000, committed: 150, buffer: 100 })]),
      rates,
    });
    eq("breaching the account buffer fails that check with the exact shortfall", `${accountBreach.periods[0].account.passes}:${accountBreach.periods[0].account.shortfall}`, "false:50");
    eq("the flexible check can pass while the account check fails", accountBreach.periods[0].flexible.passes, true);
    eq("one failed check makes the period and the purchase fail", `${accountBreach.periods[0].passes}:${accountBreach.viable}:${accountBreach.failing.length}`, "false:false:1");
    const flexibleBreach = affordLib.evaluateAffordability({
      installments: planOf([octFirst], 100),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 5000, committed: 0, buffer: 500 }, { income: 1000, committed: 800, buffer: 500 })]),
      rates,
    });
    eq("a period already in deficit fails the flexible check by the deficit plus the installment", `${flexibleBreach.periods[0].account.passes}:${flexibleBreach.periods[0].flexible.passes}:${flexibleBreach.periods[0].flexible.shortfall}`, "true:false:400");
    const summed = affordLib.evaluateAffordability({
      installments: planOf([octFirst, civilDate(2026, 10, 15)], 400),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 })]),
      rates,
    });
    eq("two installments in one period are judged on their sum, not one at a time", `${summed.periods.length}:${summed.periods[0].installmentTotal}:${summed.periods[0].account.headroomAfter}:${summed.viable}`, "1:800:-50:false");
    eq("the period verdict lists both installments", summed.periods[0].installments.map((i) => i.index).join(","), "1,2");
    const converted = affordLib.evaluateAffordability({
      installments: planOf([octFirst], 6000),
      currency: "DOP",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 })]),
      rates,
    });
    eq("an installment in another currency is converted into the account's before the check", `${converted.periods[0].account.installment}:${converted.periods[0].account.headroomAfter}`, "100:650");
    const multi = affordLib.evaluateAffordability({
      installments: planOf([octFirst, civilDate(2026, 11, 1)], 500),
      currency: "USD",
      projections: new Map([
        projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 }),
        projectionFor("2026-11-A", { income: 1000, committed: 650, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 }),
      ]),
      rates,
    });
    eq("the purchase is viable only when every affected period passes", `${multi.periods.map((p) => p.passes).join(",")}:${multi.viable}:${multi.failing.map((p) => p.key).join(",")}`, "true,false:false:2026-11-A");

    console.log("\n-- still viable? the tracker badge and the remaining schedule (pure) --");
    {
      const tracking = await import("../src/lib/afford-tracking");
      eq("every period passing is on track", tracking.summarizeAffordViability(viablePure).status, "on_track");
      const accountShort = tracking.summarizeAffordViability(accountBreach);
      eq("an account breach names the period and the account's shortfall in the account's currency", accountShort.status === "short" ? `${accountShort.periodKey}:${accountShort.shortfall}:${accountShort.currency}:${accountShort.check}` : accountShort.status, "2026-10-A:50:USD:account");
      const flexibleShort = tracking.summarizeAffordViability(flexibleBreach);
      eq("a flexible-only breach reports the period-wide shortfall in the display currency", flexibleShort.status === "short" ? `${flexibleShort.periodKey}:${flexibleShort.shortfall}:${flexibleShort.currency}:${flexibleShort.check}` : flexibleShort.status, "2026-10-A:400:USD:flexible");
      const laterShort = tracking.summarizeAffordViability(multi);
      eq("the first failing period is the one named, even when earlier periods pass", laterShort.status === "short" ? `${laterShort.periodKey}:${laterShort.periodLabel}:${laterShort.shortfall}` : laterShort.status, `2026-11-A:${periodInfo({ year: 2026, month: 11, period: "A" }).label}:250`);
      const walked = tracking.remainingInstallments({ nextDate: civilDate(2026, 1, 31), frequency: "MONTHLY", anchorDay: 31, remainingOccurrences: 3 }, 10, civilDate(2026, 1, 1), "2026-01-A");
      eq("the remaining schedule walks from nextDate on the stored anchor day (Jan 31 -> Feb 28 -> Mar 31), every row at the item's amount", walked.map((i) => `${i.index}:${toISODate(i.date)}:${i.amount}:${i.periodKey}`).join(","), "1:2026-01-31:10:2026-01-B,2:2026-02-28:10:2026-02-B,3:2026-03-31:10:2026-03-B");
      const overdueWalk = tracking.remainingInstallments({ nextDate: civilDate(2026, 8, 20), frequency: "MONTHLY", anchorDay: 20, remainingOccurrences: 2 }, 10, affordToday, periodForDate(affordToday).key);
      eq("an overdue occurrence is owed now and lands in the current period - Afford's own commitment rule", overdueWalk.map((i) => i.periodKey).join(","), "2026-09-A,2026-09-B");
      eq("a plan with nothing left owes no dates", tracking.remainingInstallments({ nextDate: civilDate(2026, 10, 1), frequency: "MONTHLY", anchorDay: 1, remainingOccurrences: 0 }, 10, affordToday, "2026-09-A").length, 0);
      eq("a missing anchor (a row written outside the app) falls back to the date's own day, as posting does", tracking.remainingInstallments({ nextDate: civilDate(2026, 10, 5), frequency: "MONTHLY", anchorDay: null, remainingOccurrences: 2 }, 10, affordToday, "2026-09-A").map((i) => toISODate(i.date)).join(","), "2026-10-05,2026-11-05");
      const tracked = [
        { itemId: "a", name: "A", verdict: viablePure },
        { itemId: "b", name: "B", verdict: accountBreach },
        { itemId: "c", name: "C", verdict: multi },
      ];
      eq("the not-viable list keeps only the plans with a failing period, in order", tracking.notViableAffordItems(tracked).map((t) => t.itemId).join(","), "b,c");
    }

    console.log("\n-- projected periods: income from history, commitments from schedules (database) --");
    const affordAccount = await prisma.account.create({
      data: { name: "Verify Afford Account", currency: "USD", type: "CHECKING" },
    });
    const affordSubsCategory = await prisma.category.findFirstOrThrow({ where: { isSubscriptionDefault: true } });
    // Six comparable A periods and six B periods (Mar-Aug 2026): 10,000 in,
    // plus recurring-source, subscription-category and ordinary spending -
    // none of which may feed the projected commitments any more, which come
    // from the recurring items' own schedules.
    for (let month = 3; month <= 8; month += 1) {
      for (const [day, half] of [[5, "A"], [20, "B"]] as const) {
        await prisma.transaction.create({
          data: { date: civilDate(2026, month, day), amount: 10000, currency: "USD", type: "INCOME", accountId: affordAccount.id, source: "MANUAL", note: "Verify Afford pay" },
        });
        await prisma.transaction.create({
          data: { date: civilDate(2026, month, day + 3), amount: 100, currency: "USD", type: "EXPENSE", accountId: affordAccount.id, source: "RECURRING", externalId: `verify-afford:${month}-${half}`, note: "Verify Afford sub" },
        });
        await prisma.transaction.create({
          data: { date: civilDate(2026, month, day + 4), amount: 50, currency: "USD", type: "EXPENSE", accountId: affordAccount.id, source: "MANUAL", categoryId: affordSubsCategory.id, note: "Verify Afford streaming" },
        });
        await prisma.transaction.create({
          data: { date: civilDate(2026, month, day + 5), amount: 999, currency: "USD", type: "EXPENSE", accountId: affordAccount.id, source: "MANUAL", note: "Verify Afford groceries" },
        });
      }
    }
    // Floor 2000 DOP at the fixture rate is 33.33 USD, so 10% of 10,000 wins.
    const affordContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: affordToday,
      currentPeriod: periodForDate(affordToday),
      bufferPercent: 10,
      bufferFloorAmount: 2000,
      bufferFloorCurrency: "DOP",
    };
    const activeForAfford = await prisma.account.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, currency: true } });
    const chosenForAfford = activeForAfford.find((a) => a.id === affordAccount.id)!;
    const octoberRefs = [{ year: 2026, month: 10, period: "A" as const }, { year: 2026, month: 10, period: "B" as const }];
    const beforeSchedules = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
    eq("projected income is the comparable-period average of what the account received", beforeSchedules.get("2026-10-A")!.account.income, 10000);
    eq("history no longer stands in for commitments: with no active item, nothing is committed", beforeSchedules.get("2026-10-A")!.account.committed, 0);
    const periodCommittedBeforeSchedules = beforeSchedules.get("2026-10-A")!.flexible.committed;
    // Real schedules: 150 monthly on the 5th from this account (A periods
    // only), and 30 monthly from no account at all (period-wide only).
    const rentItem = await prisma.recurringItem.create({
      data: { name: "Verify Afford Rent", amount: 150, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 5), anchorDay: 5, accountId: affordAccount.id },
    });
    await prisma.recurringItem.create({
      data: { name: "Verify Afford Unlinked", amount: 30, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 3), anchorDay: 3 },
    });
    const projections = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
    const octA = projections.get("2026-10-A")!;
    eq("commitments are the active items' actual occurrences in the period, in the account's currency", octA.account.committed, 150);
    eq("a monthly item due on the 5th commits nothing to the second half of the month", projections.get("2026-10-B")!.account.committed, 0);
    eq("an item with no account counts period-wide but against no account's buffer", round2(octA.flexible.committed - periodCommittedBeforeSchedules), 180);
    eq("the buffer is defaultProtectedBuffer over the projected income", octA.account.buffer, defaultProtectedBuffer(10000, 10, round2(2000 / 60)));
    eq("basis is average when history exists", octA.account.basis, "average");
    check("period-wide income adds the account's projection to every other active account's", octA.flexible.income >= 10000, octA.flexible.income);
    check("period-wide buffer includes the account's", octA.flexible.buffer >= 1000, octA.flexible.buffer);
    eq("B periods project from B history", projections.get("2026-10-B")!.account.income, 10000);

    console.log("\n-- count income history from: a global boundary on the comparable-period walk --");
    {
      // A second account whose income changed: 5,000 in Mar-May, nothing in
      // June, 8,000 from July (a new job whose first pay came late). The
      // steady account beside it keeps its 10,000 every period.
      const raiseAccount = await prisma.account.create({ data: { name: "Verify Afford Raise", currency: "USD", type: "CHECKING" } });
      for (const [month, amount] of [[3, 5000], [4, 5000], [5, 5000], [7, 8000], [8, 8000]] as const) {
        await prisma.transaction.create({
          data: { date: civilDate(2026, month, 5), amount, currency: "USD", type: "INCOME", accountId: raiseAccount.id, source: "MANUAL", note: "Verify Afford Raise pay" },
        });
      }
      const accountsWithRaise = [...activeForAfford, { id: raiseAccount.id, name: raiseAccount.name, currency: raiseAccount.currency }];
      const raiseChosen = accountsWithRaise[accountsWithRaise.length - 1];
      const octRef = [{ year: 2026, month: 10, period: "A" as const }];
      const projectRaise = async (incomeHistoryStartDate: Date | null | undefined, chosen = raiseChosen) =>
        (await affordData.projectPeriods(octRef, chosen, accountsWithRaise, incomeHistoryStartDate === undefined ? affordContext : { ...affordContext, incomeHistoryStartDate })).get("2026-10-A")!;

      const unbounded = await projectRaise(undefined);
      eq("with no boundary all six comparable periods count and the empty June dilutes: 31,000 / 6", unbounded.account.income, round2(31000 / 6));
      eq("historyPeriods reports the true count actually walked, unaffected by no boundary: 6", unbounded.historyPeriods, 6);
      const nullBounded = await projectRaise(null);
      eq("a null start date is no boundary at all - same account and period-wide figures", `${nullBounded.account.income}:${nullBounded.flexible.income}`, `${unbounded.account.income}:${unbounded.flexible.income}`);
      const fromJune = await projectRaise(civilDate(2026, 6, 1));
      eq("from June 1 only Jun, Jul and Aug count; the empty June sits before the first activity that remains, so the average is over the two paid periods", `${fromJune.account.income}:${fromJune.account.basis}`, "8000:average");
      eq("historyPeriods reports 3, not the HISTORY_PERIODS constant, once the boundary trims Mar/Apr/May out - what the Afford results copy reads", fromJune.historyPeriods, 3);
      const fromMay = await projectRaise(civilDate(2026, 5, 1));
      eq("from May 1 the empty June is inside the active stretch and dilutes, as averageSinceFirstActivity always did: 21,000 / 4", fromMay.account.income, 5250);
      eq("historyPeriods is 4 with the May 1 boundary (Mar and Apr dropped, May kept in full)", fromMay.historyPeriods, 4);
      const fromSeptember = await projectRaise(civilDate(2026, 9, 1));
      eq("a start date past every comparable period leaves no history: zero income on a 'none' basis, the floor as the buffer", `${fromSeptember.account.income}:${fromSeptember.account.basis}:${fromSeptember.account.buffer}`, `0:none:${round2(2000 / 60)}`);
      eq("historyPeriods is 0 when the boundary drops every comparable period, not the constant", fromSeptember.historyPeriods, 0);

      const steadyFromJune = await projectRaise(civilDate(2026, 6, 1), chosenForAfford);
      eq("the boundary is global: the steady account, asked with the same start date, still projects 10,000 over the three periods left", `${steadyFromJune.account.income}:${steadyFromJune.account.basis}`, "10000:average");
      const boundedContext = { ...affordContext, incomeHistoryStartDate: civilDate(2026, 6, 1) };
      const perAccount = await Promise.all(
        accountsWithRaise.map(async (account) => {
          const projection = (await affordData.projectPeriods(octRef, account, accountsWithRaise, boundedContext)).get("2026-10-A")!;
          return convert(projection.account.income, account.currency, "USD", rates);
        }),
      );
      eq("the period-wide income is every account's own bounded average summed - one boundary for all of them", steadyFromJune.flexible.income, round2(perAccount.reduce((sum, value) => sum + value, 0)));
      eq("the period-wide figure does not depend on which account is asked", round2(steadyFromJune.flexible.income - fromJune.flexible.income), 0);

      await prisma.transaction.deleteMany({ where: { accountId: raiseAccount.id } });
      await prisma.account.delete({ where: { id: raiseAccount.id } });
    }
    // A weekly item on the account is enumerated date by date, and its
    // currency is converted into the account's: 600 DOP a week is 10 USD.
    const weeklyItem = await prisma.recurringItem.create({
      data: { name: "Verify Afford Weekly DOP", amount: 600, currency: "DOP", frequency: "WEEKLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 2), anchorDay: 2, accountId: affordAccount.id },
    });
    const withWeekly = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
    eq("a weekly item contributes each due date (Oct 2, 9 in the first half; 16, 23, 30 in the second), converted", `${withWeekly.get("2026-10-A")!.account.committed}:${withWeekly.get("2026-10-B")!.account.committed}`, "170:30");
    await prisma.recurringItem.delete({ where: { id: weeklyItem.id } });
    void rentItem;

    const affordInput = (over: Partial<AffordInput> = {}): AffordInput => ({
      name: "Verify Afford Laptop",
      currency: "USD",
      frequency: "MONTHLY",
      firstDate: civilDate(2026, 10, 1),
      accountId: affordAccount.id,
      totalAmount: 1500,
      installments: 3,
      acknowledged: false,
      ...over,
    });
    const viable = await affordData.evaluateAffordRequest(affordInput(), affordContext);
    if (!viable.ok) throw new Error("viable evaluation refused");
    eq("three monthly installments touch three periods", viable.verdict.periods.map((p) => p.key).join(","), "2026-10-A,2026-11-A,2026-12-A");
    eq("account headroom before is income - commitments - buffer", viable.verdict.periods[0].account.headroomBefore, 8850);
    eq("account headroom after subtracts the installment", viable.verdict.periods[0].account.headroomAfter, 8350);
    eq("flexible available after is before less the installment", round2(viable.verdict.periods[0].flexible.availableBefore - viable.verdict.periods[0].flexible.availableAfter), 500);
    eq("every period passes both checks", viable.verdict.periods.every((p) => p.account.passes && p.flexible.passes), true);
    eq("the purchase is viable with no failing periods", `${viable.verdict.viable}:${viable.verdict.failing.length}`, "true:0");
    eq("the recorded plan is 500 x 3 monthly from Oct 1", `${viable.recorded.amount}:${viable.recorded.count}:${viable.recorded.frequency}:${toISODate(viable.recorded.firstDate)}`, "500:3:MONTHLY:2026-10-01");
    eq("the amount the checks subtracted is the amount that would be recorded", viable.verdict.installments.every((i) => i.amount === viable.recorded.amount), true);
    eq("evaluating writes nothing (only the two schedule fixtures exist)", await prisma.recurringItem.count({ where: { name: { startsWith: "Verify Afford" } } }), 2);

    // Borderline: 8,500 a month fits with 350 to spare while nothing else is
    // recorded. The laptop confirmed below must change that.
    const borderlineBefore = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Borderline", totalAmount: 25500 }), affordContext);
    if (!borderlineBefore.ok) throw new Error("borderline evaluation refused");
    eq("a borderline purchase is viable before anything else is recorded", `${borderlineBefore.verdict.viable}:${borderlineBefore.verdict.periods[0].account.headroomAfter}`, "true:350");

    // Biweekly from Oct 1: Oct 1 and Oct 15 both land in Oct 1-15 (10,000
    // together), Oct 29 in Oct 16-31 - so one period breaches and one does not.
    const breach = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford TV", frequency: "BIWEEKLY", totalAmount: 15000 }), affordContext);
    if (!breach.ok) throw new Error("breach evaluation refused");
    eq("two installments in Oct 1-15 are evaluated together", `${breach.verdict.periods[0].key}:${breach.verdict.periods[0].installmentTotal}`, "2026-10-A:10000");
    eq("Oct 1-15 breaches the account buffer by exactly the overrun", `${breach.verdict.periods[0].account.passes}:${breach.verdict.periods[0].account.shortfall}`, "false:1150");
    eq("Oct 16-31 with a single installment still passes", `${breach.verdict.periods[1].key}:${breach.verdict.periods[1].passes}`, "2026-10-B:true");
    eq("the purchase is not viable", breach.verdict.viable, false);
    eq("exactly the breached period is reported", breach.verdict.failing.map((p) => p.key).join(","), "2026-10-A");

    const emptyAccount = await prisma.account.create({ data: { name: "Verify Afford Empty", currency: "USD", type: "CHECKING" } });
    const noHistory = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Nothing", accountId: emptyAccount.id, totalAmount: 100, installments: 1 }), affordContext);
    if (!noHistory.ok) throw new Error("no-history evaluation refused");
    eq("an account with no income history projects zero income on a 'none' basis", `${noHistory.verdict.periods[0].account.income}:${noHistory.verdict.periods[0].account.basis}`, "0:none");
    eq("its buffer is the floor, so any installment fails by floor plus installment", `${noHistory.verdict.periods[0].account.buffer}:${noHistory.verdict.periods[0].account.shortfall}`, "33.33:133.33");
    await prisma.account.update({ where: { id: emptyAccount.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    const archivedPick = await affordData.evaluateAffordRequest(affordInput({ accountId: emptyAccount.id }), affordContext);
    eq("an archived account cannot be picked", archivedPick.ok ? "evaluated" : archivedPick.reason, "account_not_active");

    console.log("\n-- I bought this --");
    const refused = await affordData.confirmAffordPurchase(affordInput({ name: "Verify Afford TV", frequency: "BIWEEKLY", totalAmount: 15000 }), affordContext);
    eq("a non-viable purchase is refused without the acknowledgement", refused.ok ? "created" : refused.reason, "not_acknowledged");
    eq("a refused confirm writes nothing", await prisma.recurringItem.count({ where: { name: "Verify Afford TV" } }), 0);
    const confirmed = await affordData.confirmAffordPurchase(affordInput(), affordContext);
    check("a viable purchase is recorded with no checkbox", confirmed.ok);
    const createdPlans = await prisma.recurringItem.findMany({ where: { name: "Verify Afford Laptop" } });
    eq("exactly one RecurringItem is created", createdPlans.length, 1);
    const plan = createdPlans[0];
    eq("it is a SUBSCRIPTION with the chosen amount, currency, frequency, first date and account, counting 3, marked as from Afford", `${plan.kind}:${num(plan.amount)}:${plan.currency}:${plan.frequency}:${toISODate(plan.nextDate)}:${plan.anchorDay}:${plan.accountId === affordAccount.id}:${plan.active}:${plan.remainingOccurrences}:${plan.fromAfford}`, "SUBSCRIPTION:500:USD:MONTHLY:2026-10-01:1:true:true:3:true");
    eq("nothing else is set on it", `${plan.categoryId}:${plan.goalId}:${plan.note}`, "null:null:null");
    eq("confirming adds exactly one item beside the two schedule fixtures", await prisma.recurringItem.count({ where: { name: { startsWith: "Verify Afford" } } }), 3);
    eq("the two schedule fixtures, written by hand, are not from Afford", await prisma.recurringItem.count({ where: { name: { startsWith: "Verify Afford" }, fromAfford: false } }), 2);

    console.log("\n-- still viable? re-checking the plan right after confirming --");
    // The plan is now among the active items, so its own installments would
    // be counted as commitments and then subtracted again. The re-check takes
    // them back out, so it asks exactly the question Afford answered a moment
    // ago - and, with nothing else recorded since, gets the same answer.
    const laptopRecheck = await affordData.recheckAffordItem(plan.id, affordContext);
    if (!laptopRecheck.ok) throw new Error(`laptop re-check refused: ${laptopRecheck.reason}`);
    eq("re-checking reproduces the verdict that was confirmed: same periods, same headroom", `${laptopRecheck.verdict.viable}:${laptopRecheck.verdict.periods.map((p) => `${p.key}=${p.account.headroomAfter}`).join(",")}`, `${viable.verdict.viable}:${viable.verdict.periods.map((p) => `${p.key}=${p.account.headroomAfter}`).join(",")}`);
    eq("its installments are the item's own remaining schedule, at the recorded amount", laptopRecheck.verdict.installments.map((i) => `${toISODate(i.date)}:${i.amount}`).join(","), "2026-10-01:500,2026-11-01:500,2026-12-01:500");
    eq("the item's own occurrences are not counted twice: committed is what it was before the plan existed", `${laptopRecheck.verdict.periods[0].account.committed}:${round2(laptopRecheck.verdict.periods[0].flexible.committed - octA.flexible.committed)}`, "150:0");
    eq("the verdict is Afford's own shape, so the results table can render it", `${laptopRecheck.verdict.currency}:${laptopRecheck.verdict.periods[0].account.name}:${laptopRecheck.verdict.failing.length}`, "USD:Verify Afford Account:0");

    console.log("\n-- a confirmed plan counts against the next calculation before it posts --");
    const stacked = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Phone", firstDate: civilDate(2026, 10, 10), totalAmount: 900 }), affordContext);
    if (!stacked.ok) throw new Error("stacked evaluation refused");
    eq("a second purchase sees the first one's unposted installments as commitments", stacked.verdict.periods.map((p) => `${p.key}:${p.account.committed}`).join(","), "2026-10-A:650,2026-11-A:650,2026-12-A:650");
    eq("its headroom drops by exactly the first plan's installment", stacked.verdict.periods[0].account.headroomBefore, 8350);
    eq("the period-wide check sees the first plan too", round2(stacked.verdict.periods[0].flexible.committed - octA.flexible.committed), 500);
    eq("none of the first plan's installments has posted yet", await prisma.transaction.count({ where: { source: "RECURRING", externalId: { startsWith: `${plan.id}:` } } }), 0);
    const borderlineAfter = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Borderline", totalAmount: 25500 }), affordContext);
    if (!borderlineAfter.ok) throw new Error("borderline re-evaluation refused");
    eq("the borderline purchase flips to not viable alongside the recorded plan, short by its installment less the old spare", `${borderlineAfter.verdict.viable}:${borderlineAfter.verdict.failing.map((p) => p.key).join(",")}:${borderlineAfter.verdict.periods[0].account.shortfall}`, "false:2026-10-A,2026-11-A,2026-12-A:150");
    const beyond = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Long", totalAmount: 600, installments: 6 }), affordContext);
    if (!beyond.ok) throw new Error("long evaluation refused");
    eq("a finite plan stops committing once its countdown runs out", beyond.verdict.periods.map((p) => `${p.key}:${p.account.committed}`).join(","), "2026-10-A:650,2026-11-A:650,2026-12-A:650,2027-01-A:150,2027-02-A:150,2027-03-A:150");

    // A price that does not divide evenly: every row, every check and the
    // recorded item all carry the one rounded amount - nothing is averaged
    // and no row absorbs a remainder that could never post.
    const oddPlan = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Odd", totalAmount: 100 }), affordContext);
    if (!oddPlan.ok) throw new Error("odd evaluation refused");
    eq("100 over 3 evaluates three rows of 33.33", oddPlan.verdict.installments.map((i) => i.amount).join(","), "33.33,33.33,33.33");
    eq("each affected period subtracts exactly that row", oddPlan.verdict.periods.map((p) => p.installmentTotal).join(","), "33.33,33.33,33.33");
    eq("the recorded amount is that same row, not a mean of anything", oddPlan.recorded.amount, 33.33);
    const oddConfirm = await affordData.confirmAffordPurchase(affordInput({ name: "Verify Afford Odd", totalAmount: 100 }), affordContext);
    check("the odd-priced plan is recorded", oddConfirm.ok);
    const oddItem = await prisma.recurringItem.findFirstOrThrow({ where: { name: "Verify Afford Odd" } });
    eq("the RecurringItem amount matches every schedule row exactly", `${num(oddItem.amount)}:${oddPlan.verdict.installments.every((i) => i.amount === num(oddItem.amount))}:${oddItem.remainingOccurrences}`, "33.33:true:3");

    const acknowledgedConfirm = await affordData.confirmAffordPurchase(affordInput({ name: "Verify Afford TV", frequency: "BIWEEKLY", totalAmount: 15000, acknowledged: true }), affordContext);
    check("an acknowledged non-viable purchase is recorded", acknowledgedConfirm.ok);
    eq("the acknowledged plan counts its three installments", (await prisma.recurringItem.findFirstOrThrow({ where: { name: "Verify Afford TV" } })).remainingOccurrences, 3);
    const afterTv = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford After TV", frequency: "BIWEEKLY", totalAmount: 300 }), affordContext);
    if (!afterTv.ok) throw new Error("after-TV evaluation refused");
    eq("a biweekly plan's two first-half installments and one second-half installment are enumerated exactly", `${afterTv.verdict.periods[0].account.committed}:${afterTv.verdict.periods[1].account.committed}`, `${round2(150 + 500 + 33.33 + 10000)}:${5000}`);

    console.log("\n-- still viable? a later commitment shrinks the room a confirmed plan was counting on --");
    {
      const tracking = await import("../src/lib/afford-tracking");
      const tvItem = await prisma.recurringItem.findFirstOrThrow({ where: { name: "Verify Afford TV" } });
      eq("every plan Afford confirmed is marked as from Afford", `${oddItem.fromAfford}:${tvItem.fromAfford}`, "true:true");
      // The acknowledged TV plan owes 10,000 in Oct 1-15 on the same account.
      // The laptop's first installment shares that period, so the room it
      // was confirmed against is gone: 10,000 in, 150 + 33.33 + 10,000 owed
      // by the others, 1,000 kept back - 1,183.33 below the buffer before
      // its own 500 lands.
      const laptopAfterTv = await affordData.recheckAffordItem(plan.id, affordContext);
      if (!laptopAfterTv.ok) throw new Error(`laptop re-check refused: ${laptopAfterTv.reason}`);
      eq("the laptop is no longer viable: Oct 1-15 fails, the later periods still pass", `${laptopAfterTv.verdict.viable}:${laptopAfterTv.verdict.failing.map((p) => p.key).join(",")}:${laptopAfterTv.verdict.periods.map((p) => p.passes).join(",")}`, "false:2026-10-A:false,true,true");
      eq("the shortfall is exactly the room the TV plan took", `${laptopAfterTv.verdict.periods[0].account.committed}:${laptopAfterTv.verdict.periods[0].account.shortfall}`, "10183.33:1683.33");
      const laptopBadge = tracking.summarizeAffordViability(laptopAfterTv.verdict);
      eq("the badge names Oct 1-15 and the account shortfall", laptopBadge.status === "short" ? `${laptopBadge.periodKey}:${laptopBadge.shortfall}:${laptopBadge.currency}` : laptopBadge.status, "2026-10-A:1683.33:USD");

      const tracked = await affordData.recheckAffordItems(affordContext);
      eq("every active Afford plan with payments left is tracked - the hand-written schedule fixtures are not", tracked.map((t) => t.name).sort().join(","), "Verify Afford Laptop,Verify Afford Odd,Verify Afford TV");
      eq("all three share Oct 1-15, so all three are short there - the count the nav badge shows", tracking.notViableAffordItems(tracked).length, 3);
      eq("the period is over-committed as a whole, so each plan lands in the same place whichever is asked", tracked.map((t) => t.verdict.periods[0].account.headroomAfter).join(","), "-1683.33,-1683.33,-1683.33");

      // Resolving it: pausing the TV plan frees the room again, and the
      // paused plan itself drops out of the tracker - it owes nothing.
      await prisma.recurringItem.update({ where: { id: tvItem.id }, data: { active: false } });
      const resolved = await affordData.recheckAffordItems(affordContext);
      eq("with the TV plan paused, the other two are on track again and the paused plan is not tracked", `${resolved.map((t) => t.name).sort().join(",")}:${tracking.notViableAffordItems(resolved).length}`, "Verify Afford Laptop,Verify Afford Odd:0");
      eq("a paused plan is not re-checked on its own either", (await affordData.recheckAffordItem(tvItem.id, affordContext) as { ok: boolean; reason?: string }).reason, "no_remaining_schedule");
      await prisma.recurringItem.update({ where: { id: tvItem.id }, data: { active: true } });
      eq("resuming it puts the shortfall back", tracking.notViableAffordItems(await affordData.recheckAffordItems(affordContext)).length, 3);

      eq("a hand-entered item is refused by the re-check, countdown or not", (await affordData.recheckAffordItem(rentItem.id, affordContext) as { ok: boolean; reason?: string }).reason, "not_from_afford");
      eq("a missing item reports not_found", (await affordData.recheckAffordItem("missing", affordContext) as { ok: boolean; reason?: string }).reason, "not_found");

      // An Afford plan whose account has since been archived: the per-account
      // check has nothing to run against, so there is no verdict and it is not
      // tracked; the Recurring page's "needs an account" flag covers it.
      const orphan = await prisma.recurringItem.create({
        data: { name: "Verify Afford Orphan", amount: 10, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 1), anchorDay: 1, remainingOccurrences: 2, fromAfford: true, accountId: emptyAccount.id },
      });
      eq("a plan on an archived account cannot be re-checked", (await affordData.recheckAffordItem(orphan.id, affordContext) as { ok: boolean; reason?: string }).reason, "account_not_active");
      const withOrphan = await affordData.recheckAffordItems(affordContext);
      eq("it is left out of the tracked list rather than counted as short", `${withOrphan.some((t) => t.itemId === orphan.id)}:${tracking.notViableAffordItems(withOrphan).length}`, "false:3");
      await prisma.recurringItem.delete({ where: { id: orphan.id } });
    }

    const listedPlans = await listRecurringItems(affordContext);
    const laptopRow = listedPlans.fromAfford.find((row) => row.id === plan.id);
    eq("the plan appears in the Recurring page's From Afford section with its countdown", `${laptopRow?.active}:${laptopRow?.remainingOccurrences}:${laptopRow?.needs}:${laptopRow?.fromAfford}`, "true:3:null:true");
    eq("and never among the subscriptions or contributions, whatever its kind", `${listedPlans.subscriptions.some((row) => row.fromAfford)}:${listedPlans.contributions.some((row) => row.fromAfford)}:${listedPlans.fromAfford.every((row) => row.fromAfford)}`, "false:false:true");
    eq("the hand-written schedule fixtures stay among the subscriptions", `${listedPlans.subscriptions.some((row) => row.id === rentItem.id)}:${listedPlans.fromAfford.some((row) => row.id === rentItem.id)}`, "true:false");
    eq("the From Afford section carries its own monthly figure (500 + 33.33 + 5,000 x 26 / 12)", listedPlans.fromAffordMonthly, 11366.66);
    const octSummary = await periodSummaryForAfford(periodInfo({ year: 2026, month: 10, period: "A" }), affordContext);
    eq("the plan is committed in the period its first installment lands in", octSummary.committedItems.find((i) => i.id === plan.id)?.nativeAmount, 500);

    console.log("\n-- what the rest of the app already knows: achieved goals and confirmed goal plans --");
    {
      const { getGoalRoadmapAmount: roadmapForAfford, planPeriodRef: planRefForAfford } = await import("../src/lib/data/payday");
      const { planGoalFunding: planFundingForAfford } = await import("../src/lib/payday");
      // What a period owes from schedules (and a confirmed check-in) alone:
      // `committed` less the goal estimate an unconfirmed period carries.
      const scheduledOf = (figures: { committed: number; estimatedGoalFunding: number }) => round2(figures.committed - figures.estimatedGoalFunding);
      const noGoals = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
      eq("with no goal to save for, a period with no check-in estimates nothing toward one", `${noGoals.get("2026-10-A")!.account.estimatedGoalFunding}:${noGoals.get("2026-10-A")!.flexible.estimatedGoalFunding}:${noGoals.get("2026-10-A")!.estimatedGoals.length}`, "0:0:0");

      // Two contributions on the account, one to a goal that has already
      // reached its target. Posting skips that one (goal_achieved, see
      // skipReasonFor in recurring-posting.ts), so Afford must not count it
      // either; the other counts like any subscription.
      const achievedGoal = await prisma.goal.create({
        data: { name: "Verify Afford Goal Achieved", targetAmount: 100, currency: "USD", savedAmount: 100, achievedAt: civilDate(2026, 8, 1) },
      });
      const openGoal = await prisma.goal.create({
        data: { name: "Verify Afford Goal Open", targetAmount: 5000, currency: "USD", targetDate: civilDate(2027, 6, 30) },
      });
      const baseline = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);

      console.log("\n-- a period with no check-in yet is estimated to keep funding each open goal at its pace --");
      // Neither October period has a check-in, so nothing real says what
      // either will put toward the open goal. Its pace as of today -
      // getGoalRoadmapAmount over the plan period, the figure the Goals page
      // shows: 5,000 over the 20 periods from Sep 1-15 to Jun 30, 2027 -
      // stands in, labelled as an estimate; the achieved goal has no pace and
      // adds nothing. Oct 16-31 has room for it. Oct 1-15 does not: the TV
      // plan's two installments, the laptop's first and the rent already take
      // the account past its income less its buffer, and no other account has
      // room there either - so, exactly as Step 3 would recommend nothing
      // from accounts with nothing to spare, nothing is estimated.
      const openPace = await roadmapForAfford(openGoal.id, planRefForAfford(affordContext), affordContext);
      eq("the open goal's pace as of today is 5,000 over 20 periods", openPace, 250);
      const octEstimated = baseline.get("2026-10-B")!;
      const octNoGoals = noGoals.get("2026-10-B")!;
      eq("a period with no check-in carries that pace as a named estimate", JSON.stringify(octEstimated.estimatedGoals), JSON.stringify([{ goalId: openGoal.id, name: "Verify Afford Goal Open", amount: 250 }]));
      eq("an achieved goal is estimated nothing", octEstimated.estimatedGoals.some((goal) => goal.goalId === achievedGoal.id), false);
      eq("the estimate is in the period-wide commitments", round2(octEstimated.flexible.committed - octNoGoals.flexible.committed), 250);
      eq("and reported apart as their estimated share", octEstimated.flexible.estimatedGoalFunding, 250);
      check("the account's share of it is committed against its buffer", octEstimated.account.estimatedGoalFunding > 0 && octEstimated.account.estimatedGoalFunding <= 250, octEstimated.account.estimatedGoalFunding);
      eq("the account's commitments grew by exactly that share", round2(octEstimated.account.committed - octNoGoals.account.committed), octEstimated.account.estimatedGoalFunding);
      const estimatePurchase = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Estimate Purchase", firstDate: civilDate(2026, 10, 20), totalAmount: 100, installments: 1 }), affordContext);
      if (!estimatePurchase.ok) throw new Error("estimate purchase evaluation refused");
      const estimateVerdict = estimatePurchase.verdict.periods[0];
      const noGoalsVerdict = affordLib.evaluateAffordability({ installments: estimatePurchase.verdict.installments, currency: "USD", projections: noGoals, rates }).periods[0];
      eq("the purchase lands in Oct 16-31", estimateVerdict.key, "2026-10-B");
      eq("the estimate shrinks the room a purchase is judged against, period-wide", round2(noGoalsVerdict.flexible.availableBefore - estimateVerdict.flexible.availableBefore), 250);
      eq("and on the account, by its share", round2(noGoalsVerdict.account.headroomBefore - estimateVerdict.account.headroomBefore), octEstimated.account.estimatedGoalFunding);
      eq("the verdict carries the named estimate through for the results page", JSON.stringify(estimateVerdict.estimatedGoals), JSON.stringify(octEstimated.estimatedGoals));
      eq("and the estimated share of each check's commitments", `${estimateVerdict.account.estimatedGoalFunding}:${estimateVerdict.flexible.estimatedGoalFunding}`, `${octEstimated.account.estimatedGoalFunding}:250`);
      // The pace is spread over the accounts exactly as a check-in spreads a
      // goal's roadmap amount: planGoalFunding over each account's projected
      // headroom (income - scheduled commitments - buffer), never more than
      // the account has, and the shares add up to the period-wide figure.
      const perAccount = await Promise.all(activeForAfford.map((account) => affordData.projectPeriods(octoberRefs, account, activeForAfford, affordContext)));
      const headroomsIn = (key: string) =>
        activeForAfford.map((account, index) => {
          const own = perAccount[index].get(key)!.account;
          return { accountId: account.id, name: account.name, currency: account.currency, headroom: round2(own.income - scheduledOf(own) - own.buffer) };
        });
      const expectedDraws = planFundingForAfford([{ goalId: openGoal.id, amount: 250 }], headroomsIn("2026-10-B"), { displayCurrency: "USD", rates })[0].draws;
      eq("each account's share is planGoalFunding's draw over the accounts' projected headroom", activeForAfford.map((_, index) => perAccount[index].get("2026-10-B")!.account.estimatedGoalFunding).join(","), activeForAfford.map((account) => expectedDraws.find((draw) => draw.accountId === account.id)?.recommendedAmount ?? 0).join(","));
      eq("the shares sum to the period-wide estimate", round2(activeForAfford.reduce((sum, account, index) => sum + convert(perAccount[index].get("2026-10-B")!.account.estimatedGoalFunding, account.currency, "USD", rates), 0)), 250);
      check("Oct 1-15 leaves no account any room above its buffer", headroomsIn("2026-10-A").every((account) => account.headroom <= 0), JSON.stringify(headroomsIn("2026-10-A")));
      eq("so nothing is estimated there: the estimate never plans money that is not there", `${baseline.get("2026-10-A")!.flexible.estimatedGoalFunding}:${baseline.get("2026-10-A")!.estimatedGoals.length}`, "0:0");
      // A second open goal: each contributes its own pace, oldest goal first
      // out of one pool of headroom, the order Step 3 funds them in.
      const secondGoal = await prisma.goal.create({
        data: { name: "Verify Afford Goal Second", targetAmount: 3000, currency: "USD", targetDate: civilDate(2027, 3, 31) },
      });
      const twoGoals = (await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext)).get("2026-10-B")!;
      eq("a second open goal is estimated at its own pace (3,000 over 14 periods) beside the first", JSON.stringify(twoGoals.estimatedGoals), JSON.stringify([{ goalId: openGoal.id, name: "Verify Afford Goal Open", amount: 250 }, { goalId: secondGoal.id, name: "Verify Afford Goal Second", amount: 214.29 }]));
      eq("the period-wide estimate is the two paces summed", twoGoals.flexible.estimatedGoalFunding, 464.29);
      eq("and the commitments grew by that sum", round2(twoGoals.flexible.committed - octNoGoals.flexible.committed), 464.29);
      // An undated goal: its roadmap figure is its whole remaining balance -
      // right for the one period a check-in plans, and what the Goals page
      // and the wizard keep recommending - but repeated in every period ahead
      // it would commit the same money once per period. Afford estimates
      // nothing for it, in any period, while the dated goals' paces go on
      // being estimated exactly as before.
      const undatedGoal = await prisma.goal.create({ data: { name: "Verify Afford Goal Undated", targetAmount: 2000, currency: "USD" } });
      eq("the undated goal's own roadmap figure is still its whole remaining balance", await roadmapForAfford(undatedGoal.id, planRefForAfford(affordContext), affordContext), 2000);
      eq("the payday draft still recommends that whole balance for it, for the one period it plans", (await getPaydayCheckinDraft(affordContext)).goals.find((g) => g.goalId === undatedGoal.id)?.recommendedAmount, 2000);
      const spanning = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Spanning", firstDate: civilDate(2026, 10, 20), totalAmount: 300, installments: 3 }), affordContext);
      if (!spanning.ok) throw new Error("spanning evaluation refused");
      eq("a purchase spanning three unconfirmed periods", spanning.verdict.periods.map((p) => p.key).join(","), "2026-10-B,2026-11-B,2026-12-B");
      eq("estimates the two dated goals at their paces in every one of them and the undated goal in none", spanning.verdict.periods.map((p) => p.estimatedGoals.map((goal) => `${goal.name}:${goal.amount}`).join("+")).join(" | "), Array(3).fill("Verify Afford Goal Open:250+Verify Afford Goal Second:214.29").join(" | "));
      eq("so each period's estimated commitment is the dated paces alone, never the undated balance", spanning.verdict.periods.map((p) => p.flexible.estimatedGoalFunding).join(","), "464.29,464.29,464.29");
      await prisma.goal.delete({ where: { id: undatedGoal.id } });
      const withoutUndated = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Spanning", firstDate: civilDate(2026, 10, 20), totalAmount: 300, installments: 3 }), affordContext);
      if (!withoutUndated.ok) throw new Error("spanning re-evaluation refused");
      const commitmentsOf = (verdict: typeof spanning.verdict) => verdict.periods.map((p) => `${p.key}:${p.account.committed}:${p.flexible.committed}`).join(",");
      eq("with the undated goal gone, every period's commitments are exactly what they were with it - it contributed nothing", commitmentsOf(withoutUndated.verdict), commitmentsOf(spanning.verdict));
      await prisma.goal.delete({ where: { id: secondGoal.id } });
      const achievedItem = await prisma.recurringItem.create({
        data: { name: "Verify Afford Achieved Contribution", amount: 70, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 10, 8), anchorDay: 8, accountId: affordAccount.id, goalId: achievedGoal.id },
      });
      await prisma.recurringItem.create({
        data: { name: "Verify Afford Open Contribution", amount: 80, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 10, 9), anchorDay: 9, accountId: affordAccount.id, goalId: openGoal.id },
      });
      const withGoals = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
      const octAccountDelta = round2(scheduledOf(withGoals.get("2026-10-A")!.account) - scheduledOf(baseline.get("2026-10-A")!.account));
      const octFlexibleDelta = round2(scheduledOf(withGoals.get("2026-10-A")!.flexible) - scheduledOf(baseline.get("2026-10-A")!.flexible));
      eq("a contribution to an achieved goal is not a commitment; one to an open goal is", `${octAccountDelta}:${octFlexibleDelta}`, "80:80");
      eq("neither contribution touches the half of the month it is not due in", round2(scheduledOf(withGoals.get("2026-10-B")!.account) - scheduledOf(baseline.get("2026-10-B")!.account)), 0);
      eq("the scheduled contribution does not change the goal's estimated pace beside it", withGoals.get("2026-10-B")!.flexible.estimatedGoalFunding, 250);
      await prisma.goal.update({ where: { id: achievedGoal.id }, data: { achievedAt: null } });
      const reopened = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
      eq("clearing achievedAt (raising the target) brings the contribution back, as posting would pick it up again", round2(scheduledOf(reopened.get("2026-10-A")!.account) - scheduledOf(baseline.get("2026-10-A")!.account)), 150);
      eq("a goal with nothing left to save is still estimated nothing, achieved or not", reopened.get("2026-10-B")!.estimatedGoals.some((goal) => goal.goalId === achievedGoal.id), false);
      await prisma.recurringItem.delete({ where: { id: achievedItem.id } });

      // A confirmed check-in for the current period plans 400 toward the open
      // goal from this account. Nothing has moved yet - the user logs the
      // contribution later - but the money is spoken for, so a purchase
      // landing in that period must see it as committed - and only it: the
      // estimate that stood in before the check-in is replaced, never added
      // on top of the real figure.
      const currentRef = affordContext.currentPeriod;
      eq("the current period is Sep 1-15 (today is Sep 7)", currentRef.key, "2026-09-A");
      const septemberInput = affordInput({ name: "Verify Afford September", firstDate: civilDate(2026, 9, 10), totalAmount: 100, installments: 1 });
      const beforeCheckin = await affordData.evaluateAffordRequest(septemberInput, affordContext);
      if (!beforeCheckin.ok) throw new Error("september evaluation refused");
      eq("the purchase lands in the current period only", beforeCheckin.verdict.periods.map((p) => p.key).join(","), "2026-09-A");
      const sepBefore = beforeCheckin.verdict.periods[0];
      check("before the check-in, the current period carries the open goal's estimate", sepBefore.account.estimatedGoalFunding > 0 && sepBefore.flexible.estimatedGoalFunding === 250 && sepBefore.estimatedGoals.length === 1, JSON.stringify({ account: sepBefore.account.estimatedGoalFunding, flexible: sepBefore.flexible.estimatedGoalFunding }));
      const goalPlanResult = await confirmCheckinForAfford(
        {
          year: currentRef.year,
          month: currentRef.month,
          period: currentRef.period,
          accounts: activeForAfford.map((a) => ({ accountId: a.id, reportedBalance: 0, incomeEntered: 0, incomeNote: null })),
          goals: [{ goalId: openGoal.id, funding: [{ accountId: affordAccount.id, plannedAmount: 400 }] }],
          essentialCategories: [],
          flexibleCategories: [],
          includedCarryover: 0,
          acknowledgedDeficit: true,
          acknowledgedZeroBuffer: true,
        },
        affordContext,
      );
      check("a check-in with a planned goal draw confirms for the current period", goalPlanResult.ok === true);
      const goalPlanCheckin = await prisma.paydayCheckin.findFirstOrThrow({
        where: { year: currentRef.year, month: currentRef.month, period: currentRef.period },
        include: { allocations: { where: { type: "GOAL" } } },
      });
      eq("it stored one GOAL row of 400 USD from the account", goalPlanCheckin.allocations.map((a) => `${num(a.plannedAmount)}:${a.currency}:${a.accountId === affordAccount.id}`).join(","), "400:USD:true");
      eq("no contribution has been logged for it", await prisma.goalContribution.count({ where: { goalId: openGoal.id } }), 0);
      const afterCheckin = await affordData.evaluateAffordRequest(septemberInput, affordContext);
      if (!afterCheckin.ok) throw new Error("september re-evaluation refused");
      const sepAfter = afterCheckin.verdict.periods[0];
      eq("once confirmed, the period carries no estimate at all", `${sepAfter.account.estimatedGoalFunding}:${sepAfter.flexible.estimatedGoalFunding}:${sepAfter.estimatedGoals.length}`, "0:0:0");
      eq("the planned goal draw is committed against the account's buffer, in the estimate's place", round2(sepAfter.account.committed - scheduledOf(sepBefore.account)), 400);
      eq("and against the period's flexible money", round2(sepAfter.flexible.committed - scheduledOf(sepBefore.flexible)), 400);
      eq("account headroom and available-for-flexible both drop by the draw, net of the estimate it replaced", `${round2(sepBefore.account.headroomBefore + sepBefore.account.estimatedGoalFunding - sepAfter.account.headroomBefore)}:${round2(sepBefore.flexible.availableBefore + sepBefore.flexible.estimatedGoalFunding - sepAfter.flexible.availableBefore)}`, "400:400");
      eq("income is still projected from history, not read from the check-in", sepAfter.account.income, sepBefore.account.income);
      const octoberAfterCheckin = await affordData.projectPeriods(octoberRefs, chosenForAfford, activeForAfford, affordContext);
      eq("a period with no check-in is untouched", `${round2(scheduledOf(octoberAfterCheckin.get("2026-10-A")!.account) - scheduledOf(reopened.get("2026-10-A")!.account) + 70)}:${round2(scheduledOf(octoberAfterCheckin.get("2026-10-A")!.flexible) - scheduledOf(reopened.get("2026-10-A")!.flexible) + 70)}`, "0:0");
      eq("and still carries its estimate: the check-in confirmed a different period", octoberAfterCheckin.get("2026-10-B")!.flexible.estimatedGoalFunding, 250);
      // A GOAL row from before per-account funding existed has no account: it
      // counts period-wide, against no account's buffer, like an unlinked item.
      const accountlessRow = await prisma.paydayPlanAllocation.create({
        data: { paydayCheckinId: goalPlanCheckin.id, type: "GOAL", goalId: openGoal.id, recommendedAmount: 25, plannedAmount: 25, currency: "USD", basis: "roadmap" },
      });
      const withAccountless = await affordData.evaluateAffordRequest(septemberInput, affordContext);
      if (!withAccountless.ok) throw new Error("accountless evaluation refused");
      eq("an accountless GOAL row counts period-wide only", `${round2(withAccountless.verdict.periods[0].account.committed - scheduledOf(sepBefore.account))}:${round2(withAccountless.verdict.periods[0].flexible.committed - scheduledOf(sepBefore.flexible))}`, "400:425");
      await prisma.paydayPlanAllocation.delete({ where: { id: accountlessRow.id } });
      await prisma.paydayCheckin.update({ where: { id: goalPlanCheckin.id }, data: { status: "DRAFT" } });
      const draftOnly = await affordData.evaluateAffordRequest(septemberInput, affordContext);
      if (!draftOnly.ok) throw new Error("draft evaluation refused");
      eq("a draft check-in commits nothing", `${round2(scheduledOf(draftOnly.verdict.periods[0].account) - scheduledOf(sepBefore.account))}:${round2(scheduledOf(draftOnly.verdict.periods[0].flexible) - scheduledOf(sepBefore.flexible))}`, "0:0");
      eq("and leaves the period unconfirmed, so the estimate is back exactly as before", `${draftOnly.verdict.periods[0].account.estimatedGoalFunding}:${draftOnly.verdict.periods[0].flexible.estimatedGoalFunding}`, `${sepBefore.account.estimatedGoalFunding}:250`);

      await prisma.transaction.deleteMany({ where: { source: "PAYDAY_CHECKIN", accountId: { in: activeForAfford.map((a) => a.id) }, date: periodRange(periodInfo(currentRef)) } });
      await prisma.budget.deleteMany({ where: { year: currentRef.year, month: currentRef.month, period: currentRef.period } });
      await prisma.paydayCheckin.delete({ where: { id: goalPlanCheckin.id } });
      await prisma.recurringItem.deleteMany({ where: { kind: "CONTRIBUTION", name: { startsWith: "Verify Afford" } } });
      await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify Afford" } } });
    }
    console.log("\n-- a confirmed check-in is history the moment it is confirmed --");
    {
      // The investigation scenario: on Sep 7 the user confirms Sep 1-15 with
      // real income on a fresh account, then evaluates a purchase landing in
      // Oct 1-15. Sep 1-15 has not ended, but its income is confirmed, so the
      // projection must read it - over one period, not diluted by older ones.
      const freshAccount = await prisma.account.create({ data: { name: "Verify Afford Fresh", currency: "USD", type: "CHECKING" } });
      const accountsWithFresh = [...activeForAfford, freshAccount];
      const currentRef = affordContext.currentPeriod;
      const beforeConfirm = await affordData.projectPeriods(octoberRefs, freshAccount, accountsWithFresh, affordContext);
      eq("with no check-in and no history the fresh account projects nothing", `${beforeConfirm.get("2026-10-A")!.account.income}:${beforeConfirm.get("2026-10-A")!.account.basis}`, "0:none");
      const freshConfirm = await confirmCheckinForAfford(
        {
          year: currentRef.year,
          month: currentRef.month,
          period: currentRef.period,
          accounts: accountsWithFresh.map((a) => ({ accountId: a.id, reportedBalance: 0, incomeEntered: a.id === freshAccount.id ? 30000 : 0, incomeNote: null })),
          goals: [],
          essentialCategories: [],
          flexibleCategories: [],
          includedCarryover: 0,
          acknowledgedDeficit: true,
          acknowledgedZeroBuffer: true,
        },
        affordContext,
      );
      check("the current period's check-in confirms with income on the fresh account", freshConfirm.ok === true);
      const freshCheckin = await prisma.paydayCheckin.findFirstOrThrow({ where: { year: currentRef.year, month: currentRef.month, period: currentRef.period } });
      eq("today is still inside the period just confirmed", `${currentRef.key}:${affordContext.today.getTime() <= currentRef.end.getTime()}`, "2026-09-A:true");
      const afterConfirm = await affordData.projectPeriods(octoberRefs, freshAccount, accountsWithFresh, affordContext);
      eq("Oct 1-15 now projects the confirmed Sep 1-15 income, averaged over that one period", `${afterConfirm.get("2026-10-A")!.account.income}:${afterConfirm.get("2026-10-A")!.account.basis}`, "30000:average");
      // The confirmed check-in recorded nothing for the older account, and that
      // zero is real: it heads the window and dilutes the average like any
      // other period the account lived through (five of 10,000 plus it).
      eq("the account with older history averages the confirmed period in with it, zero and all", (await affordData.projectPeriods(octoberRefs, chosenForAfford, accountsWithFresh, affordContext)).get("2026-10-A")!.account.income, round2((10000 * 5) / 6));
      eq("Oct 16-31, whose history has no confirmed check-in, still has not enough history", `${afterConfirm.get("2026-10-B")!.account.income}:${afterConfirm.get("2026-10-B")!.account.basis}`, "0:none");
      const freshPurchase = await affordData.evaluateAffordRequest(affordInput({ name: "Verify Afford Fresh Purchase", accountId: freshAccount.id, firstDate: civilDate(2026, 10, 5), totalAmount: 100, installments: 1 }), affordContext);
      if (!freshPurchase.ok) throw new Error("fresh purchase evaluation refused");
      eq("the purchase evaluation reads the same projection", `${freshPurchase.verdict.periods[0].key}:${freshPurchase.verdict.periods[0].account.income}:${freshPurchase.verdict.periods[0].account.basis}`, "2026-10-A:30000:average");
      await prisma.paydayCheckin.update({ where: { id: freshCheckin.id }, data: { status: "DRAFT" } });
      const draftAgain = await affordData.projectPeriods(octoberRefs, freshAccount, accountsWithFresh, affordContext);
      eq("a draft check-in does not make the period history", `${draftAgain.get("2026-10-A")!.account.income}:${draftAgain.get("2026-10-A")!.account.basis}`, "0:none");
      await prisma.transaction.deleteMany({ where: { accountId: freshAccount.id } });
      await prisma.transaction.deleteMany({ where: { source: "PAYDAY_CHECKIN", accountId: { in: activeForAfford.map((a) => a.id) }, date: periodRange(periodInfo(currentRef)) } });
      await prisma.budget.deleteMany({ where: { year: currentRef.year, month: currentRef.month, period: currentRef.period } });
      await prisma.paydayCheckin.delete({ where: { id: freshCheckin.id } });
      await prisma.account.delete({ where: { id: freshAccount.id } });
    }

    console.log("\n-- countdown and auto-deactivation --");
    // Dated in the past so posting at Aug 20 - the same reference day the
    // posting section uses, so nothing real is due - walks them down.
    const finiteBase = { currency: "USD", frequency: "MONTHLY" as const, kind: "SUBSCRIPTION" as const, anchorDay: 1, accountId: affordAccount.id, nextDate: civilDate(2026, 6, 1) };
    const finite = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Finite", amount: 40, remainingOccurrences: 3 } });
    const longer = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Longer", amount: 41, remainingOccurrences: 5 } });
    const unlimited = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Unlimited", amount: 42, remainingOccurrences: null } });
    const prelogged = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Prelogged", amount: 77, nextDate: civilDate(2026, 7, 1), remainingOccurrences: 2 } });
    await prisma.transaction.create({
      data: { date: civilDate(2026, 7, 3), amount: 77, currency: "USD", type: "EXPENSE", accountId: affordAccount.id, source: "MANUAL", note: "Verify Afford Prelogged card" },
    });
    const postedByAfford = (itemId: string) => prisma.transaction.count({ where: { source: "RECURRING", externalId: { startsWith: `${itemId}:` } } });
    const reloadItem = (id: string) => prisma.recurringItem.findUniqueOrThrow({ where: { id } });

    const countdownRun = await postForAfford(civilDate(2026, 8, 20));
    const finiteAfter = await reloadItem(finite.id);
    eq("a 3-payment plan posts its three occurrences", await postedByAfford(finite.id), 3);
    eq("the countdown reaches 0 and the item deactivates in the same write", `${finiteAfter.remainingOccurrences}:${finiteAfter.active}`, "0:false");
    eq("its nextDate still advanced past the last occurrence", toISODate(finiteAfter.nextDate), "2026-09-01");
    const longerAfter = await reloadItem(longer.id);
    eq("a 5-payment plan posts three and keeps counting", `${await postedByAfford(longer.id)}:${longerAfter.remainingOccurrences}:${longerAfter.active}`, "3:2:true");
    const unlimitedAfter = await reloadItem(unlimited.id);
    eq("an unlimited item posts the same three and is untouched by the countdown", `${await postedByAfford(unlimited.id)}:${unlimitedAfter.remainingOccurrences}:${unlimitedAfter.active}:${toISODate(unlimitedAfter.nextDate)}`, "3:null:true:2026-09-01");

    // Retrofitting: an installment plan entered as an ordinary subscription
    // before Afford existed gets its countdown through the edit form, on the
    // same row (same id, same posting history), through the same
    // updatedAt-guarded write saveRecurringAction uses.
    {
      const { recurringSchema } = await import("../src/lib/validation");
      type Editable = { id: string; updatedAt: Date; name: string; amount: unknown; nextDate: Date };
      const saveEdit = async (item: Editable, remainingOccurrences: string) => {
        const parsed = recurringSchema.safeParse({
          id: item.id,
          updatedAt: item.updatedAt.toISOString(),
          name: item.name,
          amount: String(num(item.amount as never)),
          currency: "USD",
          frequency: "MONTHLY",
          kind: "SUBSCRIPTION",
          nextDate: toISODate(item.nextDate),
          categoryId: "none",
          accountId: affordAccount.id,
          note: "",
          active: "true",
          remainingOccurrences,
        });
        if (!parsed.success) throw new Error(`edit form rejected: ${parsed.error.issues[0]?.message}`);
        const { id, updatedAt, ...values } = parsed.data;
        return prisma.recurringItem.updateMany({ where: updatedAt ? { id, updatedAt } : { id }, data: values });
      };
      const retrofit = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Retrofit", amount: 44, remainingOccurrences: null } });
      const untouched = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Untouched", amount: 45, remainingOccurrences: null } });
      eq("the edit form's guarded write claims the unbounded item", (await saveEdit(retrofit, "2")).count, 1);
      eq("the edit form's guarded write claims the item left blank", (await saveEdit(untouched, "")).count, 1);
      eq("a stale updatedAt is refused after the countdown edit, like any other edit", (await saveEdit(retrofit, "5")).count, 0);
      const retrofitAfter = await reloadItem(retrofit.id);
      const untouchedAfter = await reloadItem(untouched.id);
      eq("setting payments left on an existing unbounded item stores the countdown on the same row", `${retrofitAfter.remainingOccurrences}:${retrofitAfter.active}:${toISODate(retrofitAfter.nextDate)}`, "2:true:2026-06-01");
      eq("saving a different item with the field blank leaves it open-ended and otherwise unchanged", `${untouchedAfter.remainingOccurrences}:${untouchedAfter.active}:${toISODate(untouchedAfter.nextDate)}:${num(untouchedAfter.amount)}:${untouchedAfter.anchorDay}`, "null:true:2026-06-01:45:1");
      const retrofitRows = await listRecurringItems(affordContext);
      const retrofitRow = retrofitRows.subscriptions.find((row) => row.id === retrofit.id);
      const untouchedRow = retrofitRows.subscriptions.find((row) => row.id === untouched.id);
      eq("the Recurring page shows the retrofitted countdown exactly like an Afford-created plan", `${retrofitRow?.active}:${retrofitRow?.remainingOccurrences}:${retrofitRow?.needs}`, "true:2:null");
      eq("a countdown set by hand does not make the item an Afford plan: it stays among the subscriptions, out of From Afford, and is never re-checked", `${retrofitAfter.fromAfford}:${retrofitRow?.fromAfford}:${retrofitRows.fromAfford.some((row) => row.id === retrofit.id)}:${(await affordData.recheckAffordItems(affordContext)).some((t) => t.itemId === retrofit.id)}`, "false:false:false:false");
      eq("the blank-saved item shows no countdown on the Recurring page", `${untouchedRow?.active}:${untouchedRow?.remainingOccurrences}`, "true:null");
      await postForAfford(civilDate(2026, 8, 20));
      const retrofitPosted = await reloadItem(retrofit.id);
      const untouchedPosted = await reloadItem(untouched.id);
      eq("the retrofitted countdown is spent by posting and the item finishes on its own", `${await postedByAfford(retrofit.id)}:${retrofitPosted.remainingOccurrences}:${retrofitPosted.active}`, "2:0:false");
      eq("the blank-saved item keeps posting past the same dates", `${await postedByAfford(untouched.id)}:${untouchedPosted.remainingOccurrences}:${untouchedPosted.active}`, "3:null:true");
      await prisma.transaction.deleteMany({ where: { source: "RECURRING", externalId: { startsWith: retrofit.id } } });
      await prisma.transaction.deleteMany({ where: { source: "RECURRING", externalId: { startsWith: untouched.id } } });
      await prisma.recurringItem.deleteMany({ where: { id: { in: [retrofit.id, untouched.id] } } });
    }

    const preloggedAfter = await reloadItem(prelogged.id);
    eq("an installment already logged elsewhere is consumed and still counts down", `${countdownRun.occurrencesAlreadyLogged >= 1}:${await postedByAfford(prelogged.id)}:${preloggedAfter.remainingOccurrences}:${preloggedAfter.active}`, "true:1:0:false");
    eq("the run reports the plans that finished", countdownRun.itemsCompleted, 2);
    const secondCountdownRun = await postForAfford(civilDate(2026, 8, 20));
    eq("a finished plan is not posted again", `${await postedByAfford(finite.id)}:${secondCountdownRun.itemsCompleted}`, "3:0");
    eq("a finished plan is not even due any more", (await reloadItem(finite.id)).active, false);

    const listedAfter = await listRecurringItems(affordContext);
    const finiteRow = listedAfter.subscriptions.find((row) => row.id === finite.id);
    eq("the finished plan shows as inactive with a 0 countdown on the Recurring page", `${finiteRow?.active}:${finiteRow?.remainingOccurrences}`, "false:0");
    const laterContext = { ...affordContext, today: civilDate(2026, 8, 31), currentPeriod: periodForDate(civilDate(2026, 8, 31)) };
    const sepSummary = await periodSummaryForAfford(periodInfo({ year: 2026, month: 9, period: "A" }), laterContext);
    eq("the finished plan is not committed in the next period", sepSummary.committedItems.some((i) => i.id === finite.id), false);
    eq("the plan with payments left is still committed", sepSummary.committedItems.some((i) => i.id === longer.id), true);
    eq("the unlimited item is still committed", sepSummary.committedItems.some((i) => i.id === unlimited.id), true);
    const weeklyTwo = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Weekly Two", amount: 9, frequency: "WEEKLY", nextDate: civilDate(2026, 9, 1), remainingOccurrences: 2 } });
    const sepSummaryWeekly = await periodSummaryForAfford(periodInfo({ year: 2026, month: 9, period: "A" }), laterContext);
    eq("the period summary owes a finite item only its remaining occurrences, not every date in the window", sepSummaryWeekly.committedItems.find((i) => i.id === weeklyTwo.id)?.occurrenceCount, 2);
    const dashboardAfter = await getDashboardData(laterContext);
    eq("the finished plan is not upcoming", dashboardAfter.upcoming.some((i) => i.id === finite.id), false);
    eq("the unlimited item is upcoming", dashboardAfter.upcoming.some((i) => i.id === unlimited.id), true);

    const zeroLeft = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Zero", amount: 43, nextDate: civilDate(2026, 8, 1), remainingOccurrences: 0 } });
    const zeroRun = await postForAfford(civilDate(2026, 8, 20));
    eq("an active item with nothing left is retired without posting", `${await postedByAfford(zeroLeft.id)}:${(await reloadItem(zeroLeft.id)).active}:${zeroRun.itemsCompleted}`, "0:false:1");

    // A plan cannot be resumed past its end: re-activating it (and even
    // dragging its due date back) gets it retired again by the next run that
    // finds it due, with nothing posted.
    await prisma.recurringItem.update({ where: { id: finite.id }, data: { active: true, nextDate: civilDate(2026, 8, 1) } });
    const resumedRun = await postForAfford(civilDate(2026, 8, 20));
    eq("resuming a finished plan just retires it again without posting", `${await postedByAfford(finite.id)}:${(await reloadItem(finite.id)).active}:${resumedRun.itemsCompleted}`, "3:false:1");

    // Finished is a different state from paused, and the remainder of a plan
    // can be settled outside the app in one go.
    {
      const { isFinishedPlan } = await import("../src/lib/recurring");
      const { markRecurringItemPaidOff } = await import("../src/lib/data/recurring");
      eq("a finished plan is finished, not paused", isFinishedPlan({ active: false, remainingOccurrences: 0 }), true);
      eq("a paused plan with payments left is not finished", isFinishedPlan({ active: false, remainingOccurrences: 2 }), false);
      eq("a paused open-ended item is not finished", isFinishedPlan({ active: false, remainingOccurrences: null }), false);
      eq("an active plan is not finished even at 0 (posting retires it on its next run)", isFinishedPlan({ active: true, remainingOccurrences: 0 }), false);
      eq("the plan that posted its last occurrence reads as finished", isFinishedPlan(await reloadItem(finite.id)), true);
      const payoff = await prisma.recurringItem.create({ data: { ...finiteBase, name: "Verify Afford Payoff", amount: 20, nextDate: civilDate(2026, 8, 1), remainingOccurrences: 4 } });
      eq("marking an active plan paid off succeeds", (await markRecurringItemPaidOff(payoff.id)).ok, true);
      const paidOff = await reloadItem(payoff.id);
      eq("it is now finished: 0 left and inactive, in one write, with its next date untouched", `${paidOff.remainingOccurrences}:${paidOff.active}:${isFinishedPlan(paidOff)}:${toISODate(paidOff.nextDate)}`, "0:false:true:2026-08-01");
      eq("paying off an already finished plan is refused", (await markRecurringItemPaidOff(payoff.id) as { ok: boolean; reason?: string }).reason, "not_a_plan");
      eq("paying off an open-ended item is refused", (await markRecurringItemPaidOff(unlimited.id) as { ok: boolean; reason?: string }).reason, "not_a_plan");
      eq("paying off a missing item reports not_found", (await markRecurringItemPaidOff("missing") as { ok: boolean; reason?: string }).reason, "not_found");
      await postForAfford(civilDate(2026, 8, 20));
      const payoffAfterRun = await reloadItem(payoff.id);
      eq("a paid-off plan is never posted, even though its due date has passed", `${await postedByAfford(payoff.id)}:${payoffAfterRun.remainingOccurrences}:${payoffAfterRun.active}`, "0:0:false");
    }

    console.log("\n-- large-subscription room check (Recurring form) --");
    {
      const roomLib = await import("../src/lib/subscription-room");
      const roomData = await import("../src/lib/data/subscription-room");
      eq("the threshold is DOP 10,000", `${roomLib.LARGE_SUBSCRIPTION_THRESHOLD.amount}:${roomLib.LARGE_SUBSCRIPTION_THRESHOLD.currency}`, "10000:DOP");
      eq("DOP 9,999 is not large; DOP 10,000 is", `${roomLib.isLargeSubscription(9999, "DOP", rates)}:${roomLib.isLargeSubscription(10000, "DOP", rates)}`, "false:true");
      eq("another currency is converted first: USD 166 is under, USD 166.67 is over", `${roomLib.isLargeSubscription(166, "USD", rates)}:${roomLib.isLargeSubscription(166.67, "USD", rates)}`, "false:true");
      eq("EUR converts through USD", roomLib.isLargeSubscription(100, "EUR", rates), true);

      // Two fresh accounts with clean history for Oct 1-15: Big receives 3,000
      // USD a period, Small 90,000 DOP (1,500 USD). Neither has any recurring
      // item, so their Oct 1-15 headroom is income less the 10% buffer:
      // 2,700 USD and 81,000 DOP. The older Afford account is deep in
      // commitments for Oct 1-15 (the biweekly TV plan alone owes 10,000), so
      // it can never be the recommendation here.
      const bigAccount = await prisma.account.create({ data: { name: "Verify Afford Room Big", currency: "USD", type: "CHECKING" } });
      const smallAccount = await prisma.account.create({ data: { name: "Verify Afford Room Small", currency: "DOP", type: "CHECKING" } });
      for (let month = 3; month <= 8; month += 1) {
        await prisma.transaction.create({ data: { date: civilDate(2026, month, 5), amount: 3000, currency: "USD", type: "INCOME", accountId: bigAccount.id, source: "MANUAL", note: "Verify Afford Room pay" } });
        await prisma.transaction.create({ data: { date: civilDate(2026, month, 5), amount: 90000, currency: "DOP", type: "INCOME", accountId: smallAccount.id, source: "MANUAL", note: "Verify Afford Room pay" } });
      }
      const roomInput = (over: Partial<Parameters<typeof roomData.checkSubscriptionRoom>[0]> = {}) => ({
        amount: 1400,
        currency: "USD",
        frequency: "MONTHLY" as const,
        nextDate: civilDate(2026, 10, 5),
        ...over,
      });
      const rowOf = (room: Awaited<ReturnType<typeof roomData.checkSubscriptionRoom>>, id: string) =>
        room.large ? room.accounts.find((a) => a.accountId === id) : undefined;

      const under = await roomData.checkSubscriptionRoom(roomInput({ amount: 166 }), affordContext);
      eq("a subscription under the threshold is not checked at all", under.large, false);

      const split = await roomData.checkSubscriptionRoom(roomInput(), affordContext);
      if (!split.large) throw new Error("large subscription was not checked");
      eq("the period is the one Next due lands in", split.period.key, "2026-10-A");
      eq("a monthly item lands once in it, for the entered amount", `${split.occurrences}:${split.charge}:${split.currency}`, "1:1400:USD");
      eq("every active account is listed, most room first", `${split.accounts.length >= 3}:${split.accounts.every((a, i) => i === 0 || split.accounts[i - 1].headroomAfterDisplay >= a.headroomAfterDisplay)}`, "true:true");
      const bigRow = rowOf(split, bigAccount.id)!;
      const smallRow = rowOf(split, smallAccount.id)!;
      eq("Big: Afford's own projection - 3,000 income, nothing committed, 300 buffer, 2,700 room", `${bigRow.income}:${bigRow.committed}:${bigRow.buffer}:${bigRow.headroomBefore}:${bigRow.basis}`, "3000:0:300:2700:average");
      eq("Big keeps 1,300 above its buffer after the charge", `${bigRow.installment}:${bigRow.headroomAfter}:${bigRow.passes}:${bigRow.shortfall}`, "1400:1300:true:0");
      eq("Small is judged in its own currency: 84,000 DOP charge against 81,000 DOP of room", `${smallRow.headroomBefore}:${smallRow.installment}:${smallRow.headroomAfter}:${smallRow.passes}:${smallRow.shortfall}`, "81000:84000:-3000:false:3000");
      eq("ranking converts to the display currency (-50 USD for Small)", `${bigRow.headroomAfterDisplay}:${smallRow.headroomAfterDisplay}`, "1300:-50");
      eq("Big is recommended: the account with the most room among those that keep their buffer", split.recommendedAccountId === bigAccount.id, true);
      eq("the older account, already over-committed for Oct 1-15, is listed but short", rowOf(split, affordAccount.id)?.passes, false);
      eq("history depth is Afford's", split.historyPeriods, (await import("../src/lib/data/payday")).HISTORY_PERIODS);

      const bothFit = await roomData.checkSubscriptionRoom(roomInput({ amount: 200 }), affordContext);
      if (!bothFit.large) throw new Error("200 USD subscription was not checked");
      eq("at 200 USD both fresh accounts fit and Big, with more room, is still the pick", `${rowOf(bothFit, bigAccount.id)?.passes}:${rowOf(bothFit, smallAccount.id)?.passes}:${bothFit.recommendedAccountId === bigAccount.id}`, "true:true:true");
      const smallWins = await roomData.checkSubscriptionRoom(roomInput({ amount: 60000, currency: "DOP" }), affordContext);
      if (!smallWins.large) throw new Error("DOP subscription was not checked");
      eq("a DOP 60,000 charge: Big keeps 1,700 USD, Small keeps 21,000 DOP (350 USD) - Big still has the most room", `${rowOf(smallWins, bigAccount.id)?.headroomAfter}:${rowOf(smallWins, smallAccount.id)?.headroomAfter}:${smallWins.recommendedAccountId === bigAccount.id}`, "1700:21000:true");

      const none = await roomData.checkSubscriptionRoom(roomInput({ amount: 5000 }), affordContext);
      if (!none.large) throw new Error("5,000 USD subscription was not checked");
      eq("when no account keeps its buffer there is no recommendation", `${none.recommendedAccountId}:${none.accounts.some((a) => a.passes)}`, "null:false");
      eq("each account reports its own shortfall", `${rowOf(none, bigAccount.id)?.shortfall}:${rowOf(none, smallAccount.id)?.shortfall}`, "2300:219000");

      const weekly = await roomData.checkSubscriptionRoom(roomInput({ amount: 200, frequency: "WEEKLY" }), affordContext);
      if (!weekly.large) throw new Error("weekly subscription was not checked");
      eq("a weekly item due Oct 5 lands twice in Oct 1-15 (5th and 12th) and both charges are checked together", `${weekly.occurrences}:${weekly.charge}:${rowOf(weekly, bigAccount.id)?.installment}:${rowOf(weekly, bigAccount.id)?.headroomAfter}`, "2:400:400:2300");
      const overdue = await roomData.checkSubscriptionRoom(roomInput({ nextDate: civilDate(2026, 9, 1) }), affordContext);
      if (!overdue.large) throw new Error("overdue subscription was not checked");
      eq("a Next due already in the past is owed now, so the current period is checked", overdue.period.key, affordContext.currentPeriod.key);

      // Editing: the item's own schedule is already among the period's
      // commitments, so judging its edited amount must take it back out.
      const existing = await prisma.recurringItem.create({
        data: { name: "Verify Afford Room Existing", amount: 1400, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 5), anchorDay: 5, accountId: bigAccount.id },
      });
      const asNew = await roomData.checkSubscriptionRoom(roomInput(), affordContext);
      eq("a second 1,400 item on top of the existing one would leave Big 100 short", `${rowOf(asNew, bigAccount.id)?.headroomAfter}:${rowOf(asNew, bigAccount.id)?.passes}`, "-100:false");
      const asEdit = await roomData.checkSubscriptionRoom(roomInput({ excludeItemId: existing.id }), affordContext);
      eq("editing that item judges it as if it were not there yet: 1,300 of room again", `${rowOf(asEdit, bigAccount.id)?.committed}:${rowOf(asEdit, bigAccount.id)?.headroomAfter}:${asEdit.large && asEdit.recommendedAccountId === bigAccount.id}`, "0:1300:true");
      const asEditRaised = await roomData.checkSubscriptionRoom(roomInput({ amount: 2800, excludeItemId: existing.id }), affordContext);
      eq("raising it to 2,800 while editing is short by 100, not by 1,500", rowOf(asEditRaised, bigAccount.id)?.shortfall, 100);
      eq("the other accounts are untouched by the exclusion", rowOf(asEdit, smallAccount.id)?.headroomAfter, -3000);
      await prisma.recurringItem.update({ where: { id: existing.id }, data: { active: false } });
      const pausedEdit = await roomData.checkSubscriptionRoom(roomInput({ excludeItemId: existing.id }), affordContext);
      eq("a paused item was never committed, so nothing is taken out for it", `${rowOf(pausedEdit, bigAccount.id)?.committed}:${rowOf(pausedEdit, bigAccount.id)?.headroomAfter}`, "0:1300");
      eq("an unknown item id is simply not excluded", rowOf(await roomData.checkSubscriptionRoom(roomInput({ excludeItemId: "missing" }), affordContext), bigAccount.id)?.headroomAfter, 1300);

      const { subscriptionRoomSchema: roomSchema } = await import("../src/lib/validation");
      const roomForm = { kind: "SUBSCRIPTION", amount: "12,000", currency: "DOP", frequency: "MONTHLY", nextDate: "2026-10-05" };
      const parsedRoom = roomSchema.safeParse(roomForm);
      eq("the form payload parses with the save's own amount and date rules", parsedRoom.success ? `${parsedRoom.data.amount}:${toISODate(parsedRoom.data.nextDate)}:${parsedRoom.data.excludeItemId}` : "refused", "12000:2026-10-05:undefined");
      eq("an amount that is not a number is refused rather than projected", `${roomSchema.safeParse({ ...roomForm, amount: "12k" }).success}:${roomSchema.safeParse({ ...roomForm, amount: "" }).success}`, "false:false");
      eq("a contribution parses (the action then declines to check it)", roomSchema.safeParse({ ...roomForm, kind: "CONTRIBUTION" }).success, true);

      await prisma.recurringItem.delete({ where: { id: existing.id } });
      await prisma.transaction.deleteMany({ where: { accountId: { in: [bigAccount.id, smallAccount.id] } } });
      await prisma.account.deleteMany({ where: { id: { in: [bigAccount.id, smallAccount.id] } } });
    }

    await prisma.transaction.deleteMany({ where: { accountId: { in: [affordAccount.id, emptyAccount.id] } } });
    await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Afford" } } });
    await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify Afford" } } });
    await prisma.account.deleteMany({ where: { id: { in: [affordAccount.id, emptyAccount.id] } } });
  }

  console.log("\n== manual goal contributions move real money ==");
  {
    // addContributionAction/deleteContributionAction are auth-gated "use
    // server" actions, so these checks exercise the same steps they perform:
    // validate via contributionSchema, then logManualContribution /
    // removeContribution, then the goal rebuild.
    const goalsLib = await import("../src/lib/goals");
    const validationLib = await import("../src/lib/validation");
    const { monthWindow: monthWindowOf } = await import("../src/lib/month");
    const contribAccount = await prisma.account.create({
      data: { name: "Verify Contribution Account", currency: "USD", type: "CHECKING" },
    });
    const contribGoal = await prisma.goal.create({
      data: { name: "Verify Contribution Goal", targetAmount: 100000, currency: "DOP" },
    });
    const savingsCat = await prisma.category.findFirstOrThrow({ where: { isSavingsDefault: true } });
    const contribContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: civilDate(2026, 8, 31),
      currentPeriod: periodForDate(civilDate(2026, 8, 31)),
    };
    const contribBalance = async () =>
      (await getAccountBalances(contribContext, { status: "ALL" })).find((a) => a.id === contribAccount.id)?.balance ?? 0;
    const augustWindowForContrib = monthWindowOf({ year: 2026, month: 8 });
    const augustBefore = await classifyCompletedMonth(augustWindowForContrib, contribContext, [], categoryMeta);
    const balanceBefore = await contribBalance();

    const missingAccount = validationLib.contributionSchema.safeParse({ goalId: contribGoal.id, amount: "3000", date: "2026-08-12", note: "" });
    eq("contributionSchema refuses a contribution with no account field", missingAccount.success ? "ok" : missingAccount.error.issues[0]?.message, "Pick an account");
    const emptyAccount = validationLib.contributionSchema.safeParse({ goalId: contribGoal.id, accountId: "", amount: "3000", date: "2026-08-12", note: "" });
    eq("contributionSchema refuses an empty account pick", emptyAccount.success ? "ok" : emptyAccount.error.issues[0]?.message, "Pick an account");
    const parsedContribution = validationLib.contributionSchema.safeParse({ goalId: contribGoal.id, accountId: contribAccount.id, amount: "3000", date: "2026-08-12", note: "Verify top-up" });
    check("contributionSchema accepts a contribution with an account", parsedContribution.success);
    if (!parsedContribution.success) throw new Error("contributionSchema rejected the fixture");

    // 3000 DOP into a USD account at the fixed 60 DOP/USD rate above = 50 USD.
    const logged = await goalsLib.logManualContribution({ ...parsedContribution.data }, rates);
    await goalsLib.rebuildGoalSaved(contribGoal.id);
    const loggedRow = await prisma.goalContribution.findUniqueOrThrow({ where: { id: logged.contributionId } });
    eq("GoalContribution keeps the goal's currency and the amount as typed", `${num(loggedRow.amount)}:${loggedRow.currency}`, "3000:DOP");
    eq("GoalContribution records the source account", loggedRow.accountId, contribAccount.id);
    eq("a manual contribution carries no recurring link", `${loggedRow.recurringItemId}:${loggedRow.recurringExternalId}`, "null:null");
    eq("Goal.savedAmount was rebuilt from the new row", num((await prisma.goal.findUniqueOrThrow({ where: { id: contribGoal.id } })).savedAmount), 3000);
    const twin = await prisma.transaction.findUnique({
      where: { source_externalId: { source: "MANUAL", externalId: (await import("../src/lib/transactions")).manualContributionExternalId(logged.contributionId) } },
    });
    check("the paired Transaction is found by its goal-contribution externalId", twin !== null);
    eq("the paired Transaction is the one logManualContribution reported", twin?.id, logged.transactionId);
    eq("the paired Transaction is an EXPENSE from the chosen account", `${twin?.type}:${twin?.accountId}`, `EXPENSE:${contribAccount.id}`);
    eq("the paired Transaction is converted into the account's currency", `${num(twin?.amount)}:${twin?.currency}`, "50:USD");
    eq("the paired Transaction is dated on the contribution date", twin ? toISODate(twin.date) : null, "2026-08-12");
    eq("the paired Transaction is a MANUAL row", twin?.source, "MANUAL");
    eq("the paired Transaction's note is the goal's name", twin?.note, "Verify Contribution Goal");
    eq("the paired Transaction is filed under the Savings/Investment category", twin?.categoryId, savingsCat.id);
    eq("the account balance dropped by the converted amount", round2(balanceBefore - (await contribBalance())), 50);

    const augustWith = await classifyCompletedMonth(augustWindowForContrib, contribContext, [], categoryMeta);
    eq("monthly savings/investing counts the contribution once, not once per row", round2(augustWith.savingsInvesting - augustBefore.savingsInvesting), 50);
    eq("the paired Transaction is not lifestyle spending", round2(augustWith.lifestyle - augustBefore.lifestyle), 0);

    // Same-currency path: no conversion, and the twin still carries the key.
    const usdGoal = await prisma.goal.create({ data: { name: "Verify Contribution USD Goal", targetAmount: 500, currency: "USD" } });
    const sameCurrency = await goalsLib.logManualContribution({ goalId: usdGoal.id, accountId: contribAccount.id, amount: 12.5, date: civilDate(2026, 8, 13), note: null });
    const sameTwin = await prisma.transaction.findUniqueOrThrow({ where: { id: sameCurrency.transactionId } });
    eq("a same-currency contribution writes the amount unconverted", `${num(sameTwin.amount)}:${sameTwin.currency}`, "12.5:USD");

    // Deleting the contribution takes its Transaction with it.
    await goalsLib.removeContribution({ id: logged.contributionId, accountId: loggedRow.accountId });
    await goalsLib.recomputeGoalSaved(contribGoal.id);
    eq("removing the contribution deletes the GoalContribution", await prisma.goalContribution.count({ where: { id: logged.contributionId } }), 0);
    eq("removing the contribution deletes its paired Transaction", await prisma.transaction.count({ where: { id: logged.transactionId } }), 0);
    eq("Goal.savedAmount is back to zero", num((await prisma.goal.findUniqueOrThrow({ where: { id: contribGoal.id } })).savedAmount), 0);
    await goalsLib.removeContribution({ id: sameCurrency.contributionId, accountId: contribAccount.id });
    eq("the account balance is back where it started", round2((await contribBalance()) - balanceBefore), 0);

    // Deleting from the ledger side: the paired expense takes its contribution
    // with it, the same outcome as removing it from the goal's history. This is
    // what deleteTransactionAction does once it recognises the row.
    const { manualContributionIdFromTransaction: twinContributionId } = await import("../src/lib/transactions");
    const fromLedger = await goalsLib.logManualContribution({ goalId: contribGoal.id, accountId: contribAccount.id, amount: 1200, date: civilDate(2026, 8, 16), note: null }, rates);
    await goalsLib.rebuildGoalSaved(contribGoal.id);
    const ledgerRow = await prisma.transaction.findUniqueOrThrow({ where: { id: fromLedger.transactionId } });
    eq("the ledger row resolves back to its contribution id", twinContributionId(ledgerRow), fromLedger.contributionId);
    eq("an ordinary manual row resolves to no contribution", twinContributionId({ source: "MANUAL", externalId: null }), null);
    eq("the ledger row is blocked from the generic edit form", (await import("../src/lib/transactions")).transactionEditBlock(ledgerRow), "goal_contribution");
    const ledgerContribution = await prisma.goalContribution.findUniqueOrThrow({ where: { id: fromLedger.contributionId }, select: { id: true, goalId: true, accountId: true } });
    await goalsLib.removeContribution(ledgerContribution);
    await goalsLib.recomputeGoalSaved(ledgerContribution.goalId);
    eq("deleting from the ledger removes the Transaction", await prisma.transaction.count({ where: { id: fromLedger.transactionId } }), 0);
    eq("deleting from the ledger removes the GoalContribution with it", await prisma.goalContribution.count({ where: { id: fromLedger.contributionId } }), 0);
    eq("the goal's progress drops accordingly", num((await prisma.goal.findUniqueOrThrow({ where: { id: contribGoal.id } })).savedAmount), 0);

    // A row from before contributions had an account deletes alone, and a twin
    // already removed from the ledger by hand does not block the delete.
    const legacy = await prisma.goalContribution.create({ data: { goalId: contribGoal.id, amount: 100, currency: "DOP", date: civilDate(2026, 8, 14) } });
    const unrelated = await prisma.transaction.create({ data: { date: civilDate(2026, 8, 14), amount: 1, currency: "USD", type: "EXPENSE", accountId: contribAccount.id, source: "MANUAL" } });
    await goalsLib.removeContribution({ id: legacy.id, accountId: legacy.accountId });
    eq("a contribution with no account deletes on its own", await prisma.goalContribution.count({ where: { id: legacy.id } }), 0);
    eq("deleting an account-less contribution touches no transactions", await prisma.transaction.count({ where: { id: unrelated.id } }), 1);
    const orphaned = await goalsLib.logManualContribution({ goalId: contribGoal.id, accountId: contribAccount.id, amount: 600, date: civilDate(2026, 8, 15), note: null }, rates);
    await prisma.transaction.delete({ where: { id: orphaned.transactionId } });
    await goalsLib.removeContribution({ id: orphaned.contributionId, accountId: contribAccount.id });
    eq("a contribution whose twin was already removed from the ledger still deletes", await prisma.goalContribution.count({ where: { id: orphaned.contributionId } }), 0);

    // A contribution recurring posting wrote is paired with its RECURRING
    // Transaction through recurringExternalId: its amount is corrected on both
    // rows together, and deleting either side removes the other.
    {
      const { recurringContributionKeyFromTransaction } = await import("../src/lib/transactions");
      const autoKey = "verify-item:2026-08-16";
      const autoTx = await prisma.transaction.create({ data: { date: civilDate(2026, 8, 16), amount: 100, currency: "USD", type: "EXPENSE", accountId: contribAccount.id, source: "RECURRING", externalId: autoKey, note: "Verify Auto" } });
      const autoContribution = await prisma.goalContribution.create({ data: { goalId: usdGoal.id, amount: 100, currency: "USD", date: civilDate(2026, 8, 16), note: "Verify Auto", recurringExternalId: autoKey } });
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      const savedBeforeEdit = num((await prisma.goal.findUniqueOrThrow({ where: { id: usdGoal.id } })).savedAmount);
      const edited = await goalsLib.updateRecurringContributionAmount(autoContribution.id, 80, rates);
      eq("editing an auto-posted contribution succeeds and reports the ledger amount", edited.ok ? `${edited.goalId === usdGoal.id}:${edited.transactionAmount}` : edited.reason, "true:80");
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      eq("the GoalContribution carries the new amount", num((await prisma.goalContribution.findUniqueOrThrow({ where: { id: autoContribution.id } })).amount), 80);
      eq("the paired RECURRING Transaction carries the same new amount", num((await prisma.transaction.findUniqueOrThrow({ where: { id: autoTx.id } })).amount), 80);
      eq("the goal's cached total moved by the difference", round2(savedBeforeEdit - num((await prisma.goal.findUniqueOrThrow({ where: { id: usdGoal.id } })).savedAmount)), 20);
      const manualForEdit = await goalsLib.logManualContribution({ goalId: usdGoal.id, accountId: contribAccount.id, amount: 5, date: civilDate(2026, 8, 17), note: null }, rates);
      const manualEdit = await goalsLib.updateRecurringContributionAmount(manualForEdit.contributionId, 1, rates);
      eq("a manual contribution is refused by the recurring edit path", manualEdit.ok ? "edited" : manualEdit.reason, "not_recurring");
      eq("a manual contribution's rows are untouched by the refusal", `${num((await prisma.goalContribution.findUniqueOrThrow({ where: { id: manualForEdit.contributionId } })).amount)}:${num((await prisma.transaction.findUniqueOrThrow({ where: { id: manualForEdit.transactionId } })).amount)}`, "5:5");
      await goalsLib.removeContribution({ id: manualForEdit.contributionId, accountId: contribAccount.id });
      eq("a missing contribution reports not_found", (await goalsLib.updateRecurringContributionAmount("missing", 1, rates) as { ok: boolean; reason?: string }).reason, "not_found");

      // Cross-currency: the contribution is in the goal's currency (DOP), the
      // ledger row in the item's (USD), converted at the fixed 60 DOP/USD rate.
      const crossKey = "verify-item:2026-08-18";
      const crossTx = await prisma.transaction.create({ data: { date: civilDate(2026, 8, 18), amount: 50, currency: "USD", type: "EXPENSE", accountId: contribAccount.id, source: "RECURRING", externalId: crossKey } });
      const crossContribution = await prisma.goalContribution.create({ data: { goalId: contribGoal.id, amount: 3000, currency: "DOP", date: civilDate(2026, 8, 18), recurringExternalId: crossKey } });
      const crossEdit = await goalsLib.updateRecurringContributionAmount(crossContribution.id, 600, rates);
      eq("a cross-currency edit converts the ledger amount at the given rate", crossEdit.ok ? crossEdit.transactionAmount : crossEdit.reason, 10);
      eq("the cross-currency twin is updated in its own currency", `${num((await prisma.transaction.findUniqueOrThrow({ where: { id: crossTx.id } })).amount)}:${(await prisma.transaction.findUniqueOrThrow({ where: { id: crossTx.id } })).currency}`, "10:USD");
      eq("the contribution itself stays in the goal's currency", `${num((await prisma.goalContribution.findUniqueOrThrow({ where: { id: crossContribution.id } })).amount)}:DOP`, "600:DOP");

      // Delete from the goal side: the RECURRING row goes too.
      await goalsLib.removeContribution({ id: autoContribution.id, accountId: null, recurringExternalId: autoKey });
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      eq("removing an auto-posted contribution from the goal deletes its RECURRING Transaction too", await prisma.transaction.count({ where: { id: autoTx.id } }), 0);
      eq("and the contribution itself", await prisma.goalContribution.count({ where: { id: autoContribution.id } }), 0);

      // Delete from the ledger side: the steps deleteTransactionAction runs.
      eq("a RECURRING row's contribution key is its externalId", recurringContributionKeyFromTransaction(crossTx), crossKey);
      eq("a MANUAL row has no recurring contribution key", recurringContributionKeyFromTransaction({ source: "MANUAL", externalId: "goal-contribution:x" }), null);
      eq("a RECURRING row with no externalId has no key", recurringContributionKeyFromTransaction({ source: "RECURRING", externalId: null }), null);
      const pairedFromLedger = await prisma.goalContribution.findFirst({ where: { recurringExternalId: crossKey }, select: { id: true, goalId: true, accountId: true, recurringExternalId: true } });
      eq("the paired contribution is found by that key", pairedFromLedger?.id, crossContribution.id);
      if (!pairedFromLedger) throw new Error("paired contribution missing");
      await goalsLib.removeContribution(pairedFromLedger);
      await goalsLib.recomputeGoalSaved(contribGoal.id);
      eq("deleting the RECURRING row from the ledger removes the contribution with it", await prisma.goalContribution.count({ where: { id: crossContribution.id } }), 0);
      eq("and the ledger row itself", await prisma.transaction.count({ where: { id: crossTx.id } }), 0);
      eq("a subscription's RECURRING row pairs with no contribution, so it would be deleted alone", await prisma.goalContribution.count({ where: { recurringExternalId: "verify-sub:2026-08-19" } }), 0);
    }

    // A hand-logged contribution can be corrected in place too - amount, date,
    // and which account the money left - the manual counterpart to
    // updateRecurringContributionAmount above.
    {
      const missingManualEditAccount = validationLib.manualContributionEditSchema.safeParse({ id: "x", amount: "5.01", date: "2026-08-22" });
      eq("manualContributionEditSchema refuses an edit with no account field", missingManualEditAccount.success ? "ok" : missingManualEditAccount.error.issues[0]?.message, "Pick an account");
      const parsedManualEdit = validationLib.manualContributionEditSchema.safeParse({ id: "x", amount: "5.01", date: "2026-08-22", accountId: contribAccount.id });
      check("manualContributionEditSchema accepts a full edit", parsedManualEdit.success);

      const original = await goalsLib.logManualContribution({ goalId: usdGoal.id, accountId: contribAccount.id, amount: 5, date: civilDate(2026, 8, 20), note: "Verify manual edit" }, rates);
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      const savedBeforeManualEdit = num((await prisma.goal.findUniqueOrThrow({ where: { id: usdGoal.id } })).savedAmount);

      // A same-account amount/date correction updates both rows together.
      const centFix = await goalsLib.updateManualContribution(original.contributionId, { amount: 5.01, date: civilDate(2026, 8, 22), accountId: contribAccount.id }, rates);
      eq("a one-cent same-account fix succeeds and reports the goal", centFix.ok ? centFix.goalId : centFix.reason, usdGoal.id);
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      const contributionAfterCentFix = await prisma.goalContribution.findUniqueOrThrow({ where: { id: original.contributionId } });
      const twinAfterCentFix = await prisma.transaction.findUniqueOrThrow({ where: { id: original.transactionId } });
      eq("the GoalContribution carries the corrected amount and date", `${num(contributionAfterCentFix.amount)}:${toISODate(contributionAfterCentFix.date)}`, "5.01:2026-08-22");
      eq("the paired Transaction carries the same corrected amount and date, same account", `${num(twinAfterCentFix.amount)}:${toISODate(twinAfterCentFix.date)}:${twinAfterCentFix.accountId}`, `5.01:2026-08-22:${contribAccount.id}`);
      eq("the goal's cached total moved by the one-cent difference", round2(num((await prisma.goal.findUniqueOrThrow({ where: { id: usdGoal.id } })).savedAmount) - savedBeforeManualEdit), 0.01);

      // Moving the account re-converts the amount into the new account's currency.
      const eurAccount = await prisma.account.create({ data: { name: "Verify Contribution Account EUR", currency: "EUR", type: "CHECKING" } });
      const moved = await goalsLib.updateManualContribution(original.contributionId, { amount: 5.01, date: civilDate(2026, 8, 22), accountId: eurAccount.id }, rates);
      eq("moving the contribution to a different-currency account succeeds", moved.ok ? moved.goalId : moved.reason, usdGoal.id);
      const twinAfterMove = await prisma.transaction.findUniqueOrThrow({ where: { id: original.transactionId } });
      eq("the paired Transaction moved to the new account, converted to its currency", `${twinAfterMove.accountId}:${num(twinAfterMove.amount)}:${twinAfterMove.currency}`, `${eurAccount.id}:${round2(convert(5.01, "USD", "EUR", rates))}:EUR`);
      eq("the contribution itself stays in the goal's own currency", (await prisma.goalContribution.findUniqueOrThrow({ where: { id: original.contributionId } })).currency, "USD");

      // A row recurring posting wrote is refused by this path.
      const autoKeyForManualEdit = "verify-manual-edit-item:2026-08-23";
      await prisma.transaction.create({ data: { date: civilDate(2026, 8, 23), amount: 9, currency: "USD", type: "EXPENSE", accountId: contribAccount.id, source: "RECURRING", externalId: autoKeyForManualEdit } });
      const autoForManualEdit = await prisma.goalContribution.create({ data: { goalId: usdGoal.id, amount: 9, currency: "USD", date: civilDate(2026, 8, 23), recurringExternalId: autoKeyForManualEdit } });
      const refused = await goalsLib.updateManualContribution(autoForManualEdit.id, { amount: 1, date: civilDate(2026, 8, 23), accountId: contribAccount.id }, rates);
      eq("an auto-posted contribution is refused by the manual edit path", refused.ok ? "edited" : refused.reason, "not_manual");
      eq("a missing contribution reports not_found", (await goalsLib.updateManualContribution("missing", { amount: 1, date: civilDate(2026, 8, 23), accountId: contribAccount.id }, rates) as { ok: boolean; reason?: string }).reason, "not_found");

      await prisma.goalContribution.delete({ where: { id: autoForManualEdit.id } });
      await prisma.transaction.deleteMany({ where: { externalId: autoKeyForManualEdit } });
      await goalsLib.removeContribution({ id: original.contributionId, accountId: eurAccount.id });
      await goalsLib.recomputeGoalSaved(usdGoal.id);
      await prisma.account.delete({ where: { id: eurAccount.id } });
    }

    // Deleting a goal leaves the expenses its manual contributions wrote in
    // the ledger as ordinary rows: their goal-contribution key is cleared in
    // the same transaction, so the generic form stops pointing at a goal that
    // no longer exists. A RECURRING expense keeps its key.
    {
      const doomedGoal = await prisma.goal.create({ data: { name: "Verify Contribution Doomed Goal", targetAmount: 100, currency: "USD" } });
      const doomedManual = await goalsLib.logManualContribution({ goalId: doomedGoal.id, accountId: contribAccount.id, amount: 20, date: civilDate(2026, 8, 19), note: null }, rates);
      const doomedAutoKey = "verify-doomed:2026-08-19";
      const doomedAutoTx = await prisma.transaction.create({ data: { date: civilDate(2026, 8, 19), amount: 7, currency: "USD", type: "EXPENSE", accountId: contribAccount.id, source: "RECURRING", externalId: doomedAutoKey } });
      await prisma.goalContribution.create({ data: { goalId: doomedGoal.id, amount: 7, currency: "USD", date: civilDate(2026, 8, 19), recurringExternalId: doomedAutoKey } });
      const beforeDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: doomedManual.transactionId } });
      eq("before the goal is deleted its manual expense is blocked from the generic form", transactionEditBlock(beforeDelete), "goal_contribution");
      eq("deleting the goal reports success", await goalsLib.deleteGoalDetachingLedger(doomedGoal.id), true);
      eq("deleting a goal that is already gone reports false", await goalsLib.deleteGoalDetachingLedger(doomedGoal.id), false);
      const afterDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: doomedManual.transactionId } });
      eq("the manual expense survives in the ledger with its goal key cleared", `${afterDelete.externalId}:${afterDelete.source}:${num(afterDelete.amount)}`, "null:MANUAL:20");
      eq("so the generic transaction form no longer blocks it", transactionEditBlock(afterDelete), null);
      eq("its contributions cascaded", await prisma.goalContribution.count({ where: { goalId: doomedGoal.id } }), 0);
      eq("a RECURRING expense keeps its key (it pairs with the item's history, not the goal)", (await prisma.transaction.findUniqueOrThrow({ where: { id: doomedAutoTx.id } })).externalId, doomedAutoKey);
      await prisma.transaction.deleteMany({ where: { id: { in: [doomedManual.transactionId, doomedAutoTx.id] } } });
    }

    // The Transactions table needs to know up front which RECURRING rows carry
    // a contribution: transactionEditBlock cannot tell (a subscription's row
    // has the same shape of key), so listTransactions looks the pairing up
    // once per page and each row carries the answer.
    {
      const { listTransactions: listForTable } = await import("../src/lib/data/transactions");
      const { postDueRecurringItems: postForTable } = await import("../src/lib/recurring-posting");
      const tableGoal = await prisma.goal.create({ data: { name: "Verify Contribution Table Goal", targetAmount: 1000, currency: "USD" } });
      const tableContribution = await prisma.recurringItem.create({
        data: { name: "Verify Contribution Table Item", amount: 25, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 21), anchorDay: 21, accountId: contribAccount.id, goalId: tableGoal.id },
      });
      const tableSubscription = await prisma.recurringItem.create({
        data: { name: "Verify Contribution Table Sub", amount: 9, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 21), anchorDay: 21, accountId: contribAccount.id },
      });
      await postForTable(civilDate(2026, 8, 21));
      const rowsFor = async (itemId: string) =>
        (await listForTable({ accountId: contribAccount.id }, contribContext)).rows.filter((row) => row.source === "RECURRING" && row.externalId?.startsWith(`${itemId}:`));
      const [contributionRow] = await rowsFor(tableContribution.id);
      const [subscriptionRow] = await rowsFor(tableSubscription.id);
      check("both items posted one row each", Boolean(contributionRow && subscriptionRow));
      eq("posting wrote the contribution beside the row", await prisma.goalContribution.count({ where: { recurringExternalId: contributionRow.externalId ?? "" } }), 1);
      eq("the pure classifier still cannot tell the two rows apart", `${transactionEditBlock(contributionRow)}:${transactionEditBlock(subscriptionRow)}`, "null:null");
      eq("the table row for an auto-posted contribution is flagged as carrying one", contributionRow.hasLinkedGoalContribution, true);
      eq("a subscription's row is not, so it stays editable", subscriptionRow.hasLinkedGoalContribution, false);
      const manualForTable = await goalsLib.logManualContribution({ goalId: tableGoal.id, accountId: contribAccount.id, amount: 3, date: civilDate(2026, 8, 21), note: null }, rates);
      const manualRow = (await listForTable({ accountId: contribAccount.id }, contribContext)).rows.find((row) => row.id === manualForTable.transactionId);
      eq("a manual contribution's row is recognised by the classifier alone, not by the flag", `${manualRow && transactionEditBlock(manualRow)}:${manualRow?.hasLinkedGoalContribution}`, "goal_contribution:false");
      // Deleting the goal cascades its contributions: the RECURRING row keeps
      // its key, but nothing pairs with it any more, so it unlocks.
      eq("deleting the goal reports success", await goalsLib.deleteGoalDetachingLedger(tableGoal.id), true);
      const [detachedRow] = await rowsFor(tableContribution.id);
      eq("after the goal is deleted the same row is no longer flagged", `${detachedRow.externalId === contributionRow.externalId}:${detachedRow.hasLinkedGoalContribution}`, "true:false");
      await prisma.transaction.deleteMany({ where: { accountId: contribAccount.id, source: "RECURRING" } });
      await prisma.transaction.deleteMany({ where: { id: manualForTable.transactionId } });
      await prisma.recurringItem.deleteMany({ where: { id: { in: [tableContribution.id, tableSubscription.id] } } });
    }

    await prisma.transaction.deleteMany({ where: { accountId: contribAccount.id } });
    await prisma.goal.deleteMany({ where: { id: { in: [contribGoal.id, usdGoal.id] } } });
    await prisma.account.delete({ where: { id: contribAccount.id } });
  }

  console.log("\n== category management ==");
  {
    const categoriesLib = await import("../src/lib/data/categories");
    const { protectedCategoryReason } = await import("../src/lib/categories");
    const { categorySchema, reassignCategorySchema, changePinSchema, firstError: firstCategoryError } = await import("../src/lib/validation");

    const noName = categorySchema.safeParse({ name: "  ", kind: "EXPENSE", color: "#123456" });
    eq("categorySchema needs a name", noName.success ? "accepted" : noName.error.issues[0]?.message, "Name the category");
    const badColor = categorySchema.safeParse({ name: "Pets", kind: "EXPENSE", color: "red" });
    eq("categorySchema needs a six-digit hex color", badColor.success ? "accepted" : badColor.error.issues[0]?.message, "Pick a color");
    eq("the color error is translated for the Spanish UI", badColor.success ? "accepted" : firstCategoryError(badColor.error, "es"), "Elige un color");
    const upperColor = categorySchema.safeParse({ name: " Pets ", kind: "INCOME", color: "#ABCDEF" });
    eq("categorySchema trims the name and lowercases the color", upperColor.success ? `${upperColor.data.name}:${upperColor.data.kind}:${upperColor.data.color}` : "rejected", "Pets:INCOME:#abcdef");
    const noTarget = reassignCategorySchema.safeParse({ id: "cat_1" });
    eq("reassignCategorySchema insists on a target (nothing picked)", noTarget.success ? "accepted" : noTarget.error.issues[0]?.message, "Pick a category to move them to");
    const noneTarget = reassignCategorySchema.safeParse({ id: "cat_1", moveToId: "none" });
    eq("reassignCategorySchema treats 'none' as nothing picked", noneTarget.success ? "accepted" : firstCategoryError(noneTarget.error, "es"), "Elige la categoría a la que moverlos");
    const pinMismatch = changePinSchema.safeParse({ currentPin: "1234", pin: "5678", confirm: "5679" });
    eq("changePinSchema needs the confirmation to match", pinMismatch.success ? "accepted" : pinMismatch.error.issues[0]?.message, "Both entries must match");
    const pinBad = changePinSchema.safeParse({ currentPin: "1234", pin: "12", confirm: "12" });
    eq("changePinSchema applies the PIN format", pinBad.success ? "accepted" : pinBad.error.issues[0]?.message, "Use 4 to 6 digits");

    const created = await categoriesLib.createCategory({ name: "Verify Pets", kind: "EXPENSE", color: "#123456" });
    check("a new category is created", created.ok);
    if (!created.ok) throw new Error("createCategory refused the fixture");
    const petsId = created.id;
    const duplicate = await categoriesLib.createCategory({ name: "verify PETS", kind: "EXPENSE", color: "#123456" });
    eq("a name that differs only by case is refused", duplicate.ok ? "created" : duplicate.reason, "name_taken");
    const renamed = await categoriesLib.updateCategory({ id: petsId, name: "Verify Pets Renamed", kind: "EXPENSE", color: "#abcdef" });
    eq("rename and recolor save", renamed.ok, true);
    const rekindedWhileUnused = await categoriesLib.updateCategory({ id: petsId, name: "Verify Pets Renamed", kind: "INCOME", color: "#abcdef" });
    eq("the kind can change while nothing is filed under it", rekindedWhileUnused.ok, true);
    const backToExpense = await categoriesLib.updateCategory({ id: petsId, name: "Verify Pets Renamed", kind: "EXPENSE", color: "#abcdef" });
    eq("and change back", backToExpense.ok, true);
    const petsRow = await prisma.category.findUniqueOrThrow({ where: { id: petsId } });
    eq("the stored row reflects the edits", `${petsRow.name}:${petsRow.kind}:${petsRow.color}`, "Verify Pets Renamed:EXPENSE:#abcdef");
    const existingName = await prisma.category.findFirstOrThrow({ where: { isSubscriptionDefault: true } });
    const collide = await categoriesLib.updateCategory({ id: petsId, name: existingName.name.toUpperCase(), kind: "EXPENSE", color: "#abcdef" });
    eq("renaming onto another category's name (any case) is refused", collide.ok ? "saved" : collide.reason, "name_taken");

    const target = await categoriesLib.createCategory({ name: "Verify Target", kind: "EXPENSE", color: "#654321" });
    if (!target.ok) throw new Error("createCategory refused the target fixture");
    const catAccount = await prisma.account.create({ data: { name: "Verify Category Account", currency: "USD", type: "CHECKING" } });
    await prisma.transaction.createMany({
      data: [
        { date: civilDate(2026, 10, 2), amount: 10, currency: "USD", type: "EXPENSE", accountId: catAccount.id, categoryId: petsId, source: "MANUAL" },
        { date: civilDate(2026, 10, 3), amount: 11, currency: "USD", type: "EXPENSE", accountId: catAccount.id, categoryId: petsId, source: "MANUAL" },
      ],
    });
    const catItem = await prisma.recurringItem.create({
      data: { name: "Verify Category Item", amount: 5, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 11, 1), anchorDay: 1, categoryId: petsId, accountId: catAccount.id },
    });
    const catBudget = await prisma.budget.create({ data: { year: 2026, month: 10, period: "A", categoryId: petsId, amount: 100, currency: "USD" } });
    // Pending email-parsed candidates only suggest a category; they follow the
    // reassignment like real rows do, but never block a plain delete.
    const stagedPets = await prisma.stagedTransaction.create({
      data: { date: civilDate(2026, 10, 4), amount: 12, currency: "USD", rawDescription: "Verify Staged Pets", source: "GMAIL", externalId: "verify-staged-pets", suggestedCategoryId: petsId },
    });
    const stagedTarget = await prisma.stagedTransaction.create({
      data: { date: civilDate(2026, 10, 5), amount: 13, currency: "USD", rawDescription: "Verify Staged Target", source: "GMAIL", externalId: "verify-staged-target", suggestedCategoryId: target.id },
    });
    const stagedSuggestion = async (id: string) => (await prisma.stagedTransaction.findUniqueOrThrow({ where: { id } })).suggestedCategoryId;

    const rekindInUse = await categoriesLib.updateCategory({ id: petsId, name: "Verify Pets Renamed", kind: "INCOME", color: "#abcdef" });
    eq("the kind is locked once transactions are filed under it, reporting how many", rekindInUse.ok ? "saved" : `${rekindInUse.reason}:${rekindInUse.reason === "kind_in_use" ? rekindInUse.transactions : ""}`, "kind_in_use:2");
    const renameInUse = await categoriesLib.updateCategory({ id: petsId, name: "Verify Pets", kind: "EXPENSE", color: "#abcdef" });
    eq("a rename with the same kind still saves while in use", renameInUse.ok, true);

    const usage = await categoriesLib.getCategoryUsage(petsId);
    eq("usage counts transactions, recurring items and budgets by type", `${usage.transactions}:${usage.recurringItems}:${usage.budgets}`, "2:1:1");
    const listed = (await categoriesLib.listCategoriesWithUsage()).find((row) => row.id === petsId);
    eq("the settings list carries the same counts", listed ? `${listed.usage.transactions}:${listed.usage.recurringItems}:${listed.usage.budgets}:${listed.protectedBy}` : "missing", "2:1:1:null");
    const inUse = await categoriesLib.deleteCategoryIfUnused(petsId);
    eq("deleting a category in use is refused with the counts, and nothing is deleted", inUse.ok ? "deleted" : `${inUse.reason}:${inUse.reason === "in_use" ? `${inUse.usage.transactions}:${inUse.usage.recurringItems}:${inUse.usage.budgets}` : ""}`, "in_use:2:1:1");
    eq("the category is still there", await prisma.category.count({ where: { id: petsId } }), 1);

    const subscriptions = await prisma.category.findFirstOrThrow({ where: { isSubscriptionDefault: true } });
    const savings = await prisma.category.findFirstOrThrow({ where: { isSavingsDefault: true } });
    const protectedSubs = await categoriesLib.deleteCategoryIfUnused(subscriptions.id);
    eq("the subscriptions default can't be deleted, naming safe-to-spend's dependency", protectedSubs.ok ? "deleted" : `${protectedSubs.reason}:${protectedSubs.reason === "protected" ? protectedSubs.protectedBy : ""}`, "protected:subscription");
    const protectedSavings = await categoriesLib.deleteCategoryIfUnused(savings.id);
    eq("the savings default can't be deleted either", protectedSavings.ok ? "deleted" : `${protectedSavings.reason}:${protectedSavings.reason === "protected" ? protectedSavings.protectedBy : ""}`, "protected:savings");
    const protectedReassign = await categoriesLib.reassignAndDeleteCategory(subscriptions.id, target.id);
    eq("nor removed through the reassignment step", protectedReassign.ok ? "deleted" : protectedReassign.reason, "protected");
    eq("protectedCategoryReason is what the list shows as the badge", `${protectedCategoryReason(subscriptions)}:${protectedCategoryReason(savings)}:${protectedCategoryReason(petsRow)}`, "subscription:savings:null");

    const incomeCategory = await prisma.category.findFirstOrThrow({ where: { kind: "INCOME" } });
    eq("moving rows to a category of another kind is refused", (await categoriesLib.reassignAndDeleteCategory(petsId, incomeCategory.id)).ok ? "moved" : (await categoriesLib.reassignAndDeleteCategory(petsId, incomeCategory.id) as { reason: string }).reason, "kind_mismatch");
    eq("moving rows onto the category being removed is refused", (await categoriesLib.reassignAndDeleteCategory(petsId, petsId) as { ok: boolean; reason?: string }).reason, "same_category");
    eq("moving rows to a category that no longer exists is refused", (await categoriesLib.reassignAndDeleteCategory(petsId, "missing_category") as { ok: boolean; reason?: string }).reason, "target_not_found");
    eq("none of the refusals touched anything", `${await prisma.transaction.count({ where: { categoryId: petsId } })}:${await prisma.recurringItem.count({ where: { categoryId: petsId } })}:${await prisma.budget.count({ where: { id: catBudget.id } })}`, "2:1:1");

    const moved = await categoriesLib.reassignAndDeleteCategory(petsId, target.id);
    eq("the reassignment step moves the rows, clears the budgets and removes the category, reporting the counts", moved.ok ? `${moved.moved.transactions}:${moved.moved.recurringItems}:${moved.moved.budgets}` : moved.reason, "2:1:1");
    eq("every transaction now sits under the target", await prisma.transaction.count({ where: { accountId: catAccount.id, categoryId: target.id } }), 2);
    eq("the recurring item now sits under the target", (await prisma.recurringItem.findUniqueOrThrow({ where: { id: catItem.id } })).categoryId, target.id);
    eq("the removed category's budget is gone rather than moved", await prisma.budget.count({ where: { id: catBudget.id } }), 0);
    eq("and the category itself is gone", await prisma.category.count({ where: { id: petsId } }), 0);
    eq("the target keeps its own name and kind", (await prisma.category.findUniqueOrThrow({ where: { id: target.id } })).name, "Verify Target");
    eq("a pending staged suggestion of the removed category now suggests the target, not nothing", await stagedSuggestion(stagedPets.id), target.id);
    eq("a staged suggestion of some other category is untouched", await stagedSuggestion(stagedTarget.id), target.id);

    const targetInUse = await categoriesLib.deleteCategoryIfUnused(target.id);
    eq("the target is now in use and refuses a plain delete", targetInUse.ok ? "deleted" : targetInUse.reason, "in_use");
    await prisma.transaction.deleteMany({ where: { accountId: catAccount.id } });
    await prisma.recurringItem.delete({ where: { id: catItem.id } });
    const unusedCategory = await categoriesLib.createCategory({ name: "Verify Unused", kind: "EXPENSE", color: "#0f0f0f" });
    if (!unusedCategory.ok) throw new Error("createCategory refused the unused fixture");
    eq("a plain delete of an unused category succeeds", (await categoriesLib.deleteCategoryIfUnused(unusedCategory.id)).ok, true);
    eq("and leaves unrelated staged suggestions alone", `${await stagedSuggestion(stagedPets.id) === target.id}:${await stagedSuggestion(stagedTarget.id) === target.id}`, "true:true");
    const targetUnused = await categoriesLib.deleteCategoryIfUnused(target.id);
    eq("a category nothing is filed under deletes outright", targetUnused.ok, true);
    eq("staged rows never block a plain delete; their suggestion is simply cleared", `${await stagedSuggestion(stagedPets.id)}:${await stagedSuggestion(stagedTarget.id)}`, "null:null");
    await prisma.stagedTransaction.deleteMany({ where: { id: { in: [stagedPets.id, stagedTarget.id] } } });
    eq("deleting a category that is already gone reports not_found", (await categoriesLib.deleteCategoryIfUnused(target.id) as { ok: boolean; reason?: string }).reason, "not_found");
    await prisma.account.delete({ where: { id: catAccount.id } });
  }

  console.log("\n== csv re-import duplicates ==");
  {
    const { csvFingerprint, csvExternalId, fingerprintFromCsvExternalId, normalizeCsvNote } = await import("../src/lib/csv-fingerprint");
    const { findCsvDuplicates } = await import("../src/lib/data/import-duplicates");
    const base = { accountId: "acc_1", date: "2026-09-02", amount: 12.5, currency: "USD", note: "Coffee  Shop" };
    eq("a fingerprint is deterministic", csvFingerprint(base), csvFingerprint({ ...base }));
    eq("description whitespace and case do not change it", csvFingerprint(base), csvFingerprint({ ...base, note: " coffee shop " }));
    eq("normalizeCsvNote collapses whitespace and lowercases", normalizeCsvNote("  Coffee   SHOP "), "coffee shop");
    check("a different amount changes it", csvFingerprint(base) !== csvFingerprint({ ...base, amount: 12.51 }));
    check("a different date changes it", csvFingerprint(base) !== csvFingerprint({ ...base, date: "2026-09-03" }));
    check("a different account changes it", csvFingerprint(base) !== csvFingerprint({ ...base, accountId: "acc_2" }));
    check("a different currency changes it", csvFingerprint(base) !== csvFingerprint({ ...base, currency: "DOP" }));
    eq("the first row with a fingerprint stores it bare", csvExternalId("abc", 1), "abc");
    eq("a repeat stores an ordinal", csvExternalId("abc", 2), "abc#2");
    eq("the fingerprint is read back from either form", `${fingerprintFromCsvExternalId("abc")}:${fingerprintFromCsvExternalId("abc#3")}:${fingerprintFromCsvExternalId(null)}`, "abc:abc:null");

    const csvAccount = await prisma.account.create({ data: { name: "Verify CSV Account", currency: "USD", type: "CHECKING" } });
    const legacyFp = csvFingerprint({ accountId: csvAccount.id, date: "2026-09-02", amount: 12.5, currency: "USD", note: "Coffee shop" });
    const storedFp = csvFingerprint({ accountId: csvAccount.id, date: "2026-09-03", amount: 40, currency: "USD", note: "Groceries" });
    await prisma.transaction.createMany({
      data: [
        // An import from before fingerprints existed: no externalId.
        { date: civilDate(2026, 9, 2), amount: 12.5, currency: "USD", type: "EXPENSE", accountId: csvAccount.id, source: "CSV", note: "Coffee shop" },
        // An import that stored its fingerprint.
        { date: civilDate(2026, 9, 3), amount: 40, currency: "USD", type: "EXPENSE", accountId: csvAccount.id, source: "CSV", note: "Groceries", externalId: csvExternalId(storedFp, 1) },
        // A manual row with the same fields is not a CSV duplicate.
        { date: civilDate(2026, 9, 4), amount: 9, currency: "USD", type: "EXPENSE", accountId: csvAccount.id, source: "MANUAL", note: "Lunch" },
      ],
    });
    const candidates = [
      { date: "2026-09-02", amount: 12.5, note: "coffee shop" },
      { date: "2026-09-03", amount: 40, note: "Groceries" },
      { date: "2026-09-04", amount: 9, note: "Lunch" },
      { date: "2026-09-05", amount: 7, note: "Bus" },
      { date: "2026-09-05", amount: 7, note: "Bus" },
    ];
    const report = await findCsvDuplicates({ accountId: csvAccount.id, currency: "USD", rows: candidates });
    eq("a row matching a pre-fingerprint CSV import is detected", report.matches.get(0)?.map((m) => `${toISODate(m.date)}:${m.amount}`).join(","), "2026-09-02:12.5");
    eq("a row matching a fingerprinted CSV import is detected", report.matches.get(1)?.length, 1);
    eq("a row matching only a MANUAL transaction is not", report.matches.has(2), false);
    eq("new rows are not", `${report.matches.has(3)}:${report.matches.has(4)}`, "false:false");
    eq("existing counts are per fingerprint", `${report.existingCountByFingerprint.get(legacyFp)}:${report.existingCountByFingerprint.get(storedFp)}:${report.existingCountByFingerprint.get(report.fingerprints[3]) ?? 0}`, "1:1:0");
    eq("the fingerprint list lines up with the rows", `${report.fingerprints.length}:${report.fingerprints[0] === legacyFp}:${report.fingerprints[1] === storedFp}:${report.fingerprints[3] === report.fingerprints[4]}`, "5:true:true:true");
    const otherCurrency = await findCsvDuplicates({ accountId: csvAccount.id, currency: "DOP", rows: candidates.slice(0, 2) });
    eq("the same rows in another currency match nothing", otherCurrency.matches.size, 0);

    // The import's ordinal allocation: existing rows first, then the batch.
    const ordinalByFingerprint = new Map(report.existingCountByFingerprint);
    const externalIds = candidates.map((_, index) => {
      const fp = report.fingerprints[index];
      const ordinal = (ordinalByFingerprint.get(fp) ?? 0) + 1;
      ordinalByFingerprint.set(fp, ordinal);
      return csvExternalId(fp, ordinal);
    });
    eq("rows imported anyway continue after the stored ones", `${externalIds[0]}:${externalIds[1]}`, `${legacyFp}#2:${storedFp}#2`);
    eq("two identical new lines in one batch get distinct ids", `${externalIds[3] === report.fingerprints[3]}:${externalIds[4]}`, `true:${report.fingerprints[3]}#2`);
    const written = await prisma.transaction.createMany({
      data: candidates.map((row, index) => ({ date: civilDate(2026, 9, Number(row.date.slice(8))), amount: row.amount, currency: "USD", type: "EXPENSE" as const, accountId: csvAccount.id, source: "CSV" as const, note: row.note, externalId: externalIds[index] })),
    });
    eq("every row lands under the (source, externalId) unique index", written.count, 5);
    const again = await findCsvDuplicates({ accountId: csvAccount.id, currency: "USD", rows: candidates });
    eq("a third import now sees every row as already imported, with the counts grown", `${again.matches.size}:${again.existingCountByFingerprint.get(legacyFp)}:${again.existingCountByFingerprint.get(report.fingerprints[3])}`, "5:2:2");
    await prisma.transaction.deleteMany({ where: { accountId: csvAccount.id } });
    await prisma.account.delete({ where: { id: csvAccount.id } });
  }

  console.log("\n== cross-currency transfer legs ==");
  {
    const { transferLegs } = await import("../src/lib/transactions");
    const { transferSchema } = await import("../src/lib/validation");
    const same = transferLegs({ amount: 100, currency: "USD", receivedAmount: 90, fromCurrency: "USD", toCurrency: "USD" });
    eq("a same-currency transfer ignores a received amount: both legs carry the entered figure", `${same.out.amount}:${same.out.currency}:${same.in.amount}:${same.in.currency}`, "100:USD:100:USD");
    const crossBlank = transferLegs({ amount: 50000, currency: "DOP", receivedAmount: null, fromCurrency: "DOP", toCurrency: "USD" });
    eq("a cross-currency transfer with no received amount keeps today's behaviour", `${crossBlank.out.amount}:${crossBlank.out.currency}:${crossBlank.in.amount}:${crossBlank.in.currency}`, "50000:DOP:50000:DOP");
    const crossDeclared = transferLegs({ amount: 50000, currency: "DOP", receivedAmount: 830.5, fromCurrency: "DOP", toCurrency: "USD" });
    eq("a declared received amount lands on the receiving leg in that account's currency", `${crossDeclared.out.amount}:${crossDeclared.out.currency}:${crossDeclared.in.amount}:${crossDeclared.in.currency}`, "50000:DOP:830.5:USD");
    const form = { date: "2026-09-08", amount: "50000", currency: "DOP", fromAccountId: "a", toAccountId: "b", note: "" };
    const blank = transferSchema.safeParse({ ...form, receivedAmount: "" });
    eq("transferSchema: a blank received amount is null", blank.success ? String(blank.data.receivedAmount) : "rejected", "null");
    const absent = transferSchema.safeParse(form);
    eq("transferSchema: an absent received amount (same-currency form) is null", absent.success ? String(absent.data.receivedAmount) : "rejected", "null");
    const declared = transferSchema.safeParse({ ...form, receivedAmount: "830.50" });
    eq("transferSchema: a typed received amount is parsed", declared.success ? declared.data.receivedAmount : "rejected", 830.5);
    const zero = transferSchema.safeParse({ ...form, receivedAmount: "0" });
    eq("transferSchema: zero is refused", zero.success ? "accepted" : zero.error.issues[0]?.message, "Enter an amount greater than 0");
  }

  console.log("\n== transfer leg integrity (DB constraint trigger) ==");
  {
    // A transferId is not a foreign key to anything - it's just a shared
    // value application code has always been trusted to write in pairs. This
    // section proves the last-line-of-defense CONSTRAINT TRIGGER: normal
    // paired writes/deletes still commit untouched, and a lone leg (however
    // it comes to exist) is rejected at commit with a specific message.
    const legAccount = await prisma.account.create({
      data: { name: "Verify Transfer Integrity", currency: "USD", type: "CHECKING" },
    });

    // -- normal operation: writing both legs together in one DB transaction --
    const pairId = crypto.randomUUID();
    await prisma.$transaction([
      prisma.transaction.create({
        data: { date: civilDate(2026, 9, 17), amount: 25, currency: "USD", type: "TRANSFER", accountId: legAccount.id, transferId: pairId, transferDirection: "OUT", source: "MANUAL" },
      }),
      prisma.transaction.create({
        data: { date: civilDate(2026, 9, 17), amount: 25, currency: "USD", type: "TRANSFER", accountId: legAccount.id, transferId: pairId, transferDirection: "IN", source: "MANUAL" },
      }),
    ]);
    eq("a normal paired transfer write still commits under the constraint trigger", await prisma.transaction.count({ where: { transferId: pairId } }), 2);

    // -- normal operation: deleting both legs together (the deleteTransactionAction cascade) --
    await prisma.transaction.deleteMany({ where: { transferId: pairId } });
    eq("deleting both legs together (the transfer delete cascade) still commits under the constraint trigger", await prisma.transaction.count({ where: { transferId: pairId } }), 0);

    // -- violation: inserting a lone leg with no sibling is rejected at commit --
    const orphanId = crypto.randomUUID();
    let orphanError: string | null = null;
    try {
      await prisma.transaction.create({
        data: { date: civilDate(2026, 9, 17), amount: 25, currency: "USD", type: "TRANSFER", accountId: legAccount.id, transferId: orphanId, transferDirection: "OUT", source: "MANUAL" },
      });
    } catch (error) {
      orphanError = error instanceof Error ? error.message : String(error);
    }
    check("inserting a single transfer leg with no sibling is rejected", orphanError !== null);
    check(
      "the rejection names the specific integrity violation, not a generic constraint-violation code",
      orphanError !== null && orphanError.includes("Transfer integrity violation") && orphanError.includes(orphanId) && orphanError.includes("1 legs"),
    );
    eq("the rejected insert leaves no orphaned row behind (implicit transaction rolled back)", await prisma.transaction.count({ where: { transferId: orphanId } }), 0);

    // -- violation: clearing one leg's transferId orphans its sibling --
    const pairId2 = crypto.randomUUID();
    const [legA] = await prisma.$transaction([
      prisma.transaction.create({ data: { date: civilDate(2026, 9, 17), amount: 10, currency: "USD", type: "TRANSFER", accountId: legAccount.id, transferId: pairId2, transferDirection: "OUT", source: "MANUAL" } }),
      prisma.transaction.create({ data: { date: civilDate(2026, 9, 17), amount: 10, currency: "USD", type: "TRANSFER", accountId: legAccount.id, transferId: pairId2, transferDirection: "IN", source: "MANUAL" } }),
    ]);
    let orphanUpdateError: string | null = null;
    try {
      await prisma.transaction.update({ where: { id: legA.id }, data: { transferId: null } });
    } catch (error) {
      orphanUpdateError = error instanceof Error ? error.message : String(error);
    }
    check(
      "clearing one leg's transferId (orphaning its sibling) is rejected",
      orphanUpdateError !== null && orphanUpdateError.includes("Transfer integrity violation") && orphanUpdateError.includes(pairId2) && orphanUpdateError.includes("1 legs"),
    );
    eq("the rejected update leaves the pair untouched", await prisma.transaction.count({ where: { transferId: pairId2 } }), 2);

    await prisma.transaction.deleteMany({ where: { transferId: pairId2 } });
    await prisma.account.delete({ where: { id: legAccount.id } });
    console.log("  ok   transfer integrity trigger fixtures removed");
  }

  console.log("\n== pin recovery secret ==");
  {
    const recovery = await import("../src/lib/recovery");
    const previous = process.env.RECOVERY_SECRET;
    delete process.env.RECOVERY_SECRET;
    eq("recovery is off while RECOVERY_SECRET is unset", recovery.isRecoveryConfigured(), false);
    eq("an unset secret matches nothing, not even an empty candidate", `${recovery.verifyRecoverySecret("")}:${recovery.verifyRecoverySecret("anything")}`, "false:false");
    process.env.RECOVERY_SECRET = "";
    eq("an empty RECOVERY_SECRET counts as unset", `${recovery.isRecoveryConfigured()}:${recovery.verifyRecoverySecret("")}`, "false:false");
    process.env.RECOVERY_SECRET = "verify-recovery-secret";
    eq("recovery is on once the secret is set", recovery.isRecoveryConfigured(), true);
    eq("the exact secret verifies", recovery.verifyRecoverySecret("verify-recovery-secret"), true);
    eq("a near miss, a different length and an empty candidate are all refused", `${recovery.verifyRecoverySecret("Verify-recovery-secret")}:${recovery.verifyRecoverySecret("verify-recovery-secret-longer")}:${recovery.verifyRecoverySecret("")}`, "false:false:false");
    if (previous === undefined) delete process.env.RECOVERY_SECRET;
    else process.env.RECOVERY_SECRET = previous;
  }

  console.log("\n== Banco Popular Dominicano exchange rate preference ==");
  {
    // Earlier sections exercise recurring-item posting, which calls
    // getRateTable() (and therefore getBpdRates()) for real - if BPD's live
    // endpoint happened to answer, that already cached a real same-day row.
    // Clear it so the checks below start from a known, controlled state.
    await prisma.exchangeRate.deleteMany({ where: { baseCurrency: "USD", source: BPD_SOURCE } });

    console.log("-- parseBpdPayload / toRateTableEntries / isSameUtcDay (pure) --");
    const validPayload = {
      d: {
        results: [
          { DollarSellRate: 60.05, EuroSellRate: 70.7, BuySellRatesAsOf: "2026-09-15T09:05:00Z" },
        ],
      },
    };
    const parsed = parseBpdPayload(validPayload);
    eq(
      "a valid payload parses the sell rates and asOf",
      parsed ? `${parsed.dollarSellRate}:${parsed.euroSellRate}:${parsed.asOf.toISOString()}` : "null",
      "60.05:70.7:2026-09-15T09:05:00.000Z",
    );
    eq("the DOP table entry is the raw dollar sell rate", parsed ? toRateTableEntries(parsed).DOP : null, 60.05);
    eq(
      "the EUR table entry is the dollar/euro cross-rate, not the raw euro sell rate",
      parsed ? round2(toRateTableEntries(parsed).EUR) : null,
      round2(60.05 / 70.7),
    );
    eq(
      "an out-of-range dollar sell rate is rejected",
      parseBpdPayload({ d: { results: [{ DollarSellRate: 5, EuroSellRate: 70.7, BuySellRatesAsOf: "2026-09-15T09:05:00Z" }] } }),
      null,
    );
    eq(
      "an out-of-range euro sell rate is rejected",
      parseBpdPayload({ d: { results: [{ DollarSellRate: 60.05, EuroSellRate: 999, BuySellRatesAsOf: "2026-09-15T09:05:00Z" }] } }),
      null,
    );
    eq(
      "a missing BuySellRatesAsOf is rejected",
      parseBpdPayload({ d: { results: [{ DollarSellRate: 60.05, EuroSellRate: 70.7 }] } }),
      null,
    );
    eq(
      "an unparseable BuySellRatesAsOf is rejected",
      parseBpdPayload({ d: { results: [{ DollarSellRate: 60.05, EuroSellRate: 70.7, BuySellRatesAsOf: "not-a-date" }] } }),
      null,
    );
    eq("a response with no results is rejected", parseBpdPayload({ d: { results: [] } }), null);
    eq("a non-object payload is rejected", parseBpdPayload(null), null);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    eq("the same instant is the same UTC day", isSameUtcDay(today, today), true);
    eq("24 hours earlier is always a different UTC day", isSameUtcDay(today, yesterday), false);

    console.log("-- fetchBpdRates(): a hung response is abandoned at the configured hard timeout --");
    const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    const hangStart = Date.now();
    const hangResult = await fetchBpdRates();
    const hangElapsedMs = Date.now() - hangStart;
    globalThis.fetch = originalFetch;
    eq("a hung BPD response resolves to null rather than throwing or hanging forever", hangResult, null);
    check(
      `the hang is abandoned near its configured timeout, not left open (${hangElapsedMs}ms, expected roughly 4000ms)`,
      hangElapsedMs >= 3500 && hangElapsedMs <= 7000,
    );

    console.log("-- getRateTable(): stays fast and falls back cleanly when BPD hangs --");
    // Seed a fresh open.er-api.com table so getRateTable() resolves it from the
    // DB with no network call, isolating BPD's hang as the only variable.
    const fetchedAt = new Date();
    for (const [targetCurrency, rate] of Object.entries({ USD: 1, DOP: 59, EUR: 0.9 })) {
      await prisma.exchangeRate.upsert({
        where: { baseCurrency_targetCurrency_source: { baseCurrency: "USD", targetCurrency, source: "open-er-api" } },
        update: { rate, fetchedAt },
        create: { baseCurrency: "USD", targetCurrency, source: "open-er-api", rate, fetchedAt },
      });
    }
    globalThis.fetch = hangingFetch;
    const tableHangStart = Date.now();
    const hungTable = await getRateTable();
    const tableHangElapsedMs = Date.now() - tableHangStart;
    globalThis.fetch = originalFetch;
    eq(
      "USD/DOP/EUR fall back to the open.er-api.com-sourced table when BPD hangs, with no error",
      `${hungTable.rates.USD}:${hungTable.rates.DOP}:${hungTable.rates.EUR}`,
      "1:59:0.9",
    );
    eq("the table reports open-er-api as its source when BPD hangs", hungTable.source, "open-er-api");
    // A prior failure's backoff can make this call return even faster than the
    // timeout alone would - either way, "fast" is the guarantee being checked.
    check(
      `getRateTable() itself never waits past a bounded ceiling while BPD hangs (${tableHangElapsedMs}ms)`,
      tableHangElapsedMs <= 7000,
    );

    console.log("-- getRateTable(): a same-day BPD rate is preferred for DOP and EUR --");
    async function seedBpdRow(dollarSellRate: number, euroSellRate: number, asOf: Date) {
      const entries = toRateTableEntries({ dollarSellRate, euroSellRate, asOf });
      for (const [targetCurrency, rate] of Object.entries(entries)) {
        await prisma.exchangeRate.upsert({
          where: { baseCurrency_targetCurrency_source: { baseCurrency: "USD", targetCurrency, source: BPD_SOURCE } },
          update: { rate, fetchedAt: new Date(), asOf },
          create: { baseCurrency: "USD", targetCurrency, source: BPD_SOURCE, rate, fetchedAt: new Date(), asOf },
        });
      }
    }
    await seedBpdRow(62.5, 71.25, today);
    const preferred = await getRateTable();
    eq("USD stays the identity rate regardless of BPD", preferred.rates.USD, 1);
    eq("a same-day BPD rate is preferred for DOP over open.er-api.com's", preferred.rates.DOP, 62.5);
    eq(
      "a same-day BPD rate is preferred for EUR, as a derived USD cross-rate, over open.er-api.com's",
      round2(preferred.rates.EUR),
      round2(62.5 / 71.25),
    );
    eq("the table reports bpd as its source once a same-day BPD rate is preferred", preferred.source, "bpd");
    eq(
      "the table carries the BPD rate's own asOf date when preferred",
      preferred.asOf ? preferred.asOf.toISOString() : null,
      today.toISOString(),
    );

    eq("the freshness window is documented as a single named constant, 7 days", BPD_RATE_MAX_AGE_DAYS, 7);

    console.log("-- getRateTable(): a BPD rate a few days old, but within the freshness window, is still preferred --");
    const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    await seedBpdRow(64, 73, threeDaysAgo);
    const withinWindow = await getRateTable();
    eq("a BPD rate 3 days old is preferred for DOP over open.er-api.com's", withinWindow.rates.DOP, 64);
    eq(
      "a BPD rate 3 days old is preferred for EUR, as a derived USD cross-rate, over open.er-api.com's",
      round2(withinWindow.rates.EUR),
      round2(64 / 73),
    );
    eq("the table reports bpd as its source for a 3-day-old rate", withinWindow.source, "bpd");
    eq(
      "the table carries the 3-day-old rate's own asOf date",
      withinWindow.asOf ? withinWindow.asOf.toISOString() : null,
      threeDaysAgo.toISOString(),
    );

    console.log("-- getRateTable(): a BPD rate older than the freshness window is never preferred --");
    const eightDaysAgo = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000);
    await seedBpdRow(63, 72, eightDaysAgo);
    // Whether this resolves via the still-active backoff from the hang test
    // above or via a live re-check, the guarantee under test is the same: a
    // stored row past the freshness window is never returned as-is, and it is
    // never preferred.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          d: { results: [{ DollarSellRate: 63, EuroSellRate: 72, BuySellRatesAsOf: eightDaysAgo.toISOString() }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const stalePreferred = await getRateTable();
    globalThis.fetch = originalFetch;
    eq("a BPD rate 8 days old is not preferred for DOP; open.er-api.com's is used", stalePreferred.rates.DOP, 59);
    eq("a BPD rate 8 days old is not preferred for EUR; open.er-api.com's is used", stalePreferred.rates.EUR, 0.9);
    eq(
      "the table reverts to open-er-api as its source once the BPD rate falls outside the freshness window, not stuck on bpd from the prior fetch",
      stalePreferred.source,
      "open-er-api",
    );
    eq("the table carries no asOf date once it reverts to open-er-api", stalePreferred.asOf ?? null, null);

    await prisma.exchangeRate.deleteMany({ where: { baseCurrency: "USD" } });
    console.log("  ok   test ExchangeRate rows removed");
  }

  console.log("\n== Settings: Banco Popular rate source line includes the rate's own date ==");
  {
    const { getDictionary } = await import("../src/lib/i18n");
    const en = getDictionary("en");
    const es = getDictionary("es");
    const sampleDate = new Date("2026-09-15T09:05:00Z");
    eq(
      "en: rateSourceBpd embeds the rate's own formatted date",
      en.settingsPage.rateSourceBpd(formatDate(sampleDate)),
      "from Banco Popular (Sep 15, 2026)",
    );
    eq(
      "es: rateSourceBpd embeds the rate's own formatted date",
      es.settingsPage.rateSourceBpd(formatDate(sampleDate)),
      "de Banco Popular (Sep 15, 2026)",
    );
    eq(
      "en: rateSourceOpenErApi is unchanged - no date, open.er-api.com has its own fetchedAt instead",
      en.settingsPage.rateSourceOpenErApi,
      "from open.er-api.com (market rate)",
    );
  }

  console.log("\n== BPD rate cron: proactive cache warm ==");
  {
    const { NextRequest } = await import("next/server");
    const { GET: bpdCronGet } = await import("../src/app/api/cron/bpd-rate/route");
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "verify-cron-secret";
    const makeRequest = (auth?: string) =>
      new NextRequest("http://localhost/api/cron/bpd-rate", {
        headers: auth ? { authorization: auth } : undefined,
      });

    const unauthorized = await bpdCronGet(makeRequest("Bearer wrong-secret"));
    eq("a wrong bearer secret is rejected", unauthorized.status, 401);

    console.log("-- a successful check reports today's rate through the same getBpdRates() an on-demand request uses --");
    // Seeded directly (not via a mocked fetch): a hang test earlier in this
    // same process already tripped fetchBpdRates()'s module-level failure
    // backoff, so a real network attempt here would be silently skipped for
    // up to 10 minutes - exactly as it should be for a real outage, but not
    // something this check should race against. A same-day stored row is
    // read straight back by getBpdRates() with no network call at all (see
    // src/lib/bpd-rates.ts), so it exercises the real, unmodified function
    // the cron route calls without depending on that backoff window.
    await prisma.exchangeRate.deleteMany({ where: { baseCurrency: "USD" } });
    const cronToday = new Date();
    const cronEntries = toRateTableEntries({ dollarSellRate: 61.1, euroSellRate: 71.9, asOf: cronToday });
    for (const [targetCurrency, rate] of Object.entries(cronEntries)) {
      await prisma.exchangeRate.upsert({
        where: { baseCurrency_targetCurrency_source: { baseCurrency: "USD", targetCurrency, source: BPD_SOURCE } },
        update: { rate, fetchedAt: new Date(), asOf: cronToday },
        create: { baseCurrency: "USD", targetCurrency, source: BPD_SOURCE, rate, fetchedAt: new Date(), asOf: cronToday },
      });
    }
    const successResponse = await bpdCronGet(makeRequest("Bearer verify-cron-secret"));
    const successBody = await successResponse.json();
    eq("the cron endpoint itself never errors on a successful check", successResponse.status, 200);
    eq("a successful check reports cached: true", successBody.cached, true);

    console.log("-- a thrown BPD-check failure (e.g. a DB error) is swallowed, never a cron failure --");
    // bpd-rates.ts imports the shared @/lib/prisma singleton, not this
    // script's own PrismaClient instance - that's the one to break here.
    const { prisma: libPrisma } = await import("../src/lib/prisma");
    const originalFindMany = libPrisma.exchangeRate.findMany;
    // @ts-expect-error - deliberately broken to prove the route survives it
    libPrisma.exchangeRate.findMany = async () => {
      throw new Error("simulated DB failure");
    };
    const failedResponse = await bpdCronGet(makeRequest("Bearer verify-cron-secret"));
    const failedBody = await failedResponse.json();
    libPrisma.exchangeRate.findMany = originalFindMany;
    eq("the cron endpoint still returns 200, not an error status", failedResponse.status, 200);
    eq("...and reports cached: false instead of throwing", failedBody.cached, false);

    await prisma.exchangeRate.deleteMany({ where: { baseCurrency: "USD" } });
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    console.log("  ok   test ExchangeRate rows removed");
  }

  console.log("\n== data export (Settings > Export all) ==");
  {
    const { formatCsv } = await import("../src/lib/csv");
    const { createZip } = await import("../src/lib/zip");
    const { buildExportFiles, buildExportArchive, EXPORT_FILE_NAMES, exportArchiveName } =
      await import("../src/lib/data/export");
    const { balanceSign } = await import("../src/lib/transactions");
    const { inflateRawSync, crc32 } = await import("node:zlib");

    console.log("-- formatCsv is parseCsv's inverse --");
    const tricky = [
      ["Date", "Amount", "Description"],
      ["2026-09-02", "-12.50", 'Coffee, "large"'],
      ["2026-09-03", "1234.56", "Two\nlines"],
      ["2026-09-04", "0.01", " padded "],
      ["2026-09-05", "", "Café con leche"],
    ];
    const csvText = formatCsv(tricky);
    check("output starts with a UTF-8 byte order mark", csvText.startsWith("﻿"));
    check("rows end in CRLF", csvText.endsWith("\r\n") && csvText.includes('"Coffee, ""large"""\r\n'));
    eq("parseCsv reads back every cell unchanged", JSON.stringify(parseCsv(csvText)), JSON.stringify(tricky));
    eq("a plain field is not quoted", formatCsv([["2026-09-02", "-12.50", "Coffee"]]), "﻿2026-09-02,-12.50,Coffee\r\n");

    console.log("-- createZip writes a readable archive --");
    const zipStamp = new Date("2026-09-17T10:20:30Z");
    const zipped = createZip([
      { name: "a.csv", data: "x,y\r\n1,2\r\n", modifiedAt: zipStamp },
      { name: "b.csv", data: "é\r\n", modifiedAt: zipStamp },
    ]);
    const eocdOffset = zipped.length - 22;
    eq("ends with the end-of-central-directory signature", zipped.readUInt32LE(eocdOffset), 0x06054b50);
    eq("the central directory lists both entries", zipped.readUInt16LE(eocdOffset + 10), 2);
    const centralOffset = zipped.readUInt32LE(eocdOffset + 16);
    eq("the central directory starts where the entries end", zipped.readUInt32LE(centralOffset), 0x02014b50);
    const readEntry = (buffer: Buffer, offset: number) => {
      eq(`local header at ${offset} carries the signature`, buffer.readUInt32LE(offset), 0x04034b50);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const nameLength = buffer.readUInt16LE(offset + 26);
      const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      const start = offset + 30 + nameLength;
      const data = inflateRawSync(buffer.subarray(start, start + compressedSize));
      eq(`${name}: stored CRC matches the inflated bytes`, buffer.readUInt32LE(offset + 14), crc32(data));
      eq(`${name}: stored size matches the inflated bytes`, buffer.readUInt32LE(offset + 22), data.length);
      return { name, text: data.toString("utf8"), next: start + compressedSize };
    };
    const first = readEntry(zipped, 0);
    const second = readEntry(zipped, first.next);
    eq("first entry name", first.name, "a.csv");
    eq("first entry inflates to its text", first.text, "x,y\r\n1,2\r\n");
    eq("second entry keeps UTF-8 content", second.text, "é\r\n");
    eq("the entries end exactly where the central directory begins", second.next, centralOffset);
    eq("the archive name is stamped with the civil day", exportArchiveName(civilDate(2026, 9, 17)), "cadence-export-2026-09-17.zip");

    console.log("-- buildExportFiles covers every row of every type --");
    const files = await buildExportFiles("en");
    eq("one file per data type, in order", files.map((file) => file.name).join(","), EXPORT_FILE_NAMES.join(","));
    const parsedFiles = new Map(files.map((file) => [file.name, parseCsv(file.text)]));
    const dataRowCount = (name: string) => (parsedFiles.get(name)?.length ?? 0) - 1;
    eq("transactions.csv has one row per Transaction", dataRowCount("transactions.csv"), await prisma.transaction.count());
    eq("goals.csv has one row per Goal", dataRowCount("goals.csv"), await prisma.goal.count());
    eq("goal_contributions.csv has one row per GoalContribution", dataRowCount("goal_contributions.csv"), await prisma.goalContribution.count());
    eq("recurring_items.csv has one row per RecurringItem", dataRowCount("recurring_items.csv"), await prisma.recurringItem.count());
    eq("budgets.csv has one row per Budget", dataRowCount("budgets.csv"), await prisma.budget.count());
    eq("accounts.csv has one row per Account, archived included", dataRowCount("accounts.csv"), await prisma.account.count());
    eq("categories.csv has one row per Category", dataRowCount("categories.csv"), await prisma.category.count());
    for (const file of files) {
      const table = parsedFiles.get(file.name) ?? [];
      const width = table[0]?.length ?? 0;
      check(`${file.name}: every row has the header's ${width} columns`, table.every((row) => row.length === width));
      check(`${file.name}: headers are labels, not field names`, !table[0].some((cell) => /[a-z][A-Z]/.test(cell)));
    }
    eq(
      "transactions.csv leads with the importer's default Date, Amount, Description columns",
      (parsedFiles.get("transactions.csv") ?? [])[0].slice(0, 3).join(","),
      "Date,Amount,Description",
    );

    console.log("-- transactions.csv reads back through the importer's own parsers with its defaults --");
    const stored = await prisma.transaction.findMany({
      include: { account: { select: { name: true } }, category: { select: { name: true } } },
    });
    const storedById = new Map(stored.map((row) => [row.id, row]));
    const transactionTable = parsedFiles.get("transactions.csv") ?? [];
    const header = transactionTable[0];
    const col = (name: string) => header.indexOf(name);
    let readBack = 0;
    for (const cells of transactionTable.slice(1)) {
      const original = storedById.get(cells[col("ID")]);
      if (!original) continue;
      const date = parseDateWithFormat(cells[0], "YYYY-MM-DD");
      const rawAmount = parseAmount(cells[1]);
      const signedOriginal = balanceSign(original.type, original.transferDirection) * num(original.amount);
      const sameDate = date !== null && toISODate(date) === toISODate(original.date);
      const sameAmount = rawAmount !== null && Math.abs(rawAmount - signedOriginal) < 0.005;
      const sameNote = cells[2] === (original.note ?? "");
      const sameAccount = cells[col("Account")] === original.account.name;
      const sameCurrency = cells[col("Currency")] === original.currency;
      const sameCategory = cells[col("Category")] === (original.category?.name ?? "");
      if (sameDate && sameAmount && sameNote && sameAccount && sameCurrency && sameCategory) readBack += 1;
      else check(`transaction ${original.id} round-trips`, false, cells.join(" | "));
    }
    eq("every stored transaction reads back with the same date, signed amount, note, account, currency and category", readBack, stored.length);
    const spending = stored.find((row) => row.type === "EXPENSE");
    const income = stored.find((row) => row.type === "INCOME");
    const rowFor = (id: string | undefined) => transactionTable.find((cells) => cells[col("ID")] === id);
    check("an expense is written negative (spending) for the importer's signed convention", (parseAmount(rowFor(spending?.id)?.[1] ?? "") ?? 0) < 0);
    check("income is written positive", (parseAmount(rowFor(income?.id)?.[1] ?? "") ?? 0) > 0);
    check("type and source are shown as labels", rowFor(spending?.id)?.[col("Type")] === "Expense" && /^[A-Z]/.test(rowFor(spending?.id)?.[col("Source")] ?? ""));

    console.log("-- the ZIP download holds those same files --");
    const archive = await buildExportArchive("es");
    eq("the archive lists all seven files", archive.readUInt16LE(archive.length - 22 + 10), EXPORT_FILE_NAMES.length);
    const firstEntry = readEntry(archive, 0);
    eq("its first entry is transactions.csv", firstEntry.name, "transactions.csv");
    check("headers follow the app language (Spanish here)", firstEntry.text.startsWith("﻿Fecha,Monto,Descripción"));
  }

  console.log("\n== extraordinary expenses ==");
  {
    const { classifyExtraordinary, median, EXTRAORDINARY_MIN_HISTORY, EXTRAORDINARY_MULTIPLIER } =
      await import("../src/lib/extraordinary");
    const { findExtraordinaryCandidates } = await import("../src/lib/data/extraordinary");
    const { canBeExtraordinary } = await import("../src/lib/transactions");
    const { getCategorySuggestions: suggestFor } = await import("../src/lib/data/payday");
    const { classifyCompletedMonth: classifyMonth, getCurrentMonthPace: currentPace } =
      await import("../src/lib/data/monthly");
    const { monthWindow: windowFor } = await import("../src/lib/month");

    console.log("-- classification (pure) --");
    eq("median of an odd count is the middle value", median([110, 90, 100]), 100);
    eq("median of an even count is the mean of the two middle values", median([90, 100, 110, 400]), 105);
    eq("median of nothing is 0", median([]), 0);
    eq("the threshold is 3x the median", EXTRAORDINARY_MULTIPLIER, 3);
    eq("at least 3 prior transactions are needed for a verdict", EXTRAORDINARY_MIN_HISTORY, 3);
    eq("two prior amounts give no verdict at all, however large the candidate", classifyExtraordinary([100, 100], 10000), null);
    eq("no prior amounts give no verdict", classifyExtraordinary([], 10000), null);
    eq(
      "three similar amounts and a candidate at 4x the median: possibly extraordinary",
      JSON.stringify(classifyExtraordinary([90, 100, 110], 400)),
      JSON.stringify({ possiblyExtraordinary: true, median: 100, sampleSize: 3 }),
    );
    eq("exactly 3x is not above the threshold", classifyExtraordinary([90, 100, 110], 300)?.possiblyExtraordinary, false);
    eq("2.5x is ordinary", classifyExtraordinary([90, 100, 110], 250)?.possiblyExtraordinary, false);
    eq("a median of 0 never flags anything", classifyExtraordinary([0, 0, 0], 50)?.possiblyExtraordinary, false);
    eq(
      "the median is robust to one earlier outlier in the history",
      classifyExtraordinary([90, 100, 110, 5000], 310)?.possiblyExtraordinary,
      false, // median 105, threshold 315
    );

    console.log("-- which rows may be marked (pure) --");
    check("a manual expense may be marked", canBeExtraordinary({ type: "EXPENSE", source: "MANUAL", externalId: null }));
    check("a CSV expense may be marked", canBeExtraordinary({ type: "EXPENSE", source: "CSV", externalId: "csv:abc:1" }));
    check("a RECURRING row never is - its amount is scheduled, not organic", !canBeExtraordinary({ type: "EXPENSE", source: "RECURRING", externalId: "item:2026-08-01" }));
    check("income never is", !canBeExtraordinary({ type: "INCOME", source: "MANUAL", externalId: null }));
    check("a transfer leg never is", !canBeExtraordinary({ type: "TRANSFER", source: "MANUAL", externalId: null }));
    check("the expense a goal contribution wrote never is", !canBeExtraordinary({ type: "EXPENSE", source: "MANUAL", externalId: "goal-contribution:abc" }));

    console.log("-- against a category's recent history (database) --");
    const extraAccount = await prisma.account.create({
      data: { name: "Verify Extraordinary", currency: "USD", type: "CHECKING" },
    });
    const extraCategory = await prisma.category.create({ data: { name: "Verify Extraordinary Cat", kind: "EXPENSE" } });
    const thinCategory = await prisma.category.create({ data: { name: "Verify Extraordinary Thin", kind: "EXPENSE" } });
    const extraContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 9, 17), currentPeriod: periodForDate(civilDate(2026, 9, 17)) };
    const extraRow = (amount: number, extra: Partial<{ source: "MANUAL" | "RECURRING"; categoryId: string; externalId: string; currency: string }> = {}) => ({
      date: civilDate(2026, 8, 20),
      amount,
      currency: extra.currency ?? "USD",
      type: "EXPENSE" as const,
      accountId: extraAccount.id,
      categoryId: extra.categoryId ?? extraCategory.id,
      source: extra.source ?? ("MANUAL" as const),
      externalId: extra.externalId,
    });
    await prisma.transaction.createMany({
      data: [
        extraRow(100),
        extraRow(110),
        extraRow(90),
        // Scheduled, not organic: never part of the history the median is taken over.
        extraRow(5000, { source: "RECURRING", externalId: "verify-extraordinary-item:2026-08-20" }),
        extraRow(100, { categoryId: thinCategory.id }),
        extraRow(100, { categoryId: thinCategory.id }),
      ],
    });
    const created = await prisma.transaction.findFirst({ where: { accountId: extraAccount.id } });
    eq("a new row is never flagged by default", created?.isExtraordinary, false);

    const candidates = await findExtraordinaryCandidates(
      [
        { key: "4x", categoryId: extraCategory.id, amount: 400, currency: "USD" },
        { key: "just-over-3x-of-100", categoryId: extraCategory.id, amount: 310, currency: "USD" },
        { key: "2.5x", categoryId: extraCategory.id, amount: 250, currency: "USD" },
        { key: "dop", categoryId: extraCategory.id, amount: 24000, currency: "DOP" }, // 400 USD at the harness rate
        { key: "thin", categoryId: thinCategory.id, amount: 10000, currency: "USD" },
      ],
      extraContext,
    );
    eq(
      "4x the category's median is surfaced, with the median it was measured against",
      JSON.stringify(candidates.get("4x")),
      JSON.stringify({ possiblyExtraordinary: true, median: 100, sampleSize: 3, categoryId: extraCategory.id, categoryName: "Verify Extraordinary Cat", currency: "USD" }),
    );
    check(
      "the RECURRING row is not in the history: the median is 100, not 105, so 310 still trips 3x",
      candidates.has("just-over-3x-of-100"),
    );
    check("2.5x is not surfaced", !candidates.has("2.5x"));
    check("a candidate in another currency is compared in the display currency", candidates.has("dop"));
    check("a category with only two prior transactions never gets a suggestion", !candidates.has("thin"));
    eq("nothing was written by measuring", await prisma.transaction.count({ where: { accountId: extraAccount.id } }), 6);

    console.log("-- accepting the suggestion excludes the row from both averages; declining leaves it in --");
    // The 400 lands the same way a declined suggestion leaves it: unflagged.
    const bigOne = await prisma.transaction.create({ data: extraRow(400) });
    // The RECURRING fixture has made its point; the rest of the block reads
    // the category's organic rows only, so the figures below stay exact.
    await prisma.transaction.deleteMany({ where: { accountId: extraAccount.id, source: "RECURRING" } });

    const planRef = { year: 2026, month: 9, period: "B" as const };
    const augustWindow = windowFor({ year: 2026, month: 8 });
    const categoryMeta = await prisma.category.findMany({ select: { id: true, name: true, color: true, isSavingsDefault: true } });
    const paceContext = { ...extraContext, today: civilDate(2026, 8, 25), currentPeriod: periodForDate(civilDate(2026, 8, 25)) };

    const suggestionsDeclined = await suggestFor(planRef, [{ id: extraCategory.id }], extraContext);
    eq(
      "declined (unflagged): the payday suggestion averages every row, the 400 included",
      JSON.stringify(suggestionsDeclined.get(extraCategory.id)),
      JSON.stringify({ amount: 700, basis: "average" }),
    );
    const augustDeclined = await classifyMonth(augustWindow, extraContext, [], categoryMeta);
    const paceDeclined = await currentPace(paceContext);

    await prisma.transaction.update({ where: { id: bigOne.id }, data: { isExtraordinary: true } });
    const suggestionsAccepted = await suggestFor(planRef, [{ id: extraCategory.id }], extraContext);
    eq(
      "accepted: the payday suggestion leaves the one-off out of the sum, over the same number of periods",
      JSON.stringify(suggestionsAccepted.get(extraCategory.id)),
      JSON.stringify({ amount: 300, basis: "average" }),
    );
    const augustAccepted = await classifyMonth(augustWindow, extraContext, [], categoryMeta);
    eq("accepted: the completed month's lifestyle figure drops by exactly the one-off", round2(augustDeclined.lifestyle - augustAccepted.lifestyle), 400);
    const acceptedLine = augustAccepted.lifestyleByCategory.find((line) => line.categoryId === extraCategory.id);
    eq("accepted: the month's own per-category line is typical spending only", acceptedLine?.spent, 300);
    const paceAccepted = await currentPace(paceContext);
    eq(
      "the month in progress still counts it - spent so far is a statement of fact, not an average",
      paceAccepted.lifestyleSpentSoFar,
      paceDeclined.lifestyleSpentSoFar,
    );
    const historyAfterFlag = await findExtraordinaryCandidates(
      [{ key: "again", categoryId: extraCategory.id, amount: 310, currency: "USD" }],
      extraContext,
    );
    check("a confirmed one-off is not in the history the next candidate is measured against", historyAfterFlag.has("again"));

    console.log("-- the manual toggle works in both directions on an ordinary row --");
    const ordinary = await prisma.transaction.findFirst({ where: { accountId: extraAccount.id, amount: 110 } });
    await prisma.transaction.update({ where: { id: ordinary!.id }, data: { isExtraordinary: true } });
    eq(
      "marking an ordinary row by hand excludes it too, whether or not the threshold ever suggested it",
      suggestionsAccepted.get(extraCategory.id)!.amount - (await suggestFor(planRef, [{ id: extraCategory.id }], extraContext)).get(extraCategory.id)!.amount,
      110,
    );
    await prisma.transaction.update({ where: { id: ordinary!.id }, data: { isExtraordinary: false } });
    await prisma.transaction.update({ where: { id: bigOne.id }, data: { isExtraordinary: false } });
    eq(
      "unmarking restores both rows to the average exactly",
      JSON.stringify((await suggestFor(planRef, [{ id: extraCategory.id }], extraContext)).get(extraCategory.id)),
      JSON.stringify({ amount: 700, basis: "average" }),
    );
    eq("and the completed month is back to its declined figure", (await classifyMonth(augustWindow, extraContext, [], categoryMeta)).lifestyle, augustDeclined.lifestyle);

    await prisma.transaction.deleteMany({ where: { accountId: extraAccount.id } });
    await prisma.account.delete({ where: { id: extraAccount.id } });
    await prisma.category.deleteMany({ where: { id: { in: [extraCategory.id, thinCategory.id] } } });
    console.log("  ok   extraordinary fixtures removed");
  }

  console.log("\n== recurring pattern detection ==");
  {
    const {
      detectRecurringPatterns,
      dominantAmountCluster,
      fitSemiMonthlyAnchors,
      inferCadence,
      isOrganicExpense,
      MIN_OCCURRENCES,
    } = await import("../src/lib/recurring-detection");
    type DetectableTransaction = import("../src/lib/recurring-detection").DetectableTransaction;
    const { addDays: plusDays } = await import("../src/lib/date");

    const detectToday = civilDate(2026, 9, 17);
    let nextDetectId = 0;
    const organic = (
      date: Date,
      amount: number,
      note: string,
      extra: Partial<DetectableTransaction> = {},
    ): DetectableTransaction => ({
      id: `detect-${(nextDetectId += 1)}`,
      date,
      amount,
      currency: "USD",
      type: "EXPENSE",
      source: "CSV",
      accountId: "acct-a",
      categoryId: null,
      note,
      externalId: null,
      isExtraordinary: false,
      ...extra,
    });
    const detect = (
      transactions: DetectableTransaction[],
      extra: Partial<Parameters<typeof detectRecurringPatterns>[0]> = {},
    ) => detectRecurringPatterns({ transactions, trackedItems: [], dismissed: [], today: detectToday, ...extra });

    console.log("-- which rows count as evidence (pure) --");
    check("a manual expense counts", isOrganicExpense(organic(detectToday, 10, "GYM", { source: "MANUAL" })));
    check("a CSV expense counts", isOrganicExpense(organic(detectToday, 10, "GYM")));
    check("a RECURRING-posted row never does - it is the schedule, not evidence of one", !isOrganicExpense(organic(detectToday, 10, "GYM", { source: "RECURRING" })));
    check("a confirmed one-off never does", !isOrganicExpense(organic(detectToday, 10, "GYM", { isExtraordinary: true })));
    check("income never does", !isOrganicExpense(organic(detectToday, 10, "GYM", { type: "INCOME" })));
    check("a transfer leg never does", !isOrganicExpense(organic(detectToday, 10, "GYM", { type: "TRANSFER" })));
    check("the expense a goal contribution wrote never does", !isOrganicExpense(organic(detectToday, 10, "GYM", { source: "MANUAL", externalId: "goal-contribution:abc" })));
    check("a row with no description cannot be grouped, so it never does", !isOrganicExpense(organic(detectToday, 10, "  ")));

    console.log("-- amount tolerance band (pure) --");
    eq("identical amounts are one cluster", JSON.stringify(dominantAmountCluster([14.99, 14.99, 14.99]).members), "[0,1,2]");
    eq("a price hike within 10% stays in the cluster", JSON.stringify(dominantAmountCluster([14.99, 14.99, 15.49, 15.49]).members), "[0,1,2,3]");
    eq("cent-level drift on a cheap bill stays in (the 1.00 floor beats 10%)", JSON.stringify(dominantAmountCluster([3.0, 3.35, 3.1]).members), "[0,1,2]");
    eq("an amount 25% off is not the same bill", JSON.stringify(dominantAmountCluster([20, 20, 25]).members), "[0,1]");
    eq("the biggest cluster wins, not the median (Prime among Amazon orders)", JSON.stringify(dominantAmountCluster([14.99, 63.2, 14.99, 120, 14.99, 9.5]).members), "[0,2,4]");

    console.log("-- cadence from intervals (pure) --");
    const monthlyDates = [civilDate(2026, 6, 12), civilDate(2026, 7, 12), civilDate(2026, 8, 12), civilDate(2026, 9, 12)];
    eq("the same day each month is MONTHLY", inferCadence(monthlyDates)?.cadence, "MONTHLY");
    eq("... anchored on that day", inferCadence(monthlyDates)?.anchorDays.join(","), "12");
    eq("every 7 days is WEEKLY", inferCadence([civilDate(2026, 8, 3), civilDate(2026, 8, 10), civilDate(2026, 8, 17), civilDate(2026, 8, 24)])?.cadence, "WEEKLY");
    eq("once a year is YEARLY", inferCadence([civilDate(2024, 3, 5), civilDate(2025, 3, 5), civilDate(2026, 3, 5)])?.cadence, "YEARLY");
    eq("a monthly bill with one month missing from the ledger is still MONTHLY (>= 50% of gaps)", inferCadence([civilDate(2026, 5, 12), civilDate(2026, 6, 12), civilDate(2026, 8, 12), civilDate(2026, 9, 12)])?.cadence, "MONTHLY");
    eq("a monthly bill on the 31st is clamped in short months but keeps its anchor", inferCadence([civilDate(2026, 5, 31), civilDate(2026, 6, 30), civilDate(2026, 7, 31), civilDate(2026, 8, 31)])?.anchorDays.join(","), "31");
    eq("a monthly bill pulled off a weekend keeps its anchor (Aug 1 2026 is a Saturday -> Jul 31)", inferCadence([civilDate(2026, 6, 1), civilDate(2026, 7, 1), civilDate(2026, 7, 31), civilDate(2026, 9, 1)])?.anchorDays.join(","), "1");
    eq("irregular gaps (9, 23, 41 days) fit no cadence", inferCadence([civilDate(2026, 6, 1), civilDate(2026, 6, 10), civilDate(2026, 7, 3), civilDate(2026, 8, 13)]), null);
    eq("two dates (one gap) are never enough", inferCadence([civilDate(2026, 6, 12), civilDate(2026, 7, 12)]), null);

    console.log("-- semi-monthly vs biweekly: day-of-month clustering, not gap length (pure) --");
    // Anchored on the 1st and 16th. Aug 1 2026 is a Saturday and Aug 16 a
    // Sunday, so those two land on the preceding Friday, exactly as period.ts
    // moves a payday. Gaps: 15,15,15,15,14,18,15 - six of seven are within
    // 14+-2, so a gap-only rule would call this biweekly.
    const semiMonthly = [
      civilDate(2026, 6, 1), civilDate(2026, 6, 16),
      civilDate(2026, 7, 1), civilDate(2026, 7, 16),
      civilDate(2026, 7, 31), civilDate(2026, 8, 14),
      civilDate(2026, 9, 1), civilDate(2026, 9, 16),
    ];
    eq("1st & 16th with weekend pull-backs is SEMI_MONTHLY", inferCadence(semiMonthly)?.cadence, "SEMI_MONTHLY");
    eq("... anchored on the 1st and the 16th", inferCadence(semiMonthly)?.anchorDays.join(","), "1,16");
    const semiFit = fitSemiMonthlyAnchors(semiMonthly);
    eq("the anchor fit counts the occurrences that needed a weekend shift", semiFit?.shifted, 2);
    eq("... and the exact ones", semiFit?.exact, 6);
    // Every 14 days from Fri Jun 5: days of month 5,19,3,17,31,14,28,11 - drifting.
    const biweekly = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => civilDate(2026, 6, 5 + 14 * i));
    eq("every 14 days drifting across the month is BIWEEKLY", inferCadence(biweekly)?.cadence, "BIWEEKLY");
    eq("... with no anchor day", inferCadence(biweekly)?.anchorDays.length, 0);
    eq("a biweekly debit that slips to Monday is still BIWEEKLY", inferCadence([civilDate(2026, 6, 5), civilDate(2026, 6, 19), civilDate(2026, 7, 6), civilDate(2026, 7, 17), civilDate(2026, 7, 31), civilDate(2026, 8, 14), civilDate(2026, 8, 28)])?.cadence, "BIWEEKLY");
    // Only the first four biweekly dates: Jun 5, 19, Jul 3, 17. Anchors 5 & 19
    // would explain them, but only by leaning on two weekend shifts (Jul 5 and
    // Jul 19 are Sundays) - the biweekly reading needs none, so it wins.
    eq("four biweekly dates that happen to fit two weekend-shifted anchors are still BIWEEKLY", inferCadence(biweekly.slice(0, 4))?.cadence, "BIWEEKLY");
    eq("three semi-monthly dates already classify (Jun 1, Jun 16, Jul 1)", inferCadence(semiMonthly.slice(0, 3))?.cadence, "SEMI_MONTHLY");
    const paydays = [civilDate(2026, 6, 15), civilDate(2026, 6, 30), civilDate(2026, 7, 15), civilDate(2026, 7, 31), civilDate(2026, 8, 14), civilDate(2026, 8, 31), civilDate(2026, 9, 15)];
    eq("the 15th and the last day of the month - the app's own paydays - is SEMI_MONTHLY", inferCadence(paydays)?.cadence, "SEMI_MONTHLY");
    eq("... anchored on the 15th and the 31st (clamped to each month's real end)", inferCadence(paydays)?.anchorDays.join(","), "15,31");
    eq("a semi-monthly bill with one stray extra charge still fits (>= 80% of occurrences from five on)", inferCadence([civilDate(2026, 5, 1), civilDate(2026, 5, 15), civilDate(2026, 6, 1), civilDate(2026, 6, 16), civilDate(2026, 7, 1), civilDate(2026, 7, 16), civilDate(2026, 7, 31), civilDate(2026, 8, 14), civilDate(2026, 8, 20), civilDate(2026, 9, 1)])?.cadence, "SEMI_MONTHLY");
    // Inside February 28 days is both two biweekly gaps and one month, so
    // three dates there are a dead heat; the mean gap (14, not 15.2) then
    // reads biweekly until the next charge settles it.
    eq("a dead heat inside February (2nd & 16th, all Mondays, 14 days apart) reads as BIWEEKLY until a later charge settles it", inferCadence([civilDate(2026, 2, 2), civilDate(2026, 2, 16), civilDate(2026, 3, 2)])?.cadence, "BIWEEKLY");
    eq("... which Apr 2 does: the lattice would want Mar 30", inferCadence([civilDate(2026, 2, 2), civilDate(2026, 2, 16), civilDate(2026, 3, 2), civilDate(2026, 3, 16), civilDate(2026, 4, 2)])?.cadence, "SEMI_MONTHLY");

    // Property check over the calendar: a strict 14-day series starting on
    // any day of 2026, with each date pulled back off a weekend, must never
    // read as semi-monthly, at three, five or six occurrences.
    const pullBack = (date: Date) => {
      const weekday = date.getUTCDay();
      return weekday === 6 ? plusDays(date, -1) : weekday === 0 ? plusDays(date, -2) : date;
    };
    let biweeklyMisread = 0;
    let biweeklyChecked = 0;
    for (const count of [3, 5, 6]) {
      for (let offset = 0; offset < 365; offset += 1) {
        const start = plusDays(civilDate(2026, 1, 1), offset);
        const dates = Array.from({ length: count }, (_, i) => pullBack(plusDays(start, 14 * i)));
        biweeklyChecked += 1;
        if (inferCadence(dates)?.cadence === "SEMI_MONTHLY") biweeklyMisread += 1;
      }
    }
    eq(`no biweekly series starting anywhere in 2026 reads as SEMI_MONTHLY (${biweeklyChecked} series)`, biweeklyMisread, 0);
    // And a 1st & 16th series with the payday weekend rule, starting in any
    // month of 2025-2026, reads as SEMI_MONTHLY from five occurrences on.
    let semiMisread = 0;
    let semiChecked = 0;
    for (const count of [5, 6, 8]) {
      for (let monthOffset = 0; monthOffset < 24; monthOffset += 1) {
        const dates = Array.from({ length: count }, (_, i) => {
          const monthIndex = monthOffset + Math.floor(i / 2);
          const year = 2025 + Math.floor(monthIndex / 12);
          const month = (monthIndex % 12) + 1;
          return pullBack(civilDate(year, month, i % 2 === 0 ? 1 : 16));
        });
        semiChecked += 1;
        if (inferCadence(dates)?.cadence !== "SEMI_MONTHLY") semiMisread += 1;
      }
    }
    eq(`every 1st & 16th series starting in any month of 2025-2026 reads as SEMI_MONTHLY from five charges on (${semiChecked} series)`, semiMisread, 0);

    console.log("-- candidates from transactions (pure) --");
    const gym = semiMonthly.map((date) => organic(date, 25, "PLANET FITNESS 1234"));
    const gymCandidates = detect(gym);
    eq("a semi-monthly gym is one candidate", gymCandidates.length, 1);
    eq("... classified SEMI_MONTHLY", gymCandidates[0]?.cadence, "SEMI_MONTHLY");
    eq("... named from the cleaned merchant text", gymCandidates[0]?.name, "Planet Fitness");
    eq("... keyed by the normalised merchant", gymCandidates[0]?.merchantKey, "PLANET FITNESS");
    eq("... with the two anchor days", gymCandidates[0]?.anchorDays.join(","), "1,16");
    eq("... and one next due date per anchor, the first on or after today (Sep 17)", gymCandidates[0]?.nextDates.map(toISODate).join(","), "2026-10-01,2026-10-16");
    eq("... backed by all eight charges, oldest first", gymCandidates[0]?.occurrences.map((row) => toISODate(row.date)).join(","), semiMonthly.map(toISODate).join(","));
    eq("... at the amount as last charged", gymCandidates[0]?.amount, 25);
    eq("... in the charges' currency and account", `${gymCandidates[0]?.currency}/${gymCandidates[0]?.accountId}`, "USD/acct-a");
    eq("... noting where the evidence came from", gymCandidates[0]?.detectedFrom, "CSV");
    const biCandidates = detect(biweekly.map((date) => organic(date, 12.5, "BLUE APRON")));
    eq("a biweekly box is BIWEEKLY", biCandidates[0]?.cadence, "BIWEEKLY");
    eq("... next due 14 days after the last charge (Sep 11 -> Sep 25)", biCandidates[0]?.nextDates.map(toISODate).join(","), "2026-09-25");

    eq("the minimum is three occurrences", MIN_OCCURRENCES, 3);
    eq("two charges never suggest anything", detect([organic(civilDate(2026, 7, 12), 9.99, "NETFLIX.COM"), organic(civilDate(2026, 8, 12), 9.99, "NETFLIX.COM")]).length, 0);
    const netflix3 = [civilDate(2026, 7, 12), civilDate(2026, 8, 12), civilDate(2026, 9, 12)].map((date) => organic(date, 9.99, "NETFLIX.COM 866-579-7172", { source: "MANUAL", categoryId: "cat-sub" }));
    const netflixCandidates = detect(netflix3);
    eq("three do", netflixCandidates.length, 1);
    eq("... as MONTHLY on the 12th, next Oct 12", `${netflixCandidates[0]?.cadence}/${netflixCandidates[0]?.anchorDays.join(",")}/${netflixCandidates[0]?.nextDates.map(toISODate).join(",")}`, "MONTHLY/12/2026-10-12");
    eq("... carrying the category the charges were filed under", netflixCandidates[0]?.categoryId, "cat-sub");
    eq("... and the manual source", netflixCandidates[0]?.detectedFrom, "MANUAL");
    eq("a confirmed one-off is not evidence: flagging one of the three leaves two", detect([netflix3[0], netflix3[1], { ...netflix3[2], isExtraordinary: true }]).length, 0);
    eq("a RECURRING-posted row is not evidence either", detect([netflix3[0], netflix3[1], { ...netflix3[2], source: "RECURRING" }]).length, 0);
    eq("a flagged one-off at the same merchant does not join the evidence either", detect([...netflix3, organic(civilDate(2026, 9, 14), 9.99, "NETFLIX.COM", { isExtraordinary: true })])[0]?.occurrences.length, 3);

    console.log("-- what is not suggested (pure) --");
    const tracked = (item: Partial<import("../src/lib/recurring-detection").TrackedRecurringItem>) => ({
      trackedItems: [{ name: "Netflix", amount: 9.99, currency: "USD", accountId: "acct-a", categoryId: null, active: true, ...item }],
    });
    eq("a pattern an active item already tracks (name matches, amount within band) is skipped", detect(netflix3, tracked({})).length, 0);
    eq("... or one on the same account, category and amount when the name differs", detect(netflix3, tracked({ name: "Streaming", categoryId: "cat-sub" })).length, 0);
    eq("... but a paused item does not count as tracking it", detect(netflix3, tracked({ active: false })).length, 1);
    eq("a strong name match is tracked even if the price has genuinely risen past the tolerance band (Claro)", detect(netflix3, tracked({ amount: 19.99 })).length, 0);
    eq("a strong name match is tracked even in another currency (a EUR-tracked item's real charges land in the account's local currency - Whoop/Aplazame/AppleCare)", detect(netflix3, tracked({ currency: "DOP" })).length, 0);
    eq("without a name match, an item on the same account+category still needs currency and amount to agree (shapeMatches stays strict)", detect(netflix3, tracked({ name: "Streaming", categoryId: "cat-sub", amount: 19.99 })).length, 1);
    eq("... currency too", detect(netflix3, tracked({ name: "Streaming", categoryId: "cat-sub", currency: "DOP" })).length, 1);
    eq("a genuinely unrelated pattern (different merchant name) is still suggested, not suppressed by the widened name check", detect(gym, tracked({ name: "Netflix" })).length, 1);
    const dismissedNetflix = { dismissed: [{ accountId: "acct-a", merchantKey: "NETFLIX COM" }] };
    eq("a dismissed merchant on that account is never suggested again", detect(netflix3, dismissedNetflix).length, 0);
    eq("... however many more charges arrive", detect([...netflix3, organic(civilDate(2026, 9, 13), 9.99, "NETFLIX.COM")], dismissedNetflix).length, 0);
    eq("... but the same merchant on another account still is", detect(netflix3.map((row) => ({ ...row, accountId: "acct-b" })), dismissedNetflix).length, 1);
    eq("the same merchant on two accounts is two candidates", detect([...netflix3, ...netflix3.map((row) => ({ ...row, id: `${row.id}-b`, accountId: "acct-b" }))]).length, 2);
    eq("a pattern that stopped (last charge in March, today Sep 17) is not suggested", detect([civilDate(2026, 1, 12), civilDate(2026, 2, 12), civilDate(2026, 3, 12)].map((date) => organic(date, 9.99, "NETFLIX.COM"))).length, 0);
    eq("a monthly bill last seen 40 days ago is still alive, and its next date skips the one already missed", detect([civilDate(2026, 6, 8), civilDate(2026, 7, 8), civilDate(2026, 8, 8)].map((date) => organic(date, 9.99, "NETFLIX.COM")))[0]?.nextDates.map(toISODate).join(","), "2026-10-08");
    eq("the next date is never today's charge again (last charge today -> next month)", detect([civilDate(2026, 7, 17), civilDate(2026, 8, 17), civilDate(2026, 9, 17)].map((date) => organic(date, 9.99, "NETFLIX.COM")))[0]?.nextDates.map(toISODate).join(","), "2026-10-17");
    eq("candidates come back most charges first, then by name", detect([...gym, ...netflix3]).map((candidate) => candidate.name).join("|"), "Planet Fitness|Netflix Com");
  }

  console.log("\n== recurring suggestions (database) ==");
  {
    const { findRecurringSuggestions, acceptRecurringSuggestion, dismissRecurringSuggestion, recurringItemForCandidate } =
      await import("../src/lib/data/recurring-suggestions");
    const suggestToday = civilDate(2026, 9, 17);
    const suggestContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: suggestToday,
      currentPeriod: periodForDate(suggestToday),
    };
    const usdAccount = await prisma.account.create({
      data: { name: "Verify Suggest USD", currency: "USD", type: "CHECKING" },
    });
    const dopAccount = await prisma.account.create({
      data: { name: "Verify Suggest DOP", currency: "DOP", type: "CHECKING" },
    });
    const suggestCategory = await prisma.category.create({ data: { name: "Verify Suggest Cat", kind: "EXPENSE" } });
    const suggestRow = (
      date: Date,
      amount: number,
      note: string,
      extra: Partial<{ accountId: string; currency: string; source: "MANUAL" | "CSV" | "RECURRING"; categoryId: string; type: "EXPENSE" | "INCOME"; isExtraordinary: boolean; externalId: string }> = {},
    ) => ({
      date,
      amount,
      currency: extra.currency ?? "USD",
      type: extra.type ?? ("EXPENSE" as const),
      accountId: extra.accountId ?? usdAccount.id,
      categoryId: extra.categoryId ?? null,
      note,
      source: extra.source ?? ("CSV" as const),
      externalId: extra.externalId,
      isExtraordinary: extra.isExtraordinary ?? false,
    });
    const gymDates = [
      civilDate(2026, 6, 1), civilDate(2026, 6, 16), civilDate(2026, 7, 1), civilDate(2026, 7, 16),
      civilDate(2026, 7, 31), civilDate(2026, 8, 14), civilDate(2026, 9, 1), civilDate(2026, 9, 16),
    ];
    const boxDates = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => civilDate(2026, 6, 5 + 14 * i));
    await prisma.transaction.createMany({
      data: [
        ...gymDates.map((date) => suggestRow(date, 25, "VERIFY GYM PLANET FITNESS 1234")),
        ...boxDates.map((date) => suggestRow(date, 12.5, "VERIFY BOX BLUE APRON")),
        ...[civilDate(2026, 7, 12), civilDate(2026, 8, 12), civilDate(2026, 9, 12)].map((date) =>
          suggestRow(date, 9.99, "VERIFY STREAM NETFLIX.COM 866-579-7172", { source: "MANUAL", categoryId: suggestCategory.id }),
        ),
        ...[civilDate(2026, 7, 3), civilDate(2026, 8, 3), civilDate(2026, 9, 3)].map((date) =>
          suggestRow(date, 1500, "VERIFY PHONE CLARO", { accountId: dopAccount.id, currency: "DOP" }),
        ),
        // Noise that must not count: a posted occurrence, a confirmed
        // one-off, income at the same merchant, and a merchant seen twice.
        suggestRow(civilDate(2026, 9, 10), 25, "VERIFY GYM PLANET FITNESS 1234", { source: "RECURRING", externalId: "verify-suggest-item:2026-09-10" }),
        suggestRow(civilDate(2026, 9, 12), 12.5, "VERIFY BOX BLUE APRON", { isExtraordinary: true }),
        suggestRow(civilDate(2026, 9, 13), 25, "VERIFY GYM PLANET FITNESS 1234", { type: "INCOME" }),
        suggestRow(civilDate(2026, 8, 20), 5.99, "VERIFY TWICE SPOTIFY"),
        suggestRow(civilDate(2026, 9, 20), 5.99, "VERIFY TWICE SPOTIFY"),
      ],
    });
    const seededCount = await prisma.transaction.count({ where: { accountId: { in: [usdAccount.id, dopAccount.id] } } });

    const suggestions = await findRecurringSuggestions(suggestContext);
    const mine = suggestions.filter((row) => row.merchantKey.startsWith("VERIFY "));
    eq(
      "the four patterns are suggested, most charges first then by name; Spotify's two charges are not",
      mine.map((row) => `${row.name}:${row.cadence}:${row.occurrences.length}`).join("|"),
      "Verify Box Blue Apron:BIWEEKLY:8|Verify Gym Planet Fitness:SEMI_MONTHLY:8|Verify Phone Claro:MONTHLY:3|Verify Stream Netflix Com:MONTHLY:3",
    );
    const gymSuggestion = mine.find((row) => row.merchantKey === "VERIFY GYM PLANET FITNESS");
    const boxSuggestion = mine.find((row) => row.merchantKey === "VERIFY BOX BLUE APRON");
    const netflixSuggestion = mine.find((row) => row.merchantKey === "VERIFY STREAM NETFLIX COM");
    const claroSuggestion = mine.find((row) => row.merchantKey === "VERIFY PHONE CLARO");
    eq("the posted occurrence and the income row at the gym were not evidence", gymSuggestion?.occurrences.length, 8);
    eq("the gym is anchored on the 1st and 16th, next due Oct 1 and Oct 16", `${gymSuggestion?.anchorDays.join(",")} ${gymSuggestion?.nextDates.map(toISODate).join(",")}`, "1,16 2026-10-01,2026-10-16");
    eq("the one-off at the box was not evidence", boxSuggestion?.occurrences.length, 8);
    eq("each suggestion names its account", `${gymSuggestion?.accountName}/${claroSuggestion?.accountName}`, "Verify Suggest USD/Verify Suggest DOP");
    eq("... and its category when the charges have one", `${netflixSuggestion?.categoryName}/${gymSuggestion?.categoryName}`, "Verify Suggest Cat/null");
    eq("... and converts the amount to the display currency (1,500 DOP at 60 = 25 USD)", `${claroSuggestion?.amount} ${claroSuggestion?.currency} = ${claroSuggestion?.displayAmount}`, "1500 DOP = 25");
    eq("finding suggestions wrote nothing", await prisma.transaction.count({ where: { accountId: { in: [usdAccount.id, dopAccount.id] } } }), seededCount);
    eq("... and created no recurring item", await prisma.recurringItem.count({ where: { name: { startsWith: "Verify Suggest" } } }), 0);

    console.log("-- accepting creates the real item(s) through the shared creation path --");
    const acceptedNetflix = await acceptRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY STREAM NETFLIX COM" }, suggestContext);
    check("accepting the monthly one succeeds", acceptedNetflix.ok, JSON.stringify(acceptedNetflix));
    const netflixItems = await prisma.recurringItem.findMany({ where: { name: { startsWith: "Verify Stream Netflix" } } });
    eq("... creating exactly one RecurringItem", netflixItems.length, 1);
    const netflixItem = netflixItems[0];
    eq("... named after the merchant", netflixItem?.name, "Verify Stream Netflix Com");
    eq("... as an active monthly subscription at the last charged amount", `${netflixItem?.kind}/${netflixItem?.frequency}/${num(netflixItem!.amount)} ${netflixItem?.currency}/${netflixItem?.active}`, "SUBSCRIPTION/MONTHLY/9.99 USD/true");
    eq("... due next on Oct 12 and anchored on the 12th", `${toISODate(netflixItem!.nextDate)}/${netflixItem?.anchorDay}`, "2026-10-12/12");
    eq("... charged to the charges' account and filed under their category", `${netflixItem?.accountId === usdAccount.id}/${netflixItem?.categoryId === suggestCategory.id}`, "true/true");
    eq("... open-ended, not from Afford, and marked as detected from manual entries", `${netflixItem?.remainingOccurrences}/${netflixItem?.fromAfford}/${netflixItem?.detectedFrom}`, "null/false/MANUAL");
    eq("... with the latest raw description as its note", netflixItem?.note, "VERIFY STREAM NETFLIX.COM 866-579-7172");
    check("the item is now what tracks the pattern, so it is no longer suggested", !(await findRecurringSuggestions(suggestContext)).some((row) => row.merchantKey === "VERIFY STREAM NETFLIX COM"));
    const acceptedTwice = await acceptRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY STREAM NETFLIX COM" }, suggestContext);
    eq("accepting it again finds nothing to accept, and creates nothing", `${JSON.stringify(acceptedTwice)}/${await prisma.recurringItem.count({ where: { name: { startsWith: "Verify Stream Netflix" } } })}`, '{"ok":false,"reason":"not_found"}/1');

    const acceptedGym = await acceptRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY GYM PLANET FITNESS" }, suggestContext);
    check("accepting the semi-monthly one succeeds", acceptedGym.ok, JSON.stringify(acceptedGym));
    const gymItems = await prisma.recurringItem.findMany({ where: { name: { startsWith: "Verify Gym Planet Fitness" } } });
    eq("... as one real SEMI_MONTHLY item, not two MONTHLY ones", gymItems.length, 1);
    const gymItem = gymItems[0];
    eq("... named after the merchant, with no per-day suffix", gymItem?.name, "Verify Gym Planet Fitness");
    eq("... anchored on both due days", `${gymItem?.anchorDay}/${gymItem?.secondAnchorDay}`, "1/16");
    eq(
      // The candidate's two next-dates are Oct 1 and Oct 16 in that order
      // here, so the earlier one (Oct 1) is exactly recurringItemForCandidate's
      // usual, non-flipped case.
      "... due next on the earlier of its two upcoming occurrences (Oct 1)",
      toISODate(gymItem!.nextDate),
      "2026-10-01",
    );
    eq("... at the charged amount, on the charges' account, detected from CSV", `${num(gymItem!.amount)}/${gymItem?.accountId === usdAccount.id}/${gymItem?.detectedFrom}`, "25/true/CSV");
    // Nov 1 2026 is a Sunday, so that occurrence's real date shifts back to
    // Oct 30 (Friday) - exactly the weekend rule this walk exists to apply.
    eq("... and owedOccurrences now walks it correctly, alternating both anchors with the real weekend shifts", owedOccurrences(gymItem!, civilDate(2026, 10, 1), civilDate(2026, 11, 1)).map(toISODate).join(","), "2026-10-01,2026-10-16,2026-10-30");
    check("the gym is no longer suggested either", !(await findRecurringSuggestions(suggestContext)).some((row) => row.merchantKey === "VERIFY GYM PLANET FITNESS"));
    eq("nothing was posted by accepting: the next date is in the future", await prisma.transaction.count({ where: { source: "RECURRING", externalId: { startsWith: `${gymItem!.id}:` } } }), 0);

    console.log("-- recurringItemForCandidate: nextDate is the chronologically sooner anchor, not always index 0 (pure) --");
    {
      const baseCandidate = {
        accountId: "acc_1",
        merchantKey: "VERIFY PURE GYM",
        name: "Verify Pure Gym",
        amount: 40,
        currency: "USD",
        cadence: "SEMI_MONTHLY" as const,
        categoryId: null,
        detectedFrom: "CSV" as const,
        sampleNote: "VERIFY PURE GYM",
        occurrences: [],
      };
      // Detection reports one next-date per anchor, in anchorDays' own
      // (smaller-day-first) order - here [anchor 1's next: Nov 1, anchor
      // 16's next: Oct 16], which is *not* chronological order.
      const flipped = recurringItemForCandidate({
        ...baseCandidate,
        anchorDays: [1, 16],
        nextDates: [civilDate(2026, 11, 1), civilDate(2026, 10, 16)],
      });
      eq("the earlier of the two (Oct 16) is picked, not nextDates[0] blindly", toISODate(flipped.nextDate as Date), "2026-10-16");
      eq("anchorDay/secondAnchorDay still come from anchorDays directly, unaffected by the flip", `${flipped.anchorDay}/${flipped.secondAnchorDay}`, "1/16");
      const ordinary = recurringItemForCandidate({
        ...baseCandidate,
        anchorDays: [1, 16],
        nextDates: [civilDate(2026, 10, 1), civilDate(2026, 10, 16)],
      });
      eq("the ordinary (already-sorted) case is unaffected", toISODate(ordinary.nextDate as Date), "2026-10-01");
      const monthly = recurringItemForCandidate({ ...baseCandidate, cadence: "MONTHLY", anchorDays: [12], nextDates: [civilDate(2026, 10, 12)] });
      eq("a single-date cadence is unaffected", `${toISODate(monthly.nextDate as Date)}/${monthly.secondAnchorDay}`, "2026-10-12/null");
    }

    console.log("-- dismissing is permanent --");
    await dismissRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY BOX BLUE APRON" });
    check("a dismissed pattern is gone from the suggestions", !(await findRecurringSuggestions(suggestContext)).some((row) => row.merchantKey === "VERIFY BOX BLUE APRON"));
    await prisma.transaction.createMany({
      data: [civilDate(2026, 9, 25), civilDate(2026, 10, 9)].map((date) => suggestRow(date, 12.5, "VERIFY BOX BLUE APRON")),
    });
    check("... and stays gone as more matching charges arrive", !(await findRecurringSuggestions(suggestContext)).some((row) => row.merchantKey === "VERIFY BOX BLUE APRON"));
    await dismissRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY BOX BLUE APRON" });
    eq("dismissing twice keeps one row", await prisma.recurringSuggestionDismissal.count({ where: { accountId: usdAccount.id } }), 1);
    eq("accepting a dismissed pattern finds nothing", JSON.stringify(await acceptRecurringSuggestion({ accountId: usdAccount.id, merchantKey: "VERIFY BOX BLUE APRON" }, suggestContext)), '{"ok":false,"reason":"not_found"}');
    eq("the other account's dismissals are untouched", await prisma.recurringSuggestionDismissal.count({ where: { accountId: dopAccount.id } }), 0);

    console.log("-- an archived account's charges are left alone --");
    await prisma.account.update({ where: { id: dopAccount.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    check("a pattern on an archived account is not suggested (the item could not post)", !(await findRecurringSuggestions(suggestContext)).some((row) => row.merchantKey === "VERIFY PHONE CLARO"));
    eq("... and cannot be accepted", JSON.stringify(await acceptRecurringSuggestion({ accountId: dopAccount.id, merchantKey: "VERIFY PHONE CLARO" }, suggestContext)), '{"ok":false,"reason":"not_found"}');

    await prisma.recurringItem.deleteMany({ where: { OR: [{ name: { startsWith: "Verify Stream Netflix" } }, { name: { startsWith: "Verify Gym Planet Fitness" } }] } });
    await prisma.transaction.deleteMany({ where: { accountId: { in: [usdAccount.id, dopAccount.id] } } });
    await prisma.account.deleteMany({ where: { id: { in: [usdAccount.id, dopAccount.id] } } });
    eq("deleting the account removes its dismissals with it", await prisma.recurringSuggestionDismissal.count({ where: { accountId: usdAccount.id } }), 0);
    await prisma.category.delete({ where: { id: suggestCategory.id } });
    console.log("  ok   recurring suggestion fixtures removed");
  }

  console.log("\n== insight engine (pure) ==");
  {
    const insights = await import("../src/lib/insights");
    const { getDictionary } = await import("../src/lib/i18n");
    const { insightRefSchema } = await import("../src/lib/validation");
    const en = getDictionary("en");
    const emptyContext: import("../src/lib/insights").InsightContext = {
      dictionary: en,
      displayCurrency: "USD",
      recurringPosting: null,
      affordRechecks: [],
      recurringSuggestions: [],
      goalRoadmaps: [],
      goalForecasts: [],
    };
    eq("the registry holds one detector per source, in source order", insights.INSIGHT_DETECTORS.length, insights.INSIGHT_SOURCES.length);
    eq("nothing to notice is an empty list, not an error", insights.detectInsights(emptyContext).length, 0);
    eq("an insight's id is its source and key", insights.insightId({ source: "goal_behind", key: "g1" }), "goal_behind:g1");
    eq("a registered source is recognised; anything else is not", `${insights.isInsightSource("not_posting")}:${insights.isInsightSource("weather")}`, "true:false");
    eq("the dismiss form's schema takes a registered source and a key only", JSON.stringify(insightRefSchema.safeParse({ source: "afford_viability", key: " item_1 " }).data), '{"source":"afford_viability","key":"item_1"}');
    eq("... and refuses an unregistered source", insightRefSchema.safeParse({ source: "weather", key: "x" }).success, false);

    console.log("-- not posting: this request's posting run, skipped and failed --");
    const posting: import("../src/lib/recurring-posting").RecurringPostingSummary = {
      today: "2026-09-17", itemsDue: 3, itemsPosted: 1, transactionsCreated: 1, goalContributionsCreated: 0, itemsSkipped: 1,
      skipped: [{ id: "item_gym", name: "Gym", kind: "SUBSCRIPTION", nextDate: "2026-09-05", reason: "missing_account" }],
      occurrencesAlreadyLogged: 0, occurrencesAlreadyPosted: 0, itemsCapped: 0, itemsFailed: 1,
      failed: [{ id: "item_fund", name: "Fund", error: "boom" }],
      itemsCompleted: 0,
    };
    const notPosting = insights.detectNotPosting({ ...emptyContext, recurringPosting: posting });
    eq("one insight per skipped or failed item, keyed by the item's id", notPosting.map((i) => i.id).join(","), "not_posting:item_gym,not_posting:item_fund");
    eq("both are critical: money the plan counts on is not moving", notPosting.map((i) => i.severity).join(","), "critical,critical");
    eq("the title names the item", notPosting[0].title, "Gym is not posting");
    eq("the evidence carries the reason (the Dashboard alert's own words) and the still-due date as a date", JSON.stringify(notPosting[0].evidence.slice(0, 2)), JSON.stringify([{ kind: "text", label: "Why", value: "no account set" }, { kind: "date", label: "Still due", date: "2026-09-05" }]));
    eq("a failed item carries its error", notPosting[1].evidence[0].kind === "text" ? notPosting[1].evidence[0].value : "?", "last run failed: boom");
    eq("both point at the Recurring page and can be dismissed", `${notPosting[0].actionHref}:${notPosting[0].dismissible}`, "/recurring:true");
    eq("a context with no posting run (a hand-built one) yields none", insights.detectNotPosting(emptyContext).length, 0);

    console.log("-- afford viability: the tracker's verdicts --");
    const affordLib = await import("../src/lib/afford");
    const projectionFor = (key: string, account: { income: number; committed: number; buffer: number }, flexible: { income: number; committed: number; buffer: number }) => {
      const info = periodInfo({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), period: key.slice(8) as "A" | "B" });
      return [key, {
        period: info,
        account: { accountId: "acc", name: "Checking", currency: "USD", income: account.income, committed: account.committed, buffer: account.buffer, basis: "average" as const, estimatedGoalFunding: 0 },
        flexible: { currency: "USD", income: flexible.income, committed: flexible.committed, buffer: flexible.buffer, estimatedGoalFunding: 0 },
        estimatedGoals: [] as import("../src/lib/afford").EstimatedGoalFunding[],
        goalPlans: [] as import("../src/lib/afford").ProjectedGoalPlan[],
        historyPeriods: 6,
      }] as const;
    };
    const octFirst = civilDate(2026, 10, 1);
    const shortVerdict = affordLib.evaluateAffordability({
      installments: affordLib.buildInstallments([octFirst], 500),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 850, buffer: 100 }, { income: 5000, committed: 1000, buffer: 500 })]),
      rates,
    });
    const fineVerdict = affordLib.evaluateAffordability({
      installments: affordLib.buildInstallments([octFirst], 100),
      currency: "USD",
      projections: new Map([projectionFor("2026-10-A", { income: 1000, committed: 150, buffer: 100 }, { income: 1000, committed: 150, buffer: 100 })]),
      rates,
    });
    const afford = insights.detectAffordViability({
      ...emptyContext,
      affordRechecks: [
        { itemId: "plan_laptop", name: "Laptop", verdict: shortVerdict },
        { itemId: "plan_phone", name: "Phone", verdict: fineVerdict },
      ],
    });
    eq("only the plan that no longer fits becomes an insight, keyed by the item", afford.map((i) => i.id).join(","), "afford_viability:plan_laptop");
    eq("critical, titled after the plan, linking to the From Afford section", `${afford[0].severity}|${afford[0].title}|${afford[0].actionHref}`, "critical|Laptop from Afford no longer fits|/recurring#from-afford");
    eq("the evidence leads with the badge's own shortfall and period", JSON.stringify(afford[0].evidence.slice(0, 2)), JSON.stringify([{ kind: "money", label: "Short by", amount: 450, currency: "USD" }, { kind: "text", label: "In", value: "Oct 1-15" }]));
    eq("... then the installment and the room it leaves, and which check failed", afford[0].evidence.slice(2).map((e) => (e.kind === "money" ? `${e.label}=${e.amount}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";"), "Installment due there=500;Room left after it=-450;Check that fails=Checking would end the period below its buffer");

    console.log("-- looks recurring: the detector's suggestions --");
    const suggestion: import("../src/lib/recurring-detection").RecurringSuggestion = {
      accountId: "acc_1", merchantKey: "NETFLIX COM", name: "Netflix Com", amount: 15.99, currency: "USD", cadence: "MONTHLY", anchorDays: [12],
      nextDates: [civilDate(2026, 10, 12)], categoryId: null, detectedFrom: "CSV", sampleNote: "NETFLIX.COM",
      occurrences: [7, 8, 9].map((m) => ({ id: `t${m}`, date: civilDate(2026, m, 12), amount: 15.99, note: "NETFLIX.COM" })),
      accountName: "Main Checking", categoryName: null, displayAmount: 15.99,
    };
    const suggested = insights.detectRecurringSuggestions({ ...emptyContext, recurringSuggestions: [suggestion] });
    eq("keyed by account + merchant, the same identity the Recurring page's Dismiss uses", suggested[0].id, "recurring_suggestion:acc_1:NETFLIX COM");
    eq("advisory: nothing is added until the user says so", `${suggested[0].severity}|${suggested[0].title}|${suggested[0].actionHref}`, "advisory|Netflix Com looks recurring|/recurring");
    eq("the evidence is the last amount, the cadence in the card's words, the charge span, the account and the next date", suggested[0].evidence.map((e) => (e.kind === "money" ? `${e.label}=${e.amount} ${e.currency}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";"), "Last charged=15.99 USD;Cadence=Monthly, around the 12th;Charges=3, Jul 12, 2026 to Sep 12, 2026;Account=Main Checking;Next expected=2026-10-12");

    console.log("-- goal behind: the goal page's roadmap status --");
    const sepB = periodInfo({ year: 2026, month: 9, period: "B" });
    const goalStatus = (over: Partial<import("../src/lib/data/payday").GoalRoadmapStatus>): import("../src/lib/data/payday").GoalRoadmapStatus => ({
      goalId: "goal_1", name: "Emergency Fund", targetDate: civilDate(2027, 3, 31), period: sepB, roadmapAmount: 307.69, planned: { plannedAmount: 100, recommendedAmount: 100 }, ...over,
    });
    const behind = insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({})] });
    eq("a dated goal planned under its roadmap is an advisory insight keyed by the goal", `${behind[0].id}|${behind[0].severity}|${behind[0].title}|${behind[0].actionHref}`, "goal_behind:goal_1|advisory|Emergency Fund is behind its roadmap|/goals/goal_1");
    eq("behind by exactly the page's figure, beside the roadmap, the plan, the period and the target date", behind[0].evidence.map((e) => (e.kind === "money" ? `${e.label}=${e.amount}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";"), "Behind by=207.69;Roadmap this period=307.69;Planned this period=100;Period=Sep 16-30;Target date=2027-03-31;Room couldn't cover=207.69");
    eq("the room shortfall is left out when the accounts could have covered the pace", insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({ planned: { plannedAmount: 100, recommendedAmount: 400 } })] })[0].evidence.length, 5);
    eq("a plan on the roadmap (or ahead) is nothing to notice", insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({ planned: { plannedAmount: 307.69, recommendedAmount: 307.69 } }), goalStatus({ goalId: "g2", planned: { plannedAmount: 400, recommendedAmount: 400 } })] }).length, 0);
    eq("a difference within half a cent is on the roadmap - the page's own tolerance", insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({ planned: { plannedAmount: 307.686, recommendedAmount: 307.686 } })] }).length, 0);
    eq("an undated goal has no roadmap to be behind", insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({ targetDate: null })] }).length, 0);
    eq("a goal with no confirmed plan this period, or no pace, is not behind anything", insights.detectGoalsBehind({ ...emptyContext, goalRoadmaps: [goalStatus({ planned: null }), goalStatus({ goalId: "g3", roadmapAmount: null })] }).length, 0);

    console.log("-- goal forecast risk: Afford's projection walked to the target date --");
    const forecastLib = await import("../src/lib/goal-forecast");
    const roomDraw = (headroom: number, recommendedAmount: number): import("../src/lib/payday").GoalFundingDraw => ({ accountId: "acc", name: "Checking", currency: "USD", headroom, share: 1, recommendedAmount });
    const forecastPeriod = (key: string, over: Partial<import("../src/lib/goal-forecast").GoalForecastPeriod> = {}): import("../src/lib/goal-forecast").GoalForecastPeriod => ({
      period: periodInfo({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), period: key.slice(8) as "A" | "B" }),
      pace: 307.69, recommended: 307.69, shortfall: 0, draws: [roomDraw(1500, 307.69)], ...over,
    });
    const forecast = (over: Partial<import("../src/lib/goal-forecast").GoalForecast> = {}): import("../src/lib/goal-forecast").GoalForecast => ({
      goalId: "goal_1", name: "Emergency Fund", targetDate: civilDate(2027, 3, 31), currency: "USD",
      periods: [
        forecastPeriod("2026-10-A"),
        forecastPeriod("2026-10-B"),
        forecastPeriod("2026-11-A", { recommended: 100, shortfall: 207.69, draws: [roomDraw(100, 100)] }),
        forecastPeriod("2026-11-B", { recommended: 0, shortfall: 307.69, draws: [] }),
      ],
      ...over,
    });
    const shortSummary = forecastLib.summarizeGoalForecast(forecast());
    eq("the summary names the first period the room falls short in, with its figures", shortSummary.status === "short" ? `${shortSummary.period.period.key}:${shortSummary.period.recommended}:${shortSummary.period.shortfall}` : "on_track", "2026-11-A:100:207.69");
    eq("a goal whose every projected period covers its pace is on track", forecastLib.summarizeGoalForecast(forecast({ periods: [forecastPeriod("2026-10-A"), forecastPeriod("2026-10-B")] })).status, "on_track");
    eq("... as is one with no projected period at all (every period to its target already confirmed)", forecastLib.summarizeGoalForecast(forecast({ periods: [] })).status, "on_track");
    eq("a shortfall within half a cent is covered - the same tolerance as the goal page", forecastLib.summarizeGoalForecast(forecast({ periods: [forecastPeriod("2026-10-A", { recommended: 307.686, shortfall: 0.004 })] })).status, "on_track");
    const atRisk = insights.detectGoalForecastRisk({ ...emptyContext, goalForecasts: [forecast()] });
    eq("a goal short in a projected period is an advisory insight keyed by the goal, linking to it", `${atRisk[0].id}|${atRisk[0].severity}|${atRisk[0].title}|${atRisk[0].actionHref}|${atRisk[0].dismissible}`, "goal_forecast_risk:goal_1|advisory|Emergency Fund is at risk before its target date|/goals/goal_1|true");
    eq("the evidence leads with the shortfall and the first short period, then the pace, what the room could give, the account with room and the target date", atRisk[0].evidence.map((e) => (e.kind === "money" ? `${e.label}=${e.amount} ${e.currency}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";"), "Short by=207.69 USD;In=Nov 1-15;Roadmap pace=307.69 USD;Room could give=100 USD;Room on Checking=100 USD;Target date=2027-03-31");
    eq("when no account has any room in that period, the evidence says so instead of listing accounts", insights.detectGoalForecastRisk({ ...emptyContext, goalForecasts: [forecast({ periods: [forecastPeriod("2026-11-B", { recommended: 0, shortfall: 307.69, draws: [] })] })] })[0].evidence.map((e) => (e.kind === "money" ? `${e.label}=${e.amount}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";"), "Short by=307.69;In=Nov 16-30;Roadmap pace=307.69;Room could give=0;Accounts with room=none;Target date=2027-03-31");
    eq("an account the earlier goals used up (room 0) is not listed as having room", insights.detectGoalForecastRisk({ ...emptyContext, goalForecasts: [forecast({ periods: [forecastPeriod("2026-11-A", { recommended: 50, shortfall: 257.69, draws: [roomDraw(0, 0), { ...roomDraw(50, 50), accountId: "acc2", name: "Savings" }] })] })] })[0].evidence.filter((e) => e.label.startsWith("Room on")).map((e) => e.label).join(","), "Room on Savings");
    eq("a goal with room the whole way is nothing to notice, and one insight per goal at most", insights.detectGoalForecastRisk({ ...emptyContext, goalForecasts: [forecast({ periods: [forecastPeriod("2026-10-A")] }), forecast({ goalId: "goal_2" }), forecast({ goalId: "goal_3", periods: [] })] }).map((i) => i.id).join(","), "goal_forecast_risk:goal_2");

    console.log("-- the one central function: every detector, critical first --");
    const all = insights.detectInsights({
      ...emptyContext,
      recurringPosting: posting,
      affordRechecks: [{ itemId: "plan_laptop", name: "Laptop", verdict: shortVerdict }],
      recurringSuggestions: [suggestion],
      goalRoadmaps: [goalStatus({})],
      goalForecasts: [forecast()],
    });
    eq("all five sources appear", [...new Set(all.map((i) => i.source))].sort().join(","), "afford_viability,goal_behind,goal_forecast_risk,not_posting,recurring_suggestion");
    eq("critical insights lead, then advisory; registry order and each detector's own order within", all.map((i) => i.id).join(","), "not_posting:item_gym,not_posting:item_fund,afford_viability:plan_laptop,recurring_suggestion:acc_1:NETFLIX COM,goal_behind:goal_1,goal_forecast_risk:goal_1");
    eq("every id is unique across sources", new Set(all.map((i) => i.id)).size, all.length);
    const kept = insights.withoutDismissed(all, [{ source: "not_posting", key: "item_gym" }, { source: "goal_behind", key: "goal_1" }]);
    eq("a dismissal removes exactly the insight with that source and key - the same goal's forecast insight, under its own source, stays", kept.map((i) => i.id).join(","), "not_posting:item_fund,afford_viability:plan_laptop,recurring_suggestion:acc_1:NETFLIX COM,goal_forecast_risk:goal_1");
    eq("a dismissal for a key under another source does not match", insights.withoutDismissed(all, [{ source: "afford_viability", key: "item_gym" }]).length, all.length);
    const es = insights.detectInsights({ ...emptyContext, dictionary: getDictionary("es"), recurringPosting: posting, goalRoadmaps: [goalStatus({})], goalForecasts: [forecast()] });
    eq("titles and labels follow the dictionary", `${es[0].title}|${es[2].evidence[0].label}|${es[3].title}|${es[3].evidence[0].label}`, "Gym no se está registrando|Por detrás|Emergency Fund corre riesgo antes de su fecha objetivo|Faltan");
  }

  console.log("\n== insight engine (database) ==");
  {
    const { collectInsights, dismissInsight, listInsightDismissals, loadInsightContext } = await import("../src/lib/data/insights");
    const { getGoalRoadmapStatuses, getGoalRoadmapAmount: roadmapForInsights, planPeriodRef: planRefForInsights } = await import("../src/lib/data/payday");
    const { postDueRecurringItems: postForInsights } = await import("../src/lib/recurring-posting");
    const tracking = await import("../src/lib/afford-tracking");
    const insightToday = civilDate(2026, 9, 17);
    const insightPlanRef = planRefForInsights({ displayCurrency: "USD", language: "en", rates, today: insightToday, currentPeriod: periodForDate(insightToday) });
    eq("the fixtures plan for Sep 16-30 (today is before that period's payday)", periodKey(insightPlanRef), "2026-09-B");
    eq("no confirmed check-in for the plan period is left over from earlier sections", await prisma.paydayCheckin.count({ where: { year: 2026, month: 9, period: "B" } }), 0);

    const insightAccount = await prisma.account.create({ data: { name: "Verify Insight Account", currency: "USD", type: "CHECKING" } });
    const insightCategory = await prisma.category.create({ data: { name: "Verify Insight Cat", kind: "EXPENSE" } });
    // Income on every A payday from March to September, so Afford projects
    // 1,000 for Oct 1-15 on this account (comparableHistory walks A periods).
    await prisma.transaction.createMany({
      data: [3, 4, 5, 6, 7, 8, 9].map((m) => ({ date: civilDate(2026, m, 2), amount: 1000, currency: "USD", type: "INCOME" as const, accountId: insightAccount.id, note: "Verify Insight Salary", source: "MANUAL" as const })),
    });
    // 1. Not posting: due on the 5th, no account to post from.
    const gymItem = await prisma.recurringItem.create({ data: { name: "Verify Insight Gym", amount: 45, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 9, 5), anchorDay: 5, accountId: null } });
    // 2. Afford: rent takes Oct 1-15's room (1,000 in, 850 owed, 100 kept
    // back), so the laptop's 400 installment there fails the account check.
    await prisma.recurringItem.create({ data: { name: "Verify Insight Rent", amount: 850, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 1), anchorDay: 1, accountId: insightAccount.id } });
    const laptopItem = await prisma.recurringItem.create({ data: { name: "Verify Insight Laptop", amount: 400, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 10, 1), anchorDay: 1, accountId: insightAccount.id, remainingOccurrences: 3, fromAfford: true } });
    // 3. Looks recurring: three monthly charges from a CSV import.
    await prisma.transaction.createMany({
      data: [7, 8, 9].map((m) => ({ date: civilDate(2026, m, 12), amount: 15.99, currency: "USD", type: "EXPENSE" as const, accountId: insightAccount.id, categoryId: insightCategory.id, note: "VERIFY INSIGHT NETFLIX.COM", source: "CSV" as const })),
    });
    // 4. Goal behind: 4,000 still to go by March 2027, 100 planned this period.
    const insightGoal = await prisma.goal.create({ data: { name: "Verify Insight Goal", targetAmount: 5000, currency: "USD", targetDate: civilDate(2027, 3, 31), savedAmount: 1000 } });
    const insightCheckin = await prisma.paydayCheckin.create({
      data: {
        year: 2026, month: 9, period: "B", checkinDate: civilDate(2026, 9, 16), currency: "USD", totalIncome: 1000, protectedBuffer: 100, status: "CONFIRMED",
        allocations: { create: [{ type: "GOAL", goalId: insightGoal.id, accountId: insightAccount.id, recommendedAmount: 100, plannedAmount: 100, currency: "USD" }] },
      },
    });

    // The request path's context: this run's posting summary rides along
    // exactly as getAppContext() attaches it, and the buffer settings the
    // Afford re-check needs are the ones every other section uses.
    const postingRun = await postForInsights(insightToday);
    const insightContext = {
      displayCurrency: "USD" as const, language: "en" as const, rates, today: insightToday, currentPeriod: periodForDate(insightToday),
      recurringPosting: postingRun, bufferPercent: 10, bufferFloorAmount: 2000, bufferFloorCurrency: "DOP",
    };
    eq("the posting run skipped the account-less item", postingRun.skipped.map((i) => `${i.name}:${i.reason}`).join(","), "Verify Insight Gym:missing_account");

    console.log("-- the goal page's status, shared with the detector --");
    const statuses = await getGoalRoadmapStatuses(insightContext);
    const goalStatus = statuses.find((s) => s.goalId === insightGoal.id);
    const liveRoadmap = await roadmapForInsights(insightGoal.id, insightPlanRef, insightContext);
    eq("the status carries the live roadmap figure the goal page measures against", goalStatus?.roadmapAmount, liveRoadmap);
    eq("... which is the remaining 4,000 over the 13 periods to March 31", liveRoadmap, 307.69);
    eq("and the confirmed plan's GOAL rows summed: planned and recommended", `${goalStatus?.planned?.plannedAmount}:${goalStatus?.planned?.recommendedAmount}`, "100:100");
    eq("the plan period and the goal's own details ride along", `${goalStatus?.period.key}:${goalStatus?.name}:${goalStatus?.targetDate ? toISODate(goalStatus.targetDate) : null}`, "2026-09-B:Verify Insight Goal:2027-03-31");
    eq("a goal with a pace but no confirmed plan rows has planned = null", statuses.filter((s) => s.goalId !== insightGoal.id).every((s) => s.planned === null), true);

    console.log("-- every source at once, through the same inputs the pages use --");
    const loaded = await loadInsightContext(insightContext);
    eq("the loaded context holds this run's posting summary, the tracker's verdicts, the suggestions and the goal statuses", `${loaded.recurringPosting === postingRun}:${loaded.affordRechecks.some((t) => t.itemId === laptopItem.id)}:${loaded.recurringSuggestions.some((s) => s.merchantKey === "VERIFY INSIGHT NETFLIX COM")}:${loaded.goalRoadmaps.some((s) => s.goalId === insightGoal.id)}`, "true:true:true:true");
    const collected = await collectInsights(insightContext);
    const mine = collected.filter((i) => i.title.startsWith("Verify Insight"));
    // The goal also trips the forecast detector: its account has no room
    // above its buffer in Oct 1-15 (rent and the laptop take all of it), so
    // nothing can be put toward the goal there - the goal forecast section
    // below works that signal through on its own fixtures.
    eq("all four fixtures surface as insights - the goal twice, once per goal signal", mine.map((i) => i.source).sort().join(","), "afford_viability,goal_behind,goal_forecast_risk,not_posting,recurring_suggestion");
    eq("critical first, advisory after - the order the Inbox lists them in", collected.map((i) => i.severity).join(",").replace(/(critical,)+/, "C").replace(/(advisory,?)+/, "A"), "CA");
    const gymInsight = mine.find((i) => i.source === "not_posting");
    const laptopInsight = mine.find((i) => i.source === "afford_viability");
    const netflixInsight = mine.find((i) => i.source === "recurring_suggestion");
    const goalInsight = mine.find((i) => i.source === "goal_behind");
    eq("not posting: keyed by the item, with the reason and the still-due date", `${gymInsight?.key === gymItem.id}:${gymInsight?.evidence.map((e) => (e.kind === "text" ? e.value : e.kind === "date" ? e.date : e.amount)).slice(0, 2).join("|")}`, "true:no account set|2026-09-05");
    eq("afford: keyed by the plan, short in Oct 1-15 on the account check", `${laptopInsight?.key === laptopItem.id}:${laptopInsight?.evidence[1].kind === "text" ? laptopInsight.evidence[1].value : "?"}:${laptopInsight?.evidence[4].kind === "text" ? laptopInsight.evidence[4].value : "?"}`, "true:Oct 1-15:Verify Insight Account would end the period below its buffer");
    eq("... by the amount the tracker's own badge reports", laptopInsight?.evidence[0].kind === "money" ? laptopInsight.evidence[0].amount : -1, (() => { const t = loaded.affordRechecks.find((r) => r.itemId === laptopItem.id)!; const s = tracking.summarizeAffordViability(t.verdict); return s.status === "short" ? s.shortfall : -1; })());
    eq("looks recurring: keyed by account + merchant key, three charges", `${netflixInsight?.key}:${netflixInsight?.evidence[2].kind === "text" ? netflixInsight.evidence[2].value : "?"}`, `${insightAccount.id}:VERIFY INSIGHT NETFLIX COM:3, Jul 12, 2026 to Sep 12, 2026`);
    eq("goal: keyed by the goal, behind by the page's own figure", `${goalInsight?.key === insightGoal.id}:${goalInsight?.evidence[0].kind === "money" ? goalInsight.evidence[0].amount : -1}`, "true:207.69");
    eq("every insight links somewhere", collected.every((i) => i.actionHref.startsWith("/")), true);

    console.log("-- dismissing: permanent, idempotent, one row per insight --");
    const dismissalsBefore = (await listInsightDismissals()).length;
    await dismissInsight({ source: "recurring_suggestion", key: netflixInsight!.key });
    const afterOne = await collectInsights(insightContext);
    eq("a dismissed insight is gone from the list the badge counts", afterOne.some((i) => i.id === netflixInsight!.id), false);
    eq("... and only that one", afterOne.length, collected.length - 1);
    eq("the Recurring page's own suggestion is untouched - the signal is not changed, only the Inbox", (await loadInsightContext(insightContext)).recurringSuggestions.some((s) => s.merchantKey === "VERIFY INSIGHT NETFLIX COM"), true);
    await prisma.transaction.create({ data: { date: civilDate(2026, 10, 12), amount: 15.99, currency: "USD", type: "EXPENSE", accountId: insightAccount.id, categoryId: insightCategory.id, note: "VERIFY INSIGHT NETFLIX.COM", source: "CSV" } });
    eq("it stays gone as the condition persists", (await collectInsights(insightContext)).some((i) => i.id === netflixInsight!.id), false);
    await dismissInsight({ source: "recurring_suggestion", key: netflixInsight!.key });
    eq("dismissing twice keeps one row", (await listInsightDismissals()).length, dismissalsBefore + 1);
    await dismissInsight({ source: "afford_viability", key: gymItem.id });
    eq("a dismissal is keyed by source too: the gym item's key under another source leaves its not-posting insight in place", (await collectInsights(insightContext)).some((i) => i.id === gymInsight!.id), true);
    await dismissInsight({ source: "goal_behind", key: insightGoal.id });
    await dismissInsight({ source: "not_posting", key: gymItem.id });
    await dismissInsight({ source: "afford_viability", key: laptopItem.id });
    eq("dismissing the goal's behind-roadmap insight leaves its forecast insight - a different source under the same key", (await collectInsights(insightContext)).filter((i) => i.key === insightGoal.id).map((i) => i.source).join(","), "goal_forecast_risk");
    await dismissInsight({ source: "goal_forecast_risk", key: insightGoal.id });
    const afterAll = await collectInsights(insightContext);
    eq("with all five dismissed none of the fixtures remain, whatever else is in the database", afterAll.some((i) => i.title.startsWith("Verify Insight")), false);

    await prisma.insightDismissal.deleteMany({ where: { OR: [{ key: netflixInsight!.key }, { key: insightGoal.id }, { key: gymItem.id }, { key: laptopItem.id }] } });
    eq("the fixture dismissals are removed", (await listInsightDismissals()).length, dismissalsBefore);
    await prisma.paydayCheckin.delete({ where: { id: insightCheckin.id } });
    await prisma.goal.delete({ where: { id: insightGoal.id } });
    await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Insight" } } });
    await prisma.transaction.deleteMany({ where: { accountId: insightAccount.id } });
    await prisma.account.delete({ where: { id: insightAccount.id } });
    await prisma.category.delete({ where: { id: insightCategory.id } });
    console.log("  ok   insight fixtures removed");
  }

  console.log("\n== goal forecast risk (database) ==");
  {
    const { forecastGoalFunding } = await import("../src/lib/data/goal-forecast");
    const { summarizeGoalForecast } = await import("../src/lib/goal-forecast");
    const { collectInsights: collectForForecast, dismissInsight: dismissForForecast, listInsightDismissals: listForForecast } = await import("../src/lib/data/insights");
    const { getGoalRoadmapStatuses: statusesForForecast, planPeriodRef: planRefForForecast } = await import("../src/lib/data/payday");
    const affordForForecast = await import("../src/lib/data/afford");
    const forecastToday = civilDate(2026, 9, 17);
    // A 10% buffer under a 500 USD floor: the floor is what every account
    // keeps back here, so an account another section left behind with a
    // little income history has no room to lend the goal, and the figures
    // below are this section's own.
    const forecastContext = {
      displayCurrency: "USD" as const, language: "en" as const, rates, today: forecastToday, currentPeriod: periodForDate(forecastToday),
      recurringPosting: null, bufferPercent: 10, bufferFloorAmount: 500, bufferFloorCurrency: "USD",
    };
    eq("the fixtures plan for Sep 16-30", periodKey(planRefForForecast(forecastContext)), "2026-09-B");
    eq("no confirmed check-in for the plan period is left over from earlier sections", await prisma.paydayCheckin.count({ where: { year: 2026, month: 9, period: "B" } }), 0);

    // 2,000 on the 2nd and the 17th of every month from March, so every
    // projected period - A or B - averages 2,000 on this account and keeps
    // 500 of it back.
    const forecastAccount = await prisma.account.create({ data: { name: "Verify Forecast Account", currency: "USD", type: "CHECKING" } });
    await prisma.transaction.createMany({
      data: [3, 4, 5, 6, 7, 8, 9].flatMap((m) => [2, 17].map((d) => ({ date: civilDate(2026, m, d), amount: 2000, currency: "USD", type: "INCOME" as const, accountId: forecastAccount.id, note: "Verify Forecast Salary", source: "MANUAL" as const }))),
    });
    // 4,000 still to go by March 31, 2027: 307.69 a period over the 13
    // periods from Sep 16-30. Dated far back so the check-in's funding order
    // (oldest goal first) places it ahead of any goal another section leaves
    // behind - its room is then never spent on another goal first.
    const forecastGoal = await prisma.goal.create({
      data: { name: "Verify Forecast Goal", targetAmount: 5000, currency: "USD", targetDate: civilDate(2027, 3, 31), savedAmount: 1000, createdAt: civilDate(2000, 1, 1) },
    });
    // The plan period's confirmed check-in sets 310 aside for it: on the
    // roadmap, so the goal is not behind it.
    const forecastCheckin = await prisma.paydayCheckin.create({
      data: {
        year: 2026, month: 9, period: "B", checkinDate: civilDate(2026, 9, 16), currency: "USD", totalIncome: 2000, protectedBuffer: 500, status: "CONFIRMED",
        allocations: { create: [{ type: "GOAL", goalId: forecastGoal.id, accountId: forecastAccount.id, recommendedAmount: 310, plannedAmount: 310, currency: "USD" }] },
      },
    });
    // A 1,300 premium every December 1st. Dec 1-15 then keeps only 200 above
    // the buffer (2,000 in, 1,300 owed, 500 kept back) - less than the pace;
    // every other period keeps 1,500.
    const premium = await prisma.recurringItem.create({
      data: { name: "Verify Forecast Premium", amount: 1300, currency: "USD", frequency: "YEARLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 12, 1), anchorDay: 1, accountId: forecastAccount.id },
    });
    const activeForForecast = await prisma.account.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true, currency: true } });
    const evidenceOf = (insight: import("../src/lib/insights").Insight | undefined) =>
      insight?.evidence.map((e) => (e.kind === "money" ? `${e.label}=${e.amount} ${e.currency}` : e.kind === "date" ? `${e.label}=${e.date}` : `${e.label}=${e.value}`)).join(";");

    console.log("-- the walk: Afford's projection from the plan period to the target date --");
    const forecast = (await forecastGoalFunding(forecastContext)).find((f) => f.goalId === forecastGoal.id);
    check("the dated goal has a forecast", forecast !== undefined);
    eq("it carries the goal's name, target date and the display currency", `${forecast?.name}:${forecast?.targetDate ? toISODate(forecast.targetDate) : null}:${forecast?.currency}`, "Verify Forecast Goal:2027-03-31:USD");
    eq("it walks the 12 projected periods from Oct 1-15 to Mar 16-31 - the periods the pace is spread over, less the confirmed one", forecast?.periods.map((p) => p.period.key).join(","), "2026-10-A,2026-10-B,2026-11-A,2026-11-B,2026-12-A,2026-12-B,2027-01-A,2027-01-B,2027-02-A,2027-02-B,2027-03-A,2027-03-B");
    eq("the plan period, confirmed, is not in the walk: its GOAL rows are the real plan and the goal page's own signal", forecast?.periods.some((p) => p.period.key === "2026-09-B"), false);
    eq("every period asks the goal's pace as of today", [...new Set(forecast?.periods.map((p) => p.pace))].join(","), "307.69");
    const decA = forecast?.periods.find((p) => p.period.key === "2026-12-A");
    eq("Dec 1-15: the room gives 200 of the 307.69 and is short by 107.69 - planGoalFunding's own figures for that period", `${decA?.recommended}:${decA?.shortfall}`, "200:107.69");
    eq("... drawn from the one account with room there, at all the room it has", decA?.draws.filter((d) => d.headroom > 0).map((d) => `${d.name}:${d.headroom}:${d.recommendedAmount}`).join(","), "Verify Forecast Account:200:200");
    eq("every other period covers the pace in full", forecast?.periods.filter((p) => p.period.key !== "2026-12-A").map((p) => `${p.recommended}:${p.shortfall}`).join(","), Array(11).fill("307.69:0").join(","));
    const decProjection = (await affordForForecast.projectPeriods([{ year: 2026, month: 12, period: "A" }], { id: forecastAccount.id, name: forecastAccount.name, currency: "USD" }, activeForForecast, forecastContext)).get("2026-12-A")!;
    eq("the figures are the projection's own goal plan for the period, not a second computation", JSON.stringify({ pace: decA?.pace, recommended: decA?.recommended, shortfall: decA?.shortfall, draws: decA?.draws }), JSON.stringify((({ pace, recommended, shortfall, draws }) => ({ pace, recommended, shortfall, draws }))(decProjection.goalPlans.find((g) => g.goalId === forecastGoal.id)!)));
    eq("... whose account figures put the room at exactly 200: 2,000 in, 1,300 owed, 500 kept back", `${decProjection.account.income}:${round2(decProjection.account.committed - decProjection.account.estimatedGoalFunding)}:${decProjection.account.buffer}`, "2000:1300:500");
    eq("and the estimate Afford itself carries for the goal there is the same 200", decProjection.estimatedGoals.find((g) => g.goalId === forecastGoal.id)?.amount, 200);
    const summary = summarizeGoalForecast(forecast!);
    eq("the summary names the first short period", summary.status === "short" ? `${summary.period.period.label}:${summary.period.shortfall}` : "on_track", "Dec 1-15:107.69");

    console.log("-- the two goal signals are independent: at risk ahead, on the roadmap now --");
    const roadmapStatus = (await statusesForForecast(forecastContext)).find((s) => s.goalId === forecastGoal.id);
    eq("the goal page's status: 310 planned against a 307.69 roadmap", `${roadmapStatus?.roadmapAmount}:${roadmapStatus?.planned?.plannedAmount}`, "307.69:310");
    let current = await collectForForecast(forecastContext);
    const riskInsight = current.find((i) => i.source === "goal_forecast_risk" && i.key === forecastGoal.id);
    eq("the forecast detector fires for the goal: advisory, titled after it, linking to it", `${riskInsight?.severity}|${riskInsight?.title}|${riskInsight?.actionHref}`, `advisory|Verify Forecast Goal is at risk before its target date|/goals/${forecastGoal.id}`);
    eq("naming Dec 1-15 and the 107.69, beside the pace, the room, the account with room and the target date", evidenceOf(riskInsight), "Short by=107.69 USD;In=Dec 1-15;Roadmap pace=307.69 USD;Room could give=200 USD;Room on Verify Forecast Account=200 USD;Target date=2027-03-31");
    eq("while the behind-roadmap detector does not fire for it: the confirmed plan is on the roadmap", current.some((i) => i.source === "goal_behind" && i.key === forecastGoal.id), false);
    eq("it is in the one list the Inbox shows and the nav badge counts, among the advisory insights after every critical one", current.findIndex((i) => i.id === riskInsight?.id) >= current.filter((i) => i.severity === "critical").length, true);

    console.log("-- dismissing it is like dismissing any other insight --");
    const forecastDismissalsBefore = (await listForForecast()).length;
    await dismissForForecast({ source: "goal_forecast_risk", key: forecastGoal.id });
    const afterDismiss = await collectForForecast(forecastContext);
    eq("gone from the list, and only it", `${afterDismiss.some((i) => i.id === riskInsight?.id)}:${afterDismiss.length}`, `false:${current.length - 1}`);
    eq("the forecast itself is untouched: the signal is not changed, only the Inbox", summarizeGoalForecast((await forecastGoalFunding(forecastContext)).find((f) => f.goalId === forecastGoal.id)!).status, "short");
    await prisma.insightDismissal.deleteMany({ where: { source: "goal_forecast_risk", key: forecastGoal.id } });
    eq("the fixture dismissal is removed", (await listForForecast()).length, forecastDismissalsBefore);

    console.log("-- the reverse: behind the roadmap now, room the whole way ahead --");
    await prisma.recurringItem.delete({ where: { id: premium.id } });
    await prisma.paydayPlanAllocation.updateMany({ where: { paydayCheckinId: forecastCheckin.id, type: "GOAL", goalId: forecastGoal.id }, data: { plannedAmount: 100 } });
    const roomy = (await forecastGoalFunding(forecastContext)).find((f) => f.goalId === forecastGoal.id);
    eq("with the premium gone every projected period covers the pace", roomy?.periods.map((p) => p.shortfall).join(","), Array(12).fill("0").join(","));
    eq("so the forecast is on track", summarizeGoalForecast(roomy!).status, "on_track");
    current = await collectForForecast(forecastContext);
    const behindInsight = current.find((i) => i.source === "goal_behind" && i.key === forecastGoal.id);
    eq("the behind-roadmap detector fires: 100 planned against 307.69", behindInsight?.evidence[0].kind === "money" ? behindInsight.evidence[0].amount : -1, 207.69);
    eq("and the forecast detector does not", current.some((i) => i.source === "goal_forecast_risk" && i.key === forecastGoal.id), false);

    console.log("-- an undated goal is never walked --");
    await prisma.goal.update({ where: { id: forecastGoal.id }, data: { targetDate: null } });
    eq("no forecast for it: there is no target date to walk to", (await forecastGoalFunding(forecastContext)).some((f) => f.goalId === forecastGoal.id), false);
    const octProjection = (await affordForForecast.projectPeriods([{ year: 2026, month: 10, period: "A" }], { id: forecastAccount.id, name: forecastAccount.name, currency: "USD" }, activeForForecast, forecastContext)).get("2026-10-A")!;
    eq("nor a goal plan in the projection: Afford estimates nothing for an undated goal", octProjection.goalPlans.some((g) => g.goalId === forecastGoal.id), false);
    current = await collectForForecast(forecastContext);
    eq("neither goal detector fires for it", current.filter((i) => i.key === forecastGoal.id).map((i) => i.source).join(","), "");

    await prisma.paydayCheckin.delete({ where: { id: forecastCheckin.id } });
    await prisma.goal.delete({ where: { id: forecastGoal.id } });
    await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Forecast" } } });
    await prisma.transaction.deleteMany({ where: { accountId: forecastAccount.id } });
    await prisma.account.delete({ where: { id: forecastAccount.id } });
    console.log("  ok   goal forecast fixtures removed");
  }

  console.log("\n== debt payoff comparator (pure) ==");
  {
    const card: DebtInput = { goalId: "card", name: "Card", balance: 300, minimum: 100 };
    const loan: DebtInput = { goalId: "loan", name: "Loan", balance: 1000, minimum: 100 };
    const car: DebtInput = { goalId: "car", name: "Car", balance: 2000, minimum: 200 };
    // Deliberately in neither strategy's order.
    const debts: DebtInput[] = [loan, car, card];
    const ids = (list: readonly { goalId: string }[]) => list.map((d) => d.goalId).join(",");
    const finishes = (result: DebtPayoffResult) => result.payoffs.map((p) => `${p.goalId}@${p.period}`).join(",");

    console.log("-- ordering --");
    eq("avalanche puts the largest remaining balance first", ids(orderDebts(debts, "avalanche")), "car,loan,card");
    eq("snowball puts the smallest remaining balance first", ids(orderDebts(debts, "snowball")), "card,loan,car");
    const tied = [{ ...loan, goalId: "l1" }, { ...loan, goalId: "l2" }];
    eq("a tie keeps the input order under avalanche", ids(orderDebts(tied, "avalanche")), "l1,l2");
    eq("... and under snowball", ids(orderDebts(tied, "snowball")), "l1,l2");
    eq("the input is not reordered in place", ids(debts), "loan,car,card");
    eq("a debt with nothing left is left out of the order", ids(orderDebts([...debts, { goalId: "done", name: "Done", balance: 0, minimum: 50 }], "snowball")), "card,loan,car");

    console.log("-- one simulation worked by hand: 450 a period (400 of minimums + 50 extra) --");
    const snowball = simulateDebtPayoff(debts, "snowball", 50);
    const avalanche = simulateDebtPayoff(debts, "avalanche", 50);
    eq("snowball: the card takes the extra and finishes in period 2, the loan in 6, the car in 8", finishes(snowball), "card@2,loan@6,car@8");
    eq("avalanche: the card still finishes in period 3 on its own minimum, the car in 7, the loan in 8", finishes(avalanche), "card@3,car@7,loan@8");
    eq("both orders are debt-free after the same 8 periods", `${snowball.totalPeriods}:${avalanche.totalPeriods}`, "8:8");
    eq("... the whole 3,300 over 450 a period, rounded up", Math.ceil(3300 / 450), 8);
    eq("each result carries the order it directed the extra in", `${ids(snowball.order)}|${ids(avalanche.order)}`, "card,loan,car|car,loan,card");
    eq("each result names its strategy", `${snowball.strategy}:${avalanche.strategy}`, "snowball:avalanche");
    eq("the last payoff lands in the final period", `${snowball.payoffs.at(-1)?.period}:${avalanche.payoffs.at(-1)?.period}`, "8:8");

    console.log("-- the rollover: a paid-off debt's minimum folds into the extra pool from the next period --");
    // Under snowball the card is gone after period 2 and the loan has 800
    // left. On its own 100 plus the 50 extra it would need ceil(800 / 150) =
    // 6 more periods (period 8); with the card's freed 100 in the pool it
    // needs ceil(800 / 250) = 4 (period 6). The single-debt runs below are
    // those two counterfactuals, and the three-debt run above lands on the
    // second one.
    const loanAlone: DebtInput = { ...loan, balance: 800 };
    eq("the loan alone on its minimum plus the extra takes 6 periods", simulateDebtPayoff([loanAlone], "snowball", 50).totalPeriods, 6);
    eq("with the card's freed 100 added to the extra, 4", simulateDebtPayoff([loanAlone], "snowball", 150).totalPeriods, 4);
    eq("and in the three-debt run the loan finishes in period 2 + 4, not 2 + 6", snowball.payoffs.find((p) => p.goalId === "loan")?.period, 6);
    eq("under avalanche the car's 200 and the card's 100 both fold in before the loan is reached: 150 left after period 7 is cleared in one period", finishes(avalanche).endsWith("loan@8"), true);

    console.log("-- the total is order-invariant; only each debt's timing moves --");
    // A deterministic LCG sweep: whatever the balances, minimums and extra,
    // the whole flow (extra + every minimum) reaches the debts every period
    // under either order, so both finish in ceil(total / flow) periods.
    let seed = 20260917;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % (max + 1);
    };
    let sweepFailures = 0;
    let sweepDiffers = 0;
    let sweepRuns = 0;
    for (let run = 0; run < 300; run += 1) {
      const count = 2 + rand(3);
      const set: DebtInput[] = [];
      for (let i = 0; i < count; i += 1) {
        set.push({ goalId: `d${i}`, name: `D${i}`, balance: (1 + rand(499_999)) / 100, minimum: rand(30_000) / 100 });
      }
      const extra = rand(50_000) / 100;
      const flow = round2(extra + set.reduce((sum, d) => sum + d.minimum, 0));
      if (flow === 0) continue;
      sweepRuns += 1;
      const total = round2(set.reduce((sum, d) => sum + d.balance, 0));
      const periods = Math.ceil(Math.round(total * 100) / Math.round(flow * 100));
      // A set too slow for the horizon reports no total under either order.
      const expected = periods <= MAX_DEBT_PERIODS ? periods : null;
      const a = simulateDebtPayoff(set, "avalanche", extra);
      const s = simulateDebtPayoff(set, "snowball", extra);
      const everyDebtOnce = (r: DebtPayoffResult) =>
        expected === null || (r.payoffs.length === count && new Set(r.payoffs.map((p) => p.goalId)).size === count);
      if (a.totalPeriods !== expected || s.totalPeriods !== expected || !everyDebtOnce(a) || !everyDebtOnce(s)) {
        sweepFailures += 1;
        if (sweepFailures <= 3) console.log("     sweep mismatch", JSON.stringify({ set, extra, expected, a: a.totalPeriods, s: s.totalPeriods }));
      }
      if (finishes(a) !== finishes(s)) sweepDiffers += 1;
    }
    eq("300 random debt sets: both orders finish in ceil(total / flow) periods with every debt paid exactly once", `${sweepFailures}/${sweepRuns}`, `0/${sweepRuns}`);
    check("... while the per-debt timing differs between the orders in most of them", sweepDiffers > sweepRuns / 2, `${sweepDiffers}/${sweepRuns}`);

    console.log("-- edges --");
    const noExtra = compareDebtStrategies(debts, 0);
    eq("with no extra the minimums alone carry both orders: 3,300 over 400 is 9 periods", `${noExtra.avalanche.totalPeriods}:${noExtra.snowball.totalPeriods}`, "9:9");
    eq("the comparison reports the per-period flow: the extra plus every minimum", `${noExtra.perPeriodFlow}:${compareDebtStrategies(debts, 50).perPeriodFlow}`, "400:450");
    const spill = simulateDebtPayoff([{ goalId: "a", name: "A", balance: 50, minimum: 100 }, { goalId: "b", name: "B", balance: 150, minimum: 0 }], "snowball", 0);
    eq("a minimum larger than its debt's balance spills the rest to the next debt in the same period: B gets A's 50 in period 1 and A's freed 100 in period 2", finishes(spill), "a@1,b@2");
    eq("... so the total is still ceil(200 / 100)", spill.totalPeriods, 2);
    const undatedFirst = simulateDebtPayoff([{ goalId: "a", name: "A", balance: 200, minimum: 0 }, { goalId: "b", name: "B", balance: 300, minimum: 100 }], "snowball", 50);
    eq("a debt with no pace of its own is paid only by the extra and freed minimums: 50 a period until B's 100 frees up", finishes(undatedFirst), "b@3,a@4");
    const undatedLast = simulateDebtPayoff([{ goalId: "a", name: "A", balance: 200, minimum: 0 }, { goalId: "b", name: "B", balance: 300, minimum: 100 }], "avalanche", 50);
    eq("... and under the other order it waits for B entirely, finishing in the same period 4 here", finishes(undatedLast), "b@2,a@4");
    const stalled = simulateDebtPayoff([{ goalId: "a", name: "A", balance: 100, minimum: 0 }], "snowball", 0);
    eq("nothing flowing at all: no total and no payoffs, rather than a loop", `${stalled.totalPeriods}:${stalled.payoffs.length}`, "null:0");
    eq("... and the comparison says the flow is zero", compareDebtStrategies([{ goalId: "a", name: "A", balance: 100, minimum: 0 }], 0).perPeriodFlow, 0);
    const horizon = simulateDebtPayoff([{ goalId: "a", name: "A", balance: 100, minimum: 0 }, { goalId: "b", name: "B", balance: 1_000_000, minimum: 0 }], "snowball", 1);
    eq("beyond the horizon: the debts that did finish are reported, the total is null", `${finishes(horizon)}:${horizon.totalPeriods}`, "a@100:null");
    eq("the horizon is 600 pay periods (25 years)", MAX_DEBT_PERIODS, 600);
    eq("a debt that takes exactly the horizon still finishes", simulateDebtPayoff([{ goalId: "a", name: "A", balance: 600, minimum: 1 }], "snowball", 0).totalPeriods, 600);
    eq("... one more period does not", simulateDebtPayoff([{ goalId: "a", name: "A", balance: 601, minimum: 1 }], "snowball", 0).totalPeriods, null);
    eq("cents are exact: 0.30 at 0.10 a period is 3 periods, not 4 from float drift", simulateDebtPayoff([{ goalId: "a", name: "A", balance: 0.3, minimum: 0.1 }], "snowball", 0).totalPeriods, 3);
    const empty = simulateDebtPayoff([], "avalanche", 100);
    eq("no debts: debt-free in 0 periods, nothing to list", `${empty.totalPeriods}:${empty.payoffs.length}:${empty.order.length}`, "0:0:0");
    eq("a negative extra counts as none", simulateDebtPayoff(debts, "snowball", -50).totalPeriods, 9);
    eq("a debt already at zero is neither ordered nor reported", finishes(simulateDebtPayoff([...debts, { goalId: "done", name: "Done", balance: 0, minimum: 50 }], "snowball", 50)), "card@2,loan@6,car@8");
    eq("the page compares from two debts up", MIN_DEBTS_TO_COMPARE, 2);
  }

  console.log("\n== debt payoff comparator (database) ==");
  {
    const { listDebtGoals } = await import("../src/lib/data/debt-payoff");
    const { getGoalRoadmapAmount: roadmapForDebts, planPeriodRef: planRefForDebts } = await import("../src/lib/data/payday");
    const { listGoals: listGoalsForDebts } = await import("../src/lib/data/goals");
    const { goalSchema } = await import("../src/lib/validation");
    const debtToday = civilDate(2026, 9, 17);
    const debtContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: debtToday, currentPeriod: periodForDate(debtToday) };
    const debtPlanRef = planRefForDebts(debtContext);
    eq("the fixtures plan for Sep 16-30", periodKey(debtPlanRef), "2026-09-B");

    console.log("-- the goal form's marking --");
    const form = { name: "Verify Debt Form", targetAmount: "100", currency: "USD", targetDate: "" };
    eq("the form's toggle parses as a boolean", goalSchema.safeParse({ ...form, isDebt: "true" }).data?.isDebt, true);
    eq("... off", goalSchema.safeParse({ ...form, isDebt: "false" }).data?.isDebt, false);
    eq("... and absent (a form without the toggle) means not a debt", goalSchema.safeParse(form).data?.isDebt, false);

    console.log("-- which goals the comparator reads --");
    const card = await prisma.goal.create({ data: { name: "Verify Debt Card", targetAmount: 1000, currency: "USD", savedAmount: 300, targetDate: civilDate(2026, 12, 31), isDebt: true } });
    const loan = await prisma.goal.create({ data: { name: "Verify Debt Loan", targetAmount: 3000, currency: "USD", savedAmount: 400, targetDate: civilDate(2027, 3, 31), isDebt: true } });
    const family = await prisma.goal.create({ data: { name: "Verify Debt Family", targetAmount: 500, currency: "USD", savedAmount: 0, isDebt: true } });
    await prisma.goal.create({ data: { name: "Verify Debt Savings", targetAmount: 800, currency: "USD", savedAmount: 0, targetDate: civilDate(2026, 12, 31) } });
    await prisma.goal.create({ data: { name: "Verify Debt Settled", targetAmount: 100, currency: "USD", savedAmount: 100, achievedAt: debtToday, isDebt: true } });
    const short = (name: string) => name.replace("Verify Debt ", "");

    const summaries = await listGoalsForDebts(debtContext);
    eq("the goal summary carries the marking", summaries.filter((g) => g.name.startsWith("Verify Debt")).map((g) => `${short(g.name)}:${g.isDebt}`).sort().join(","), "Card:true,Family:true,Loan:true,Savings:false,Settled:true");

    const debts = await listDebtGoals(debtContext);
    const mine = debts.filter((d) => d.name.startsWith("Verify Debt"));
    eq("only the open goals marked as debts: not the unmarked one, not the settled one", mine.map((d) => short(d.name)).sort().join(","), "Card,Family,Loan");
    eq("nothing else in the database is marked", debts.length, mine.length);
    const byId = new Map(mine.map((d) => [d.goalId, d]));
    eq("each debt's balance is what is still to go, in the display currency", `${byId.get(card.id)?.balance}:${byId.get(loan.id)?.balance}:${byId.get(family.id)?.balance}`, "700:2600:500");
    eq("a dated debt's minimum is its roadmap pace for the plan period: 700 over the 7 periods to Dec 31, 2,600 over the 13 to Mar 31", `${byId.get(card.id)?.minimum}:${byId.get(loan.id)?.minimum}`, "100:200");
    eq("... the very figure the goal page measures against", `${byId.get(card.id)?.minimum === await roadmapForDebts(card.id, debtPlanRef, debtContext)}:${byId.get(loan.id)?.minimum === await roadmapForDebts(loan.id, debtPlanRef, debtContext)}`, "true:true");
    eq("a debt with no target date has no pace of its own: minimum 0", byId.get(family.id)?.minimum, 0);
    eq("the target date rides along for the page", `${byId.get(card.id)?.targetDate ? toISODate(byId.get(card.id)!.targetDate!) : null}:${byId.get(family.id)?.targetDate}`, "2026-12-31:null");
    eq("in the goal list's order (oldest first)", mine.map((d) => d.goalId).join(","), [card.id, loan.id, family.id].join(","));

    console.log("-- end to end: the page's comparison on these inputs, 150 extra --");
    const comparison = compareDebtStrategies(mine, 150);
    eq("avalanche: loan, card, family", comparison.avalanche.order.map((d) => short(d.name)).join(","), "Loan,Card,Family");
    eq("snowball: family, card, loan", comparison.snowball.order.map((d) => short(d.name)).join(","), "Family,Card,Loan");
    eq("450 a period reaches the debts either way: 300 of minimums + 150 extra", comparison.perPeriodFlow, 450);
    eq("both orders clear the 3,800 in the same 9 periods", `${comparison.avalanche.totalPeriods}:${comparison.snowball.totalPeriods}`, "9:9");
    eq("snowball: the family loan in 4 on the extra alone, the card in 5, the loan in 9", comparison.snowball.payoffs.map((p) => `${short(p.name)}@${p.period}`).join(","), "Family@4,Card@5,Loan@9");
    eq("avalanche: the card in 7 on its own pace, the loan in 8, the family loan in 9 once both freed paces reach it", comparison.avalanche.payoffs.map((p) => `${short(p.name)}@${p.period}`).join(","), "Card@7,Loan@8,Family@9");

    console.log("-- fewer than two debts: nothing to compare --");
    await prisma.goal.updateMany({ where: { id: { in: [loan.id, family.id] } }, data: { isDebt: false } });
    const one = (await listDebtGoals(debtContext)).filter((d) => d.name.startsWith("Verify Debt"));
    eq("unmarking two leaves one, below the page's threshold", `${one.length}:${one.length >= MIN_DEBTS_TO_COMPARE}`, "1:false");

    await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify Debt" } } });
    console.log("  ok   debt fixtures removed");
  }

  console.log("\n== cleanup ==");
  await prisma.transaction.deleteMany({ where: { accountId: { in: [checking.id, savings.id] } } });
  await prisma.account.deleteMany({ where: { id: { in: [checking.id, savings.id] } } });
  await prisma.budget.deleteMany({ where: { year: 2026, month: { in: [8, 9] } } });
  await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify" } } });
  await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify" } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: "Verify" } } });
  console.log("  ok   test rows removed");

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(async () => {
  await prisma.$disconnect();
});
