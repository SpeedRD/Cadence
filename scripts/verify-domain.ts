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
} from "../src/lib/period";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "../src/lib/payday";
import { advanceDate } from "../src/lib/recurring";
import { num, round2 } from "../src/lib/money";

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
  const { transactionEditBlock } = await import("../src/lib/transactions");
  eq("an opening balance can't be edited through the transaction form", transactionEditBlock({ type: "OPENING_BALANCE", transferId: null }), "opening_balance");
  eq("a transfer leg can't be edited through the transaction form", transactionEditBlock({ type: "TRANSFER", transferId: "t1" }), "transfer");
  eq("an ordinary expense can be edited", transactionEditBlock({ type: "EXPENSE", transferId: null }), null);
  eq("an ordinary income can be edited", transactionEditBlock({ type: "INCOME", transferId: null }), null);

  console.log("\n== currency conversion through USD ==");
  const rates: RateTable = { rates: { USD: 1, DOP: 60, EUR: 0.5 }, fetchedAt: new Date(), stale: false };
  eq("USD to DOP", convert(100, "USD", "DOP", rates), 6000);
  eq("DOP to USD", convert(6000, "DOP", "USD", rates), 100);
  eq("EUR to DOP has no stored pair", convert(10, "EUR", "DOP", rates), 1200);
  eq("DOP to EUR round trip", convert(1200, "DOP", "EUR", rates), 10);
  eq("same currency is identity", convert(7, "EUR", "EUR", rates), 7);

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
  const { getPaydayCheckinDraft, confirmPaydayCheckin } = await import("../src/lib/data/payday");
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
