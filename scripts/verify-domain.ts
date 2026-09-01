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
  periodsRemaining,
  periodSeries,
} from "../src/lib/period";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "../src/lib/payday";
import { advanceDate } from "../src/lib/recurring";

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
