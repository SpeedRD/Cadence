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
import { convert, type RateTable } from "../src/lib/currency";
import {
  DATE_FORMATS,
  parseAmount,
  parseCsv,
  parseDateWithFormat,
} from "../src/lib/csv";
import {
  appTimeZone,
  civilDate,
  civilDateInZone,
  DEFAULT_APP_TIMEZONE,
  formatDate,
  toISODate,
} from "../src/lib/date";
import {
  daysRemainingInPeriod,
  isPaydayDate,
  periodForDate,
  periodInfo,
  periodsRemaining,
  periodSeries,
  previousComparablePeriod,
} from "../src/lib/period";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "../src/lib/payday";
import { advanceDate } from "../src/lib/recurring";
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
import { gmailRedirectUri } from "../src/lib/oauth/google";
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

  console.log("\n== transaction edit guard ==");
  const { transactionEditBlock, balanceSign, isCashflow } = await import("../src/lib/transactions");
  eq("an opening balance can't be edited through the transaction form", transactionEditBlock({ type: "OPENING_BALANCE", transferId: null }), "opening_balance");
  eq("a transfer leg can't be edited through the transaction form", transactionEditBlock({ type: "TRANSFER", transferId: "t1" }), "transfer");
  eq("an ordinary expense can be edited", transactionEditBlock({ type: "EXPENSE", transferId: null }), null);
  eq("an ordinary income can be edited", transactionEditBlock({ type: "INCOME", transferId: null }), null);
  eq("an outgoing external transfer can be edited (single row, never paired)", transactionEditBlock({ type: "EXTERNAL_TRANSFER", transferId: null }), null);
  eq("an incoming external transfer can be edited (single row, never paired)", transactionEditBlock({ type: "EXTERNAL_TRANSFER", transferId: null }), null);
  eq("balanceSign(EXTERNAL_TRANSFER, OUT) is -1, same shape as an outgoing internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "OUT"), -1);
  eq("balanceSign(EXTERNAL_TRANSFER, IN) is +1, same shape as an incoming internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "IN"), 1);
  eq("isCashflow(EXTERNAL_TRANSFER) is false - it never counts as income or spending", isCashflow("EXTERNAL_TRANSFER"), false);

  console.log("\n== currency conversion through USD ==");
  const rates: RateTable = { rates: { USD: 1, DOP: 60, EUR: 0.5 }, fetchedAt: new Date(), stale: false };
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
  eq("committed counts only items due before period end", summary.committed, 15);
  eq("safe to spend = budget - spent - committed", summary.safeToSpend, 455);
  eq("per day over the 12 remaining days", summary.safeToSpendPerDay, Math.round((455 / 12) * 100) / 100);

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

  const { advanceDueRecurringItems } = await import("../src/lib/recurring");
  const advanced = await advanceDueRecurringItems(context.today);
  check("overdue recurring items roll forward", advanced >= 1);
  const rolled = await prisma.recurringItem.findFirst({ where: { name: "Verify past due" } });
  eq("rolled to the next occurrence", toISODate(rolled!.nextDate), "2026-09-05");

  const summaryAfter = await getPeriodSummary(context.currentPeriod, context);
  eq("a rolled item is no longer committed this period", summaryAfter.committed, 15);

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
      { name: "Verify Netflix Monthly", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 7), active: true, categoryId: subscriptionsCategory.id },
      { name: "Verify Spotify Monthly", amount: 10, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 25), active: true },
      { name: "Verify Auto-Invest", amount: 100, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 1), active: true },
    ],
  });

  const monthlyContext = { displayCurrency: "USD" as const, language: "en" as const, rates, today: civilDate(2026, 7, 31), currentPeriod: periodForDate(civilDate(2026, 7, 31)) };
  const recurringForMatch = (await prisma.recurringItem.findMany({
    where: { active: true, kind: { in: ["SUBSCRIPTION", "CONTRIBUTION"] }, name: { startsWith: "Verify" } },
    select: { id: true, name: true, amount: true, currency: true, categoryId: true, kind: true, frequency: true, nextDate: true },
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
    "still-due excludes items already matched and items whose next date has already passed (HBO), includes EUR/DOP conversions",
    pace.committedStillDueThisMonth,
    60,
  );
  eq("projected normal spending = projected lifestyle + committed so far + still due", pace.projectedNormalSpending, 137);
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

  console.log("\n== payday planner (pure) ==");
  eq("the 15th is a payday date", isPaydayDate(civilDate(2026, 8, 15)), true);
  eq("Aug 31 is a payday date", isPaydayDate(civilDate(2026, 8, 31)), true);
  eq("Feb 28 2026 (non-leap) is a payday date", isPaydayDate(civilDate(2026, 2, 28)), true);
  eq("Feb 29 2024 (leap) is a payday date", isPaydayDate(civilDate(2024, 2, 29)), true);
  eq("Feb 28 2024 (leap, not last day) is not a payday date", isPaydayDate(civilDate(2024, 2, 28)), false);
  eq("the 16th is not a payday date", isPaydayDate(civilDate(2026, 8, 16)), false);
  eq("the 1st is not a payday date", isPaydayDate(civilDate(2026, 8, 1)), false);

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

  console.log("\n== account archive lifecycle ==");
  const { archiveAccount, restoreAccount, deleteAccountIfSafe, getAccountLedger, setOpeningBalance } =
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
  const { getPaydayCheckinDraft, confirmPaydayCheckin, getCategorySuggestions } = await import(
    "../src/lib/data/payday"
  );
  const { getSettings } = await import("../src/lib/auth");

  const paydaySettings = await getSettings();
  const paydayContext = {
    displayCurrency: "USD" as const,
    language: "en" as const,
    rates,
    today: civilDate(2026, 8, 15),
    currentPeriod: periodForDate(civilDate(2026, 8, 15)),
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
    data: { name: "Verify Payday Netflix", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 20), active: true, categoryId: subsCategoryForPayday.id },
  });
  const paydayContribution = await prisma.recurringItem.create({
    data: { name: "Verify Payday Auto-Invest", amount: 100, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 20), active: true },
  });

  const datedGoal = await prisma.goal.create({
    data: { name: "Verify Payday Dated Goal", targetAmount: 1000, currency: "USD", targetDate: civilDate(2026, 10, 15) },
  });
  const undatedGoal = await prisma.goal.create({
    data: { name: "Verify Payday Undated Goal", targetAmount: 1000, currency: "USD" },
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
  check(
    "only the dated goal is reserved - the undated goal is not automatically included",
    draft.goals.some((g) => g.goalId === datedGoal.id) && !draft.goals.some((g) => g.goalId === undatedGoal.id),
  );
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
      JSON.stringify({ amount: 30, basis: "average" }), // (80 + 100) / HISTORY_PERIODS(6)
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

    console.log("\n-- scaling flexible recommendations against available money --");
    const rawSuggestions = [
      { id: diningCat.id, suggested: suggestions.get(diningCat.id)!.amount },
      { id: transportCat.id, suggested: suggestions.get(transportCat.id)!.amount },
    ];
    const rawTotal = rawSuggestions.reduce((sum, s) => sum + s.suggested, 0);
    eq("raw recommendations total 180 before any scaling", rawTotal, 180);

    const comfortablyAvailable = scaleFlexibleSuggestions(rawSuggestions, 500);
    eq(
      "recommendations that already fit the available money pass through unscaled",
      JSON.stringify(comfortablyAvailable.map((s) => s.scaled)),
      JSON.stringify([150, 30]),
    );

    const tightlyAvailable = scaleFlexibleSuggestions(rawSuggestions, 90);
    const scaledTotal = tightlyAvailable.reduce((sum, s) => sum + s.scaled, 0);
    check("scaled recommendations never exceed available flexible money", scaledTotal <= 90);
    eq("proportional scaling: total lands exactly on the available amount here", scaledTotal, 90);
    const rawRatio = rawSuggestions[0].suggested / rawSuggestions[1].suggested;
    const scaledDining = tightlyAvailable.find((s) => s.id === diningCat.id)!.scaled;
    const scaledTransport = tightlyAvailable.find((s) => s.id === transportCat.id)!.scaled;
    eq("proportional scaling preserves the relative ratio between categories", scaledDining / scaledTransport, rawRatio);

    const negativeAvailable = scaleFlexibleSuggestions(rawSuggestions, -50);
    check(
      "negative available flexible money preserves the existing deficit behavior - every suggestion scales to zero, none negative",
      negativeAvailable.every((s) => s.scaled === 0),
    );

    // The shared draft's own `available` is already deeply negative at this
    // point in the script (no income entered yet on this unconfirmed plan),
    // so this closes the loop end-to-end: real comparable-period/history
    // recommendations exist (basis last_budget/average, confirmed above) but
    // the draft still forces every flexible suggestedAmount to 0 rather than
    // suggesting money that isn't there.
    const draftDuringDeficit = await getPaydayCheckinDraft(paydayContext);
    const draftDining = draftDuringDeficit.flexibleCategories.find((c) => c.categoryId === diningCat.id);
    eq(
      "wired end-to-end: a real last_budget recommendation is still forced to 0 while the plan is in deficit",
      JSON.stringify(draftDining && { basis: draftDining.basis, suggestedAmount: draftDining.suggestedAmount }),
      JSON.stringify({ basis: "last_budget", suggestedAmount: 0 }),
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
    goals: draftForConfirm.goals.map((g) => ({ goalId: g.goalId, plannedAmount: g.recommendedAmount })),
    essentialCategories: draftForConfirm.essentialCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    flexibleCategories: draftForConfirm.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    buffer: draftForConfirm.suggestedBuffer,
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

  const goalAllocation = await prisma.paydayPlanAllocation.findFirst({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
  });
  check(
    "the goal's roadmap recommendation is recorded in the allocation audit trail",
    Boolean(goalAllocation) && num(goalAllocation!.recommendedAmount) > 0,
  );

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
  await prisma.budget.update({ where: { id: confirmedFlexibleBudget.id }, data: { amount: 45 } });

  console.log("\n-- reopening the confirmed check-in after the display currency changed converts, not just relabels --");
  const eurPaydayContext = { ...paydayContext, displayCurrency: "EUR" as const };
  const draftAfterCurrencySwitch = await getPaydayCheckinDraft(eurPaydayContext);
  eq(
    "the stored buffer is converted from the currency it was confirmed in, not read back raw",
    draftAfterCurrencySwitch.plannedBuffer,
    round2(convert(updatedPayload.buffer, "USD", "EUR", rates)),
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
  eq(
    "the already-confirmed carryover amount is also converted, not left raw",
    draftAfterCurrencySwitch.includedCarryover,
    round2(convert(10, "USD", "EUR", rates)),
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
    goals: draftForConfirm.goals.map((g) => ({ goalId: g.goalId, plannedAmount: 5 })),
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

  console.log("\n-- payday check-in cleanup --");
  await prisma.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
  await prisma.paydayAccountSnapshot.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
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
  }

  console.log("\n== cleanup ==");
  await prisma.transaction.deleteMany({ where: { accountId: { in: [checking.id, savings.id] } } });
  await prisma.account.deleteMany({ where: { id: { in: [checking.id, savings.id] } } });
  await prisma.budget.deleteMany({ where: { year: 2026, month: { in: [8, 9] } } });
  await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify" } } });
  await prisma.goal.deleteMany({ where: { name: "Verify Goal" } });
  console.log("  ok   test rows removed");

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(async () => {
  await prisma.$disconnect();
});
