# Quantities map: every money figure, and where one concept has several rules (2026-09-30)

This is a read-only map of every money quantity Cadence shows or decides
with, and of the places where one concept is computed by different rules.
It feeds four upcoming tasks: the goal roadmap fixes, the check-in fixes,
"income earmarked for a recurring payment", and stored amounts in the
account's currency.

Contents:
1. Glossary (79 quantities: eight families, plus stored figures nothing reads)
2. Divergences (D1-D48)
3. Naming collisions (N1-N17)
4. Proposal: canonical definitions (K1-K9), order, and which task uses which
5. Design decisions for you (no choice made)
6. Unproven
7. Traces (a)-(d)

## How the evidence was produced

- Code at `bee07c7` (main, clean). Line numbers are at that commit.
- Every divergence in section 2 was reproduced by me, by calling the real
  functions: pure functions directly, and data functions against a throwaway
  database, `cadence_qmap_scratch`, which was created, migrated, seeded with the
  default categories, filled with fictional `Fict …` rows, and dropped at the
  end. Nothing ran against `cadence_dev` or production.
- Contexts were built by hand. Unless a row says otherwise: display currency
  DOP, rates USD 1 / DOP 60 / EUR 0.9, buffer 10% with a 2,000 DOP floor,
  and no "count income history from" date. Where a scenario needed
  posting to fetch rates, fresh `ExchangeRate` rows were written to the
  scratch database first, so nothing called the rate service.
- Four read-only subagents (one per pass: A income/committed/spent/budgets,
  B goals, C balances/currency/shared, D periods/installments/debts) proposed
  candidates. A candidate became a divergence only after I reproduced it
  myself. Anything not reproduced is in section 6.
- The repro scripts live in the session scratchpad, not in the repo. No
  source, test or config file was changed; this file is the only addition.
- Severity is about risk to real money, on the scale BUG_HUNT_FINDINGS.md
  uses. **High:** a wrong figure the user acts on, or a wrong ledger row, in
  an ordinary scenario. **Medium:** the same in a narrower scenario. **Low:**
  a narrow trigger, a small amount, or display only. **Very low:** an edge
  case of an edge case. Confidence is about whether the defect is real, not
  how often it happens.
- B-numbers refer to BUG_HUNT_FINDINGS.md. Status against the current code:
  B1-B8, B10, B15-B18, B20, B22, B26-B28, B30-B34, B41 and B45-B47 are fixed.
  These are still open and reproduced again here: B9, B11, B12, B13, B14,
  B19, B21, B23, B24, B25, B29, B35, B36, B38, B39, B42, B43, B44. B29 only
  reproduces when the accounts have no room at all (a goal the user plans at
  0 while the room recommends more is flagged now).

---

## 1. Glossary

Each entry gives: the label (dictionary key, English / Spanish), where it is
shown, what computes it (file:line), its inputs, and its definition. Files
are under `src/`. "Today's rates" means `context.rates`, the one rate table
of the request. "Display" means `context.displayCurrency`. "Current period"
is the calendar period containing today. "Plan period" is `planPeriodRef`: the
next period from the day the current period's pay lands until it ends,
otherwise the current period.

### 1.1 Income

**Q1. Period income** (Dashboard hero and Reports card)
- Label: `dashboard.income` "Income" / "Ingresos", hint `dashboard.loggedThisPeriod` "logged this period" / "registrado este periodo"; `reports.incomeThisPeriod` "Income this period" / "Ingresos este periodo".
- Shown: `components/dashboard/period-hero.tsx:161-168`; `app/(app)/reports/page.tsx:87-94`.
- Computed: `getPeriodSummary`, `lib/data/period-summary.ts:231-236, 297-300`.
- Inputs: INCOME rows dated in the period except `PAYDAY_CHECKIN` ones; the `incomeEntered` of the period's confirmed check-in snapshots; today's rates.
- Definition: a paycheck recorded through a check-in counts in the period the check-in planned, whatever day it landed; every other income row counts by its date. One-off income and reimbursement deposits count. Converted at today's rate.

**Q2. Reports trend income**
- Label: trend tooltip `reports.tooltipIn`.
- Computed: `getSpendingTrend`, `lib/data/reports.ts:59-86`.
- Definition: Q1's rule, per period, for the six periods ending with the current one.

**Q3. Check-in income** (Step 2 "Total income", Step 3 "Income")
- Label: `payday.totalIncome` "Total income" / "Ingreso total"; `payday.summaryIncome` "Income" / "Ingreso".
- Shown: `components/payday/step-income.tsx:56-59`; `step-commitments.tsx:628-631`; `step-confirm.tsx:52`.
- Computed: client `components/payday/payday-checkin-dialog.tsx:124-129`; server on confirm `lib/data/payday.ts:1142-1154`.
- Inputs: what the user types per account.
- Definition: one figure per account, no one-off flag. Stored as `PaydayAccountSnapshot.incomeEntered` (account currency) and as one `PAYDAY_CHECKIN` INCOME row per account dated `checkinDate` (`lib/data/payday.ts:1389-1444`). The stored total `PaydayCheckin.totalIncome` is never read back.

**Q4. Confirmed check-in card "Income"** (Dashboard)
- Label: `payday.summaryIncome`.
- Shown: `components/dashboard/payday-checkin-card.tsx:44-45`.
- Computed: `summarizePaydayDraft(draft).totalIncome`, `lib/payday.ts:126-132`, over a freshly built draft of the plan period.
- Definition: Q3 as confirmed, re-converted at today's rate. It is the plan period's income; the hero's Q1 is the current period's, so from payday to period end they show different periods side by side.

**Q5. Income by date** (Transactions page "in", account page "Income in")
- Label: `accounts.incomeIn` "Income in" / "Ingresos"; the Transactions totals line.
- Computed: `summarizeTransactions`, `lib/data/transactions.ts:390-414`; `getAccountLedger`, `lib/data/accounts.ts:345-347`.
- Definition: every INCOME row by its date, check-in paychecks included, at today's rate.

**Q6. Afford projected income** (per account and period-wide)
- Label: `afford.projectionIncome` "Income" / "Ingreso".
- Shown: `components/afford/afford-results.tsx:612` and the account columns.
- Computed: `projectPeriods`, `lib/data/afford.ts:607-820`, with `comparableHistory` (`:150-171`), `loadPeriodIncome` (`:236-277`), `incomeHistoryDepth` (`:185-191`), `averageOverHistory` (`:194-198`).
- Inputs: up to six same-half periods before the evaluated one (walking past periods that have not ended and are not confirmed, dropping those that ended before "count income history from"); per period the INCOME rows by date excluding `PAYDAY_CHECKIN`, `isOneOffIncome` and reimbursement deposits, plus the confirmed snapshots' `incomeEntered`; active accounts only.
- Definition: the average over the periods since the oldest one with income in any account. The evaluated period's own check-in income is never read, even when that period is confirmed. Also used by the subscription-room check, the From Afford tracker and the goal forecast.

(The monthly pace never reads income: `lib/data/monthly.ts:39`.)

### 1.2 Committed

**Q7. "Committed"** (Dashboard hero, Budgets page)
- Label: `dashboard.committed` / `budgets.committed` "Committed" / "Comprometido"; hints `dashboard.itemsDueBefore` "{n} items due before {date}", `budgets.recurringStillToCome` "{n} recurring items still to come".
- Shown: `period-hero.tsx:152-160`; `app/(app)/budgets/page.tsx:259-263`.
- Computed: `getPeriodSummary`, `period-summary.ts:150-154` (items) and `:304-330`.
- Inputs: active items with `nextDate ≤ period end`, both kinds, whatever their account or goal state; today.
- Definition: for each item, `owedOccurrences(item, max(today, period start), period end)` × `item.amount` at today's rate. An item whose `nextDate` is before the window's start counts once as overdue; a finite item stops at its countdown. Occurrences already posted this period are not included.

**Q8. Step 3 "Subscriptions" and "Recurring contributions"**
- Label: `payday.summarySubscriptions` "Subscriptions" / "Suscripciones", `payday.summaryContributions` "Recurring contributions" / "Aportes recurrentes"; lists `payday.subscriptionsDue` "Subscriptions due before next payday" / "Suscripciones antes del próximo pago", `payday.contributionsDue`; badge `payday.alreadyPaidThisPeriod`.
- Shown: `step-commitments.tsx:88-104, 440-480, 636-643`.
- Computed: `getPaydayCheckinDraft`, `lib/data/payday.ts:846-855`, via `toCommittedDraft` (`:607-630`) and `loggedOccurrencesByItem` (`:593-605`) over `loadSettlementPlan(plan.end)`; confirm recomputes at `:1156-1165`.
- Definition: Q7's items and occurrences for the plan period, less the occurrences already in the ledger (a RECURRING row exists, or posting's settlement plan pairs a charge the user entered with it). The totals are the outstanding amounts.

**Q9. Afford "Commitments"** (per account and period-wide)
- Label: `afford.projectionCommitted` "Commitments" / "Compromisos"; estimate notes `afford.estimatedInCommitments`, `afford.estimatedGoalItem`, `afford.estimatedGoalFunding`.
- Computed: `loadScheduledCommitments`, `lib/data/afford.ts:334-450`, plus the goal estimate in `projectPeriods` (`:723-762`, totals at `:784, :802`).
- Definition: every active item's occurrences from today, filed by the period of the due date (an overdue date goes to the current period), skipping contributions to an achieved goal (`:430`); the current period also counts every RECURRING row and every settled charge dated in it, at their own amounts (`:395-428`); a confirmed period adds its GOAL rows (`:441-448`); an unconfirmed one adds the estimated goal funding (Q40).

**Q10. Subscription-room check** (Recurring form, for a large subscription)
- Label: `recurring.roomColumnHeadroom` "Above its buffer" / "Sobre su colchón" and the room panel.
- Computed: `checkSubscriptionRoom`, `lib/data/subscription-room.ts:86-154`; threshold `lib/subscription-room.ts:12, 21-32` (10,000 DOP per charge or monthly equivalent).
- Definition: Afford's projection (Q9, Q6) for the one period the "Next due" date lands in, with the edited item's own occurrences taken out of `account.committed` only.

**Q11. From Afford tracker** (payments left, re-check, viability badge)
- Label: `recurring.paymentsLeft` "{n} payments left" / "{n} pagos restantes"; `recurring.stillOnTrack` "Still on track" / "Sigue en orden"; `recurring.shortBy`; `dashboard.affordShortItem`.
- Shown: `components/recurring/recurring-list.tsx:36-68, 139-150`; `components/dashboard/afford-viability-alert.tsx:28-41`; Inbox.
- Computed: `recheckAffordItems` → `recheckLoadedItem`, `lib/data/afford.ts:997-1062`; `remainingInstallments`, `lib/afford-tracking.ts:30-49`.
- Definition: Afford's two checks over the plan's remaining installments at `item.amount` in `item.currency`, with the plan's own walk excluded from the commitments. Every installment dated before today is filed in the current period, one row each.

**Q12. From Afford card total**
- Label: `recurring.fromAfford` "From Afford" / "Desde Cuotas"; `recurring.fromAffordDescription` "{amount} a month across {n} plans still paying…".
- Computed: `listRecurringItems`, `lib/data/recurring.ts:66-130`.
- Definition: the monthly equivalent of each active From Afford item at today's rate, summed. No screen shows the amount still owed on a plan.

**Q13. Monthly pace "Committed"** (month in progress and completed months)
- Label: `monthlyPace.committed` "Committed" / "Comprometido"; Reports `reports.monthlyCommittedAverage`.
- Computed: `computeMonthActuals` (`lib/data/monthly.ts:483-527`), `classifyCompletedMonth` (`:676-693`), `getCurrentMonthPace` (`:836-866`).
- Definition: SUBSCRIPTION charges by calendar month (RECURRING rows and settled charges by their occurrence key, plus same-currency heuristic matches); a completed month with no charge falls back to the item's monthly equivalent; the month in progress adds subscription occurrences due from tomorrow. Items are loaded without their countdown (`:214-232`).

**Q14. Next 7 days**
- Label: `dashboard.nextDays` "Next 7 days" / "Próximos 7 días"; `dashboard.nothingDue` "Nothing due in the next week."
- Computed: `getDashboardData`, `lib/data/dashboard.ts:41-71`.
- Definition: active items with `nextDate ≤ today + 6`, overdue included, one row per item at `item.amount` converted at today's rate.

**Q15. "Plus X on subscriptions and savings, which the budget does not cover"**
- Label: `dashboard.plusOutsideBudget`.
- Shown: `period-hero.tsx:130-136`.
- Definition: `totalSpent − spent` (Q17 minus Q16).

### 1.3 Spent, budgets and safe to spend

**Q16. Budget spent** (Dashboard "Spent", Budgets "X spent of Y")
- Label: `dashboard.spent` "Spent" / "Gastado"; `budgets.spentOf`.
- Computed: `period-summary.ts:256-294` (`outsideBudget` at `:293`).
- Definition: every EXPENSE row dated in the period at today's rate, except RECURRING rows, rows in a subscription or savings category, manual contribution twins, and charges settled for a CONTRIBUTION occurrence. A charge settled for a SUBSCRIPTION occurrence is included (unless its category is a subscription/savings one). Shared expenses and one-offs count in full.

**Q17. Total spent** (Reports "This period", trend, category bars, Reports average per period)
- Label: `reports.thisPeriod` "This period" / "Este periodo".
- Computed: `period-summary.ts:238`; `lib/data/reports.ts:58-70, 108-117`.
- Definition: every EXPENSE row in the period, RECURRING rows and contribution twins included, full amounts, at today's rate. The average covers finished periods ending on or after the first activity.

**Q18. Budgets page category "Spent"**
- Label: `budgets.colSpent` "Spent" / "Gastado".
- Computed: `spentByCategory`, `period-summary.ts:274-281`.
- Definition: every EXPENSE row in the category, RECURRING and settled rows included. Not Q16's population.

**Q19. Period budget** ("of Y budgeted", "Overall budget")
- Label: `dashboard.ofBudgeted`; `budgets.overallBudget`, `budgets.noOverallSet` "No overall budget set. Category budgets total X and are used instead."
- Computed: `period-summary.ts:173-188, 332-333`.
- Definition: the overall Budget row if set, else the sum of category Budget rows, at today's rate. A confirmed check-in writes a row for every essential and flexible category (`lib/data/payday.ts:1524-1567`), so after a check-in it is essential planned + flexible planned.

**Q20. Safe to spend and per day** (Dashboard hero, Budgets page)
- Label: `dashboard.safeToSpendPerDay` "Safe to spend per day" / "Disponible para gastar por día", `dashboard.leftForRest`, `dashboard.overThePlan`; `budgets.safeToSpend` "Safe to spend" / "Disponible para gastar", `budgets.perDay`.
- Computed: `period-summary.ts:334-338`.
- Definition: `periodBudget − spent` (Q19 − Q16); per day = `max(0, that) / days left counting today`. Commitments are not subtracted.

**Q21. Dashboard "Recommended"**
- Label: `dashboard.recommendedBudget` "Recommended: X - what your payday check-in leaves for flexible categories." / "Recomendado: X - lo que tu revisión de día de pago deja para categorías flexibles."; `dashboard.recommendedShortfall`.
- Computed: `app/(app)/page.tsx:54-59` (`summarizePaydayDraft(live draft).available` when the current period's check-in is confirmed and no overall budget exists).
- Shown: `period-hero.tsx:91-113`, **only when the period has no budget at all** (`:67`).
- Definition: Q23 over a draft rebuilt now. Carried to the Budgets page as `?suggested=` (Q22).

**Q22. Budgets page pre-filled overall budget**
- Label: `budgets.prefilledFromCheckin`.
- Computed: `app/(app)/budgets/page.tsx:65-67, 116`.
- Definition: the `suggested` parameter from Q21, shown while no overall budget exists.

**Q23. Step 3 "Available for flexible categories"** (also the phone bar on Steps 3-4 and the confirmed card)
- Label: `payday.summaryAvailable` "Available for flexible categories" / "Disponible para categorías flexibles"; lines above it `summaryCarryover`, `summaryGoals` "Goal plan" / "Plan de metas", `summaryEssential`, `summaryBuffer` "Protected buffer" / "Colchón protegido", `summaryReconciliationCap` "Capped by your reported balance" / "Tope por tu saldo reportado".
- Shown: `step-commitments.tsx:664-676`; `payday-checkin-dialog.tsx:472-479`; `payday-checkin-card.tsx:44-47`.
- Computed: `availableForFlexibleCategories`, `lib/payday.ts:62-73`, fed by `payday-checkin-dialog.tsx:184-196`; confirm `lib/data/payday.ts:1285-1294`; the card through `summarizePaydayDraft` (`lib/payday.ts:126-155`).
- Definition: income (Q3) + included carryover (Q26) − outstanding subscriptions and contributions (Q8) − goal plan (Q37) − essential planned (Q28) − protected buffer (Q51), then minus the reconciliation cap (Q53). It can be negative. The card recomputes it from a new draft each time it renders.

**Q24. Step 4 "Allocated", "Unallocated", "Estimated safe to spend per day"**
- Label: `payday.flexibleAllocated` "Allocated" / "Asignado", `payday.flexibleUnallocated` "Unallocated" / "Sin asignar", `payday.safeToSpendPerDayEstimate` "Estimated safe to spend per day" / "Disponible para gastar por día".
- Computed: `components/payday/step-flexible.tsx:32-34`, divisor `daysRemainingInPlanPeriod` (`lib/data/payday.ts:998`).
- Definition: unallocated = Q23 − the flexible rows planned; per day = `max(0, unallocated) / days in the plan period` (the full length when the period has not started). The unallocated money is written to no Budget row.

**Q25. Afford "Available for flexible categories"** and the per-account check
- Label: `afford.columnFlexibleCheck` "Available for flexible categories" / "Disponible para categorías flexibles"; `afford.columnAccountCheck` "{account} above its buffer"; Inbox `inbox.affordHeadroom` "Room left after it" / "Margen que queda después".
- Computed: `evaluateAffordability`, `lib/afford.ts:405-410` (`headroomBefore`) and `:436-444` (`availableBefore`).
- Definition: the check-in formula with income = Q6 period-wide, carryover 0, subscriptions = Q9 period-wide, contributions and goal plan 0 (inside Q9), essential = Q28 (Afford's reading), buffer = the sum over active accounts with any average income of `max(%, floor)` of that average; no reconciliation cap. The account check is `income − committed − essential share − buffer` for the chosen account.

**Q26. Carryover**
- Label: `payday.carryoverAvailable` "{x} unspent from last period's budget" / "{x} sin gastar del presupuesto anterior"; `payday.summaryCarryover`.
- Computed: `getAvailableCarryover`, `lib/data/payday.ts:550-557`; clamped on confirm `:1281-1283`.
- Definition: `max(0, safe to spend)` (Q20) of the period before the plan period, read at draft time even while that period is still running; included by default per Settings.

**Q27. Category suggestion** (Step 4 and essential rows)
- Label: `payday.basisLastBudget`, `basisAverage`; `noSuggestionsYetNote`.
- Computed: `getCategorySuggestions`, `lib/data/payday.ts:234-340`.
- Definition: the last comparable budget, else the average of the category's `spentExcludingRecurring − extraordinary − others' share` over up to six same-half periods before the plan period (no "has ended" rule), divided by the periods from the category's first period with spending.

**Q28. Essential fixed** (check-in and Afford)
- Label: `payday.summaryEssential`.
- Computed: check-in rows `lib/data/payday.ts:932-947`; Afford `loadEssentialFixed`, `lib/data/afford.ts:480-572`.
- Definition: the period's saved Budget row, else the confirmed allocation, else the suggestion (Q27). Afford asks for the suggestion of a stand-in period when the evaluated one is far ahead.

**Q29. Monthly lifestyle, projection and averages**
- Label: `monthlyPace.projected` "Projected this month" / "Proyectado este mes", `monthlyPace.basedOnMonths`; Reports monthly averages.
- Computed: `lib/data/monthly.ts:395-630, 738-869`.
- Definition: expenses that are not savings and not matched to a recurring item, by calendar month; the month in progress is projected by days elapsed from typical spending (one-offs out, shared expenses at the user's share); the average covers up to six completed months, skipping a first month whose activity starts after day 7, bounded by the month containing "count income history from".

### 1.4 Goals

**Q30. Saved**
- Label: a bare figure; `goals.inCurrency` "In {code}" / "En {code}"; `goals.percentOf`.
- Shown: `app/(app)/goals/page.tsx:148-150`; `app/(app)/goals/[id]/page.tsx:133-135, 179-183`; `components/dashboard/goal-card.tsx:34-36`.
- Computed: `rebuildGoalSaved` → `savedFromContributions`, `lib/goals.ts:316-330, 352-401`, cached in `Goal.savedAmount`.
- Definition: the sum of every contribution row of the goal, **with no date filter** (a contribution dated tomorrow counts today), converted only when a row's currency differs from the goal's.

**Q31. Progress** — `summarize`, `lib/data/goals.ts:114`: `min(1, saved / target)`.

**Q32. Remaining / "Still to go"**
- Label: `goals.stillToGo` "Still to go" / "Falta por alcanzar"; `goals.toGo`.
- Computed: `lib/data/goals.ts:113`.
- Definition: `max(0, target − saved)`, live and net of every contribution whatever its date.

**Q33. Goals page "per pay period" and "periods left"** (Goals list, goal detail, Dashboard goal card)
- Label: `goals.perPayPeriod` / `dashboard.perPayPeriod` "per pay period" / "por periodo de pago"; `goals.perPayPeriodLabel`; `goals.periodsLeft` "{n} periods left" / "{n} periodos restantes"; `goals.periodsToTarget` "{n} periods to the target date" / "… hasta la fecha límite"; `dashboard.periodsTo`; `goals.dueThisPeriod` "due this period" / "vence este periodo".
- Shown: `goals/page.tsx:173-184`; `goals/[id]/page.tsx:152-161`; `goal-card.tsx:54-63`.
- Computed: `summarize`, `lib/data/goals.ts:116-127`, with `loadDueContributionsByGoal` (`:24-54`).
- Definition: `max(0, remaining / max(1, periodsRemaining(today, target)) − recurring contributions due from today to the end of the current period)`. Counted from today, so the current period counts even when its pay has been planned already; 0 periods shows "due this period" (the current period).

**Q34. Roadmap amount** (the plan-period pace)
- Label: `payday.roadmapAmount` "Roadmap amount" / "Monto de la hoja de ruta"; `inbox.goalRoadmap` "Roadmap this period" / "Hoja de ruta este periodo"; `inbox.forecastPace` "Roadmap pace" / "Ritmo de la hoja de ruta"; `goals.debtPace` "{x} per pay period on its own" / "… por periodo de pago por sí sola"; Afford "at its current pace".
- Shown: `step-commitments.tsx:516-527`; Inbox evidence `lib/insights.ts:349, 413`; `components/goals/debt-payoff-comparator.tsx:159`. The goal detail page never prints it, only differences from it.
- Computed: `goalRoadmapAmount`, `lib/data/payday.ts:357-364`; for every goal `getGoalRoadmapAmounts` (`:396-415`).
- Definition: `max(0, remaining / goalPeriodsLeft(plan start, target) − the plan period's recurring contributions)`; an undated goal gets its whole remaining balance. Recomputed on every read from live `remaining`.

**Q35. Planned this period**
- Label: `goals.plannedThisPeriod` "{x} planned this period" / "{x} planificado este periodo"; `inbox.goalPlanned` "Planned this period"; wizard `payday.goalPlannedTotal`.
- Computed: Goals list `goals/page.tsx:41-64` (its own fold); detail and Inbox `getGoalRoadmapStatuses`, `lib/data/payday.ts:465-539`.
- Definition: the plan period's confirmed GOAL rows for the goal, summed into the display currency. Nothing compares it with the contributions made.

**Q36. Behind / ahead / room shortfall**
- Label: `goals.plannedBehindRoadmap` "{x} behind the roadmap"; `goals.roomShortfallThisPeriod`; Inbox `inbox.goalTitle` "{name} is behind its roadmap", `goalBehindBy`, `goalRoomShortfall`; wizard `payday.goalBehind` / `goalAhead` "{x} ahead of the target roadmap".
- Computed: detail `goals/[id]/page.tsx:195-207`; Inbox `detectGoalsBehind`, `lib/insights.ts:332-374` (dated goals only, and only when a GOAL row exists, `:335`); wizard `step-commitments.tsx:498, 561-573`.
- Definition: live Q34 minus the confirmed planned amount (behind), or minus the confirm-time room-capped recommendation (room shortfall); the wizard compares its live funding with Q34.

**Q37. Goal plan (Step 3) and per-account "Recommended"**
- Label: `payday.summaryGoals` "Goal plan"; `payday.goalFundingRecommended` "Recommended" / "Recomendado".
- Computed: `planGoalFunding` / `recommendGoalFunding`, `lib/payday.ts:538-650`; seeded by `seedGoalFunding`, `lib/data/payday.ts:678-723`; confirm stores each row's capped draw as `recommendedAmount` (`:1252-1270`).
- Definition: Q34 split over the accounts by headroom (income − outstanding subscriptions − buffer; contributions not subtracted), capped by each account's room, goals in `listGoals` order. A re-opened check-in keeps the confirmed rows only for accounts that have room now, and only for goals not yet achieved.

**Q38. Contributed** (GoalContribution rows)
- Written by `logManualContribution` (`lib/goals.ts:31-80`), recurring posting, and the two correction functions (`lib/goals.ts:148-256`).
- Read only as the lifetime sum (Q30), the row count, the history table, and the monthly savings figure. No reader compares a period's contributions with its plan or pace.

**Q39. Goal forecast / "at risk"**
- Label: `inbox.forecastTitle` "{name} is at risk before its target date"; `forecastShortfall` "Short by" / "Faltan"; `forecastRoom` "Room could give" / "El margen podría dar".
- Computed: `forecastGoalFunding`, `lib/data/goal-forecast.ts:38-88`; `summarizeGoalForecast`, `lib/goal-forecast.ts:66-69`; detector `lib/insights.ts:395-432`.
- Definition: Afford's projection over the periods from the plan period to the target (Q65's count), dropping confirmed periods; per period, Q34 taken once as the pace against what the room could give.

**Q40. Afford's goal estimate**
- Computed: `projectPeriods`, `lib/data/afford.ts:635-762`.
- Definition: in a period with no confirmed check-in, each dated goal's Q34 inside its window (plus the current period when it precedes the plan period, `:674-676`), split over income − scheduled commitments − buffer; undated goals get nothing.

**Q41. Undated goal pace and projected end**
- Label: `goals.pace` "Pace" / "Ritmo", `goals.perPeriod`, `goals.onTrackApprox`; `goals.doneAround`; `dashboard.onTrackFor`.
- Computed: `summarize`, `lib/data/goals.ts:129-151, 181-190`.
- Definition: saved / periods from the first contribution's period to the current one inclusive; end = the current period stepped `ceil(remaining / pace)` times.

### 1.5 Balances

**Q42. Account balance**
- Label: `accounts.colBalance` / `accounts.balance` "Balance" / "Saldo".
- Shown: `app/(app)/accounts/page.tsx:193-199`; `app/(app)/accounts/[id]/page.tsx:83-90`.
- Computed: `getAccountBalances`, `lib/data/accounts.ts:41-112` (balance at `:84-94`); `getAccountLedger`, `:287-380`.
- Definition: every row of the account, every type and every date (future-dated rows included), signed and converted into the account's currency at today's rate.

**Q43. Accounts total** — `accounts.acrossAccounts` "{net} across {n} accounts" / "{net} en {n} cuentas"; `accounts/page.tsx:37, 43-46`: the sum of active accounts' rounded display balances.

**Q44. Ledger running balance and "Change"** — `accounts.colChange`; `lib/data/accounts.ts:311-343`: each row converted at today's rate, cumulated in date order, so past running balances move with the rate.

**Q45. Account page totals** — `accounts.incomeIn`, `spendingOut`, `netTransfers`, `netExternal`; `lib/data/accounts.ts:345-378`: by date, at today's rate; the opening balance is in the balance but in none of these.

**Q46. Opening balance and starting-balance correction** — `setOpeningBalance` and `correctStartingBalance`, `lib/data/accounts.ts:123-217`: written in the account's currency, outside income and spending.

**Q47. Step 1 "Ledger balance"**
- Label: `payday.ledgerBalance` "Ledger balance" / "Saldo según el libro".
- Shown: `components/payday/step-balances.tsx:62-65`.
- Computed: `ledgerBefore(account.balance, snapshot)`, `lib/data/payday.ts:565-574`, from Q42.
- Definition: today's full balance minus this check-in's own paycheck (only when the snapshot created one). Spending after payday and future-dated rows stay in.

**Q48. Reported balance** — `payday.reportedBalance` "Reported balance" / "Saldo reportado"; pre-filled with Q47 on a first draft (`lib/data/payday.ts:834`), stored on the snapshot.

**Q49. Step 1 difference** — `payday.matchesLedger`, `aboveLedger` "{x} above ledger" / "{x} por encima del libro", `belowLedger`; `step-balances.tsx:56`: reported − Q47. Stored as `difference`; nothing reads it.

**Q50. "Left after subscriptions", headroom and shortfall** (Step 3, per account)
- Label: `payday.accountLeftAfterSubscriptions`, `payday.accountAboveBuffer` "{x} above its buffer" / "{x} por encima de su colchón", `accountBelowBuffer`.
- Computed: `planAccountBuffers`, `lib/payday.ts:343-378`, fed by `bufferInputs` (`lib/data/payday.ts:633-654`, subscriptions only).
- Definition: income − the account's outstanding subscriptions − its buffer. Recurring contributions are not subtracted.

**Q51. Suggested and protected buffer**
- Label: `payday.accountSuggestedBuffer` "Suggested buffer" / "Colchón sugerido"; `payday.summaryBuffer` "Protected buffer" / "Colchón protegido".
- Computed: `defaultProtectedBuffer`, `lib/payday.ts:29-36`, per account with typed income > 0 (`:340-353`); total `:398-403`. Stored as `PaydayCheckin.protectedBuffer`; no reader uses it.
- Definition: `max(bufferPercent% of the account's typed income, the floor in the account's currency)`. Afford applies the same formula to projected income for every account with any.

**Q52. "Supports (from your reported balance)" and the reported gap**
- Label: `payday.accountReportedSupports` "Supports (from your reported balance)" / "Alcanza (según tu saldo reportado)"; `accountReportedBelowProjection`.
- Computed: `lib/payday.ts:355-357`.
- Definition: supports = reported + headroom; gap = `max(0, headroom − supports)`, which is `max(0, −reported)`.

**Q53. Reconciliation cap** — `payday.summaryReconciliationCap`; `lib/payday.ts:404-409`; subtracted by `availableForFlexibleCategories` and used to scale the flexible budgets on confirm (`lib/data/payday.ts:1303-1316`): the sum of negative reported balances of accounts with income in this check-in.

### 1.6 Currency

**Q54. Rate table**
- Computed: `getRateTable`, `lib/rates.ts:95-186`; BPD override `lib/bpd-rates.ts:155-194`; entries `toRateTableEntries`, `lib/bpd-rate-payload.ts:121-126`; `convert`, `lib/currency.ts:98-110`.
- Definition: one USD-based row per currency and source, updated in place (no history). open.er-api is fresh for 24h, then stale values, then `FALLBACK_RATES`. A Banco Popular rate up to 7 days old replaces DOP and EUR: DOP = the dollar sell rate, EUR = dollar sell / euro sell, used in both directions.

**Q55. Stored versus display amounts**
- Definition: `Transaction.currency` is whatever the entry path was given: the form, the CSV importer, receipt approval and posting keep the entered or item currency; only opening balances, corrections, check-in paychecks and manual contribution twins are forced into the account's currency. Conversion happens at read time with today's table for balances (account currency) and every total (display). Converted at write time: GoalContribution amounts, manual contribution twins, the Budget rows a check-in writes, and a transfer's received leg.

**Q56. Transfer legs** — `transactions.receivedAmountLabel` "Actual amount received ({code})" / "Monto realmente recibido ({code})", hint "Leave blank to record the same amount on both sides, converted at today's rate."; `transferLegs`, `lib/transactions.ts:201-212`: with the field blank both legs store the entered amount and currency, so one leg is foreign to its account.

**Q57. Shared expense: amount and your share**
- Label: `transactions.yourShareLabel` "Your share ({code})" / "Tu parte ({code})", `sharedBadge`.
- Definition: `ownShare(row) = yourShare ?? amount` (`lib/shared-expense.ts:32-34`). Full amount: balances, budget spent, Reports, the Transactions totals. Own share: category suggestions, the monthly average and pace, the one-off threshold.

**Q58. Reimbursement progress** — `transactions.recoveredSoFar`; `reimbursementProgress`, `lib/shared-expense.ts:76-83`, with `sumReimbursements`, `lib/data/transactions.ts:220-244`: deposits converted into the expense's currency at today's rate; owed = amount − share.

**Q59. Stale rates banner** — `shell.staleRatesTitle`; `components/shell/app-shell.tsx:36-39`: open.er-api freshness only.

### 1.7 Periods and dates

**Q60. Today** — `today()`, `lib/date.ts:96-98`: the civil date in `APP_TIMEZONE` (default America/Santo_Domingo), captured once per request (`lib/data/context.ts:71, 98`). One client default uses the browser's UTC date instead: the cover-transfer dialog (`payday-checkin-dialog.tsx:517`).

**Q61. Current period** — `context.currentPeriod = periodForDate(today)` (`lib/data/context.ts:99`, `lib/period.ts:118-125`): A = 1-15, B = 16 to month end. Used by the hero, Budgets default, Goals page figures, Afford's filing of overdue dates, Reports, the tracker.

**Q62. Plan period** — `planPeriodRef`, `lib/data/payday.ts:220-224`: the next period from the current period's payday until it ends (`isAfterPaydayInPeriod`, `lib/period.ts:112-115`), else the current period. Used by the wizard, the roadmap, "planned this period", the Inbox goal alerts, the forecast and the debt comparator.

**Q63. Payday** — `payDayOfMonth` / `paydayOfPeriod` / `paydayDateFor`, `lib/period.ts:56-100`: the 15th and the month's last day, pulled back to Friday from a weekend; a period's pay lands at the end of the previous period.

**Q64. Days left** — `daysRemainingInPeriod`, `lib/period.ts:187-193` (counts today; the full length before the period starts). Header and hero use the current period; Step 4 uses the plan period.

**Q65. Periods remaining and the goal window** — `periodsRemaining(from, to)` (`lib/period.ts:205-217`: periods whose end is on or before the target, starting with the one containing `from`); `goalPeriodsLeft = max(1, periodsRemaining(plan start, target))` (`:226-228`); `goalWindow` (`:236-244`).

**Q66. Overdue** — `payday.overdueBadge` "Overdue" / "Vencido": `nextDate < max(today, window start)` (`period-summary.ts:321`); `dashboard.overdueNotPosted` "overdue, not posted yet": `nextDate < today` (`lib/data/dashboard.ts:69`).

**Q67. Comparable history walks** — Afford `comparableHistory` (`lib/data/afford.ts:150-171`: starts at the newest same-half period that has ended or is confirmed); suggestions `lib/data/payday.ts:246, 283-289` (starts at the previous same-half period, no has-ended rule); Reports average (`lib/data/reports.ts:109-117`: finished periods ending on or after the first activity); monthly windows (`lib/data/monthly.ts:289-361`: completed months, first month skipped if activity starts after day 7). "Count income history from" (`Settings.incomeHistoryStartDate`) bounds Afford and the suggestions by period (`countsInIncomeHistory`, `lib/payday.ts:21-26`) and the monthly windows by the month containing the date; Reports' per-period average ignores it.

**Q68. Recurring occurrence walks** — `advanceDate` (`lib/recurring.ts:125-149`); `owedOccurrences` (`:213-229`: a `nextDate` before the window's start counts once, then each occurrence in the window, stopping at the countdown); posting walks every occurrence up to today, 24 per run (`lib/recurring-posting.ts:437-486`); `settlementWindow` (`lib/recurring-settlement.ts:146-149`: the due date's period, from 5 days earlier).

### 1.8 Installments and debts

**Q69. Payments left** — `recurring.paymentsLeft`; `RecurringItem.remainingOccurrences`, decremented per posted or settled occurrence (`lib/recurring-posting.ts:229-241`), set to 0 by "Mark as paid off".

**Q70. Afford installment amount and schedule**
- Label: `afford.paymentLabel`, `afford.alreadyPaid` "Already paid" / "Ya pagado", `afford.columnPeriod`, `afford.recordedNote`.
- Computed: `equalInstallmentAmount`, `installmentDates`, `buildInstallments`, `splitPaidInstallments` (`lib/afford.ts:51-115`); `confirmAffordPurchase` (`lib/data/afford.ts:924-953`).
- Definition: equal installments on the first date's day; a date before today is "already paid" and not recorded. The item stores the purchase currency.

**Q71. How an installment enters each total**
- Period summary / Dashboard / Budgets: `owedOccurrences` from `max(today, start)`; backlog once; countdown respected.
- Wizard: the same for the plan period, less occurrences already in the ledger.
- Afford: the current period from its start (posted and settled rows at their own amounts) plus the walk; later periods by due date.
- Tracker: every remaining occurrence, each overdue one in the current period.
- Monthly: posted this month plus the walk from tomorrow, **without the countdown**.
- Subscription room: only for a large item, no countdown input.

**Q72. Debt comparator** (balance, pace, payoff period)
- Label: `goals.debtPace`, `goals.debtNoPace` "No target date: no pace of its own", `goals.debtFlowPerPeriod`, `goals.debtPaidOffIn` "Paid off in period {n} · {date}" / "Saldada en el periodo {n} · {date}", `goals.debtFreeAfter`, `goals.debtNothingFlowing`.
- Computed: `listDebtGoals`, `lib/data/debt-payoff.ts:29-49`; `simulateDebtPayoff` / `compareDebtStrategies`, `lib/debt-payoff.ts:93-166`.
- Definition: balance = Q32 (live); minimum = Q34 for a dated debt, 0 for an undated one; period 1 = the plan period. Installment plans are never debts here.

**Q73. Installment plan re-check window** — see Q11: the tracker judges only the installments from `nextDate` on, so a posted installment of the current period stays counted in Afford's commitments (Q9) rather than being re-judged.

### 1.9 Stored figures that nothing reads

These are displayed nowhere, but they look like the canonical record, so
they are listed to avoid being mistaken for one:

- **Q74.** `PaydayCheckin.totalIncome` (`lib/data/payday.ts:1382`).
- **Q75.** `PaydayCheckin.protectedBuffer` (`:1384`).
- **Q76.** `PaydayAccountSnapshot.difference` and `expectedLedgerBalance` (`:1397, 1432`).
- **Q77.** `PaydayPlanAllocation.recommendedAmount` on rows written before commit `2c5d541` (Sep 8 2026), which held the uncapped roadmap; only plan-period rows are read now, so these are no longer reached.
- **Q78.** `PaydayGoalDraft.periodsLeft` (`lib/data/payday.ts:885`), equal to `goalPeriodsLeft`, rendered by no component.
- **Q79.** `getGoalDetail`'s `nextPeriodStart` (`lib/data/goals.ts:250`), read by no caller.

---

## 2. Divergences

Grouped by family. Each gives the quantities that disagree, the rule each
applies, the reproduction and its numbers, who is affected and in which
direction, severity, confidence and the related finding. "Repro" figures
were produced as described at the top; "pure" means a direct call of a
database-free function.

### Goals

#### D1. The Goals page's "per pay period" counts from today; everything else counts from the plan period
- **Quantities:** Q33 (Goals list, goal detail, Dashboard goal card) against Q34 (wizard, Inbox, forecast, Afford, debt comparator).
- **Rules:** Q33 divides by `periodsRemaining(today, target)` and nets the *current* period's contributions (`lib/data/goals.ts:43, 119-126`). Q34 divides by `goalPeriodsLeft(plan start, target)` and nets the *plan* period's contributions (`lib/data/payday.ts:357-364`).
- **Repro (DB, trace (a)):** on Wed Sep 30, after the Oct 1 contribution, the Goals page shows **2,785.66 × 4 periods** and the wizard **3,714.22 × 3**; before the contribution, 4,178.49 × 4 against the check-in's 5,571.32 × 3. On Fri Nov 13 with a target of Sat Nov 14 the Goals page says "due this period" (Nov 1-15, 3,000) while the wizard puts the whole 3,000 in Nov 16-30, after the target date. With a target of Sep 10 seen on Sep 30, the Goals page says "due this period" (Sep 16-30) while the wizard plans it in Oct 1-15.
- **Who / direction:** every dated goal, from payday to the end of the period (1-3 days each period). The Goals page understates the pace, and "this period" names a different period than "planned this period" on the same card.
- **Severity:** Low (display). **Confidence:** High. **Relates to:** B24.
- **Status (2026-09-30, K1/K2):** removed. `summarize` in `lib/data/goals.ts` counts periods from `periodClock(today).plan.start` and nets the plan period's outstanding contributions (K2). Trace (a) on Sep 30: 3,714.22 × 3 on the Goals page, the same as the roadmap (was 2,785.66 × 4). "due this period" now names the plan period, so the Nov 13 / Nov 14 case reads the period the wizard plans it in; D9 (mid-period target) and D14 (currency path) remain. Harness: "period clock and period commitments (K1 K2)", D1.
- **Status (2026-09-30, K3):** the figures moved again with K3. The Goals page now reads the plan's by-hand figure, fixed at the plan period's start (D2) and counted by payday (D9): trace (a) on Sep 30 reads 4,178.49 x 4 on the Goals page and the roadmap alike.

#### D2. The roadmap still counts the plan period as a period to fund after money was contributed inside it
- **Quantities:** Q34 in all its readers (wizard "Roadmap amount" and "ahead", Inbox, forecast pace, Afford estimate, debt comparator), against what the target still needs.
- **Rules:** Q34 divides live `remaining`, which already subtracts every contribution whatever its date (`lib/goals.ts:316-330`), by the periods from the plan period's start *including* the plan period (`lib/period.ts:226-228`).
- **Repro (DB, trace (a)):** plan Oct 1-15 confirmed at 5,571.32; logging 5,571.32 on Oct 1 drops the Oct 1-15 roadmap to **3,714.22**. The wizard then reads "1,857.10 ahead of the target roadmap"; the forecast asks 3,714.22 of Oct 16-31 and of Nov 1-15, **7,428.44** in total against the **11,142.65** still needed; Afford estimates 3,714.22 in those periods where 5,571.33 is needed (room overstated by 1,857.11 each); the debt comparator pays 3,714.22 in period 1 on top of the contribution. Variant (DB): plan 4,000 against a 5,571.32 roadmap; after the user contributes exactly 4,000 the roadmap becomes 4,237.99 and the goal page says "237.99 behind the roadmap".
- **Who / direction:** anyone who contributes to a dated goal during the period the plan covers. The forecast and Afford under-reserve for the later periods; the wizard reports "ahead" for a user who is exactly on plan.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new (the same mechanism as B13, reached by a manual contribution and by every reader, not only the Goals page).
- **Status (2026-09-30, K3):** removed. `goalPeriodPlan` (`lib/data/goal-plan.ts`, its rules in `lib/goal-plan.ts`) fixes the pace on the period's payday, the day its money is in hand - (target - saved from contributions dated before that payday) / periods left - and a period not yet reached is asked the plan period's pace. Production's trace (a), with the 5,571.32 moved on the Sep 30 payday: Oct 1-15 asks 4,178.49 over 4 periods and holds 5,571.32 planned and contributed, and from the Oct 15 payday each period asks 3,714.22 over 3. Trace (a) with the contribution dated Oct 1 and a target giving the trace's three periods (Nov 12): Oct 1-15 stays 5,571.32 on Oct 5 (was 3,714.22), the re-opened wizard recommends 5,571.32 beside the 5,571.32 held (was "1,857.10 ahead"), the forecast and Afford ask 5,571.32 of Oct 16-31 and Nov 1-15 (was 3,714.22), and from the Oct 15 payday each of them asks 5,571.33. Variant: 4,000 planned and contributed reads "1,571.32 behind" (was 237.99). Harness: "a goal's period plan (K3)", D2 and the user's case.

#### D3. "Planned" is never compared with "contributed"
- **Quantities:** Q35 "planned this period", Q36 behind, Inbox `goal_behind`, against Q38 contributions in the period.
- **Rules:** every goal status reads only the check-in's GOAL rows (`lib/data/payday.ts:465-539`; `goals/page.tsx:41-64`); `detectGoalsBehind` compares them with Q34 (`lib/insights.ts:332-374`). No reader looks at contributions dated in the period.
- **Repro (DB):** Oct 1-15 confirmed with 5,000 planned for a 30,000 goal due Dec 31 and nothing contributed: on Oct 1 and on Oct 14 the roadmap is 5,000, planned 5,000, saved 0, and **no `goal_behind` insight**. In trace (a), where the planned money *was* contributed, the Goals page keeps saying "5,571.32 planned this period".
- **Who / direction:** every goal with a confirmed plan. A plan that was not carried out is never flagged; one that was carried out is still shown as a plan.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K3):** removed. The plan carries `planned` and `contributed` side by side - contributed counting from the period's payday up to the next period's, so money moved on payday for the period being planned is that period's ("Oct 1-15: 5,000.00 planned · 0.00 contributed" on the Goals list, detail and Dashboard card), and the Inbox has a second statement, "planned but not yet contributed", raised in the last `FOLLOW_THROUGH_ALERT_DAYS` (3) of the period or once it has ended: the repro is flagged on Oct 13 and Oct 16 for 5,000, and not on Oct 1 or Oct 12.

#### D4. A recurring contribution that posts mid-period raises the roadmap and triggers a false "behind"
- **Quantities:** Q34 for the plan period, Q36.
- **Rules:** Q34 nets the plan period's contributions from `getPeriodSummary(plan)`, which counts occurrences from today (`period-summary.ts:304`); once one posts it leaves that list, and `remaining` has dropped by less than the netting removed.
- **Repro (DB):** goal 30,000 due Dec 31 with a 2,000 contribution on Oct 10; plan Oct 1-15 confirmed at the roadmap, 3,000. On Oct 9: roadmap 3,000, no alert. On Oct 10 after posting: saved 2,000, roadmap **4,666.67**, "behind by **1,666.67**" in the Inbox; the Goals page per period rises from 3,000 to 4,666.67.
- **Who / direction:** goals fed by recurring contributions. A false alert every period the contribution posts.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B13.
- **Status (2026-09-30, K3):** removed. The pace no longer moves when the contribution posts, and the plan period's own scheduled contributions are whole (posted ones included). Repro (target Dec 30 so the map's six periods hold under D9): 3,000 by hand before and after the Oct 10 posting (was 4,666.67), no "behind" insight (was 1,666.67).

#### D5. The pace net of the plan period's contributions is repeated in every later period
- **Quantities:** Q39 forecast pace, Q40 Afford estimate, against each period's own scheduled contributions.
- **Rules:** Q34 is taken once, net of the plan period's due contributions (`lib/data/payday.ts:402-411`), and applied to every period of the window (`lib/data/afford.ts:726-737`; `lib/goal-forecast.ts:30`), while each period's real contributions are also counted in Afford's commitments (`:429-440`).
- **Repro (DB, same goal as D4):** on Sep 30 the forecast asks 3,000 of every period Oct 16-31 … Dec 16-31, although the B periods have no contribution (they need 5,000). After the Oct 10 posting every period becomes 4,666.67.
- **Who / direction:** goals with a monthly contribution; the A and B periods are misjudged in opposite directions.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B11.
- **Status (2026-09-30, K3):** removed. The forecast and Afford ask each period its own by-hand figure, the pace less that period's own recurring contributions: 5,000 in the B periods and 3,000 in the A periods, before and after the posting (was 3,000, then 4,666.67, everywhere).

#### D6. The debt comparator uses the net, live roadmap as each debt's minimum
- **Quantities:** Q72 against Q33 and against the real payments.
- **Rules:** `minimum = pace.amount` for a dated debt (`lib/data/debt-payoff.ts:44`), net of recurring contributions that the simulation never adds back; period 1 is the plan period while the balance already nets that period's contributions.
- **Repro (DB):** car loan 12,000 and card 3,000, both fed by recurring contributions (4,000 and 1,000) due in the plan period: minimums **0 and 0**, flow 0, no payoff under either order. Trace (a) marked as a debt: the Goals card says 2,785.66 per pay period and the comparator on the same page says **3,714.22** "per pay period on its own", paid off in period 3 counting a second payment in Oct 1-15.
- **Who / direction:** users with two or more debts. Payoff times are overstated (up to never) when contributions fund the debts, and a phantom payment is counted when a contribution already went in.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B12, plus new (period 1 paid twice).
- **Status (2026-09-30, K3):** removed. The comparator's minimum is the gross pace, with what already went in during the plan period (period 1) passed beside it and the debt's target period asking whatever is left. Repro (both due Sun Nov 15): minimums 3,000 and 750, 3,750 a period, both paid off in period 4 (was 0 and 0, never). Trace (a) as a debt: minimum 4,178.49 with 5,571.32 already paid, paid off in period 4 (was 3,714.22, period 3 counting a second Oct 1-15 payment).

#### D7. Items that will never post are still committed and still net the pace
- **Quantities:** Q7, Q8, Q33, Q34 against posting and Q9.
- **Rules:** `getPeriodSummary`, the wizard and `loadDueContributionsByGoal` include contributions to an achieved goal and items with no account (`period-summary.ts:150-154`; `lib/data/goals.ts:25-41`); posting skips both (`skipReasonFor`); Afford drops only the achieved-goal case (`lib/data/afford.ts:430`).
- **Repro (DB):** a 200 contribution to an achieved goal: Oct 1-15 committed **200**, the wizard reserves 200, Afford **0**, posting reports `goal_achieved`. A 100 contribution with no account to a 1,200 goal due Dec 31: roadmap and Goals page **100** where 200 is needed; posting reports `missing_account`.
- **Who / direction:** the plan under-allocates flexible money by charges that will never leave; the pace understates what the goal needs.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B14.
- **Status (2026-09-30, K1/K2):** removed. An item `skipReasonFor` skips is `wont_post` in K2: out of Committed, the check-in, Afford, the room check, the monthly pace and the goal netting, and listed with its reason in Step 3 ("Not counted: posting will skip these"), in Next 7 days and as a count on the Budgets page. Repro: Oct 1-15 committed 0 (was 300), the check-in reserves 0 (was 300), the 1,200 goal's pace 200 on the Goals page and roadmap (was 171.43 and 100), Afford 0 (was 100). `dashboard.notPostingDescription` ("missing from your committed total") is now true.

#### D8. A goal the accounts had no room for is never flagged
- **Quantities:** Q36 / Inbox `goal_behind` against Q34.
- **Rules:** confirm drops a GOAL row whose planned and recommended amounts are both 0 (`lib/data/payday.ts:1269`); the status then has `planned = null` and both the page and the detector skip it (`lib/insights.ts:335`).
- **Repro (DB):** income 1,500 against a 2,000 floor, so no room; planned 0: `planned = null`, roadmap 4,237.99, **no insight**. With room, a planned 0 is flagged (200 behind), so this is now limited to the no-room case.
- **Who / direction:** exactly the goals in the worst shape get no signal.
- **Severity:** Low. **Confidence:** High. **Relates to:** B29 (narrowed).
- **Status (2026-09-30, K3):** removed. A confirmed period with no GOAL row for a goal reads `planned = 0`, so the planning statement flags it: the repro reads 0 planned, 5,000 behind, 5,000 beyond the room, and the Inbox raises it (was `planned = null`, no insight).

#### D9. A target date in the middle of a period drops that period, although its pay arrives before the target
- **Quantities:** Q65 in Q33, Q34, Q39, Q40.
- **Rules:** `periodsRemaining` counts periods whose end is on or before the target (`lib/period.ts:205-217`).
- **Repro (pure):** plan Sep 16, target Oct 14 → 1 period (Oct 15 → 2). On Oct 2, target Oct 20 → 1, though Oct 16-31's pay lands Oct 15. On Oct 2 with target Oct 14 the Goals page counts 0 and the roadmap 1.
- **Who / direction:** goals dated mid-period; the pace is overstated.
- **Severity:** Low. **Confidence:** Medium (the rule is documented). **Relates to:** B43.
- **Status (2026-09-30, K3):** removed, by decision: `periodsRemaining` counts a period when its pay (`paydayDateFor`) lands on or before the target date. Plan Sep 16 / target Oct 14: 2 (was 1); target Oct 15: 3 (was 2); Oct 2 / Oct 20: 2 (was 1); the Goals page and the roadmap both read 1 period on Oct 2 for Oct 14 (was 0 and 1). This also moves every target on a period boundary: a Dec 31 target now includes Jan 1-15 (paid Dec 31), and trace (a)'s Sun Nov 15 includes Nov 16-30 (paid Fri Nov 13), four periods instead of three.

#### D10. Afford's goal window is not the roadmap's window, and the forecast skips a period Afford estimates
- **Quantities:** Q40 against Q34's count and Q39.
- **Rules:** Afford adds the current period to the window when it precedes the plan period (`lib/data/afford.ts:674-676`) with a pace computed over `goalPeriodsLeft` periods; the forecast starts at the plan period (`lib/data/goal-forecast.ts:57-63`).
- **Repro (DB):** today Sep 30, no confirmed check-ins, 11,142.65 due Nov 15: Afford estimates 3,714.22 in each of Sep 16-30, Oct 1-15, Oct 16-31 and Nov 1-15, **14,856.88** for a goal that needs 11,142.65. On Fri Oct 30 Afford carries a 3,000 estimate in Oct 16-31 while the forecast walks only Nov 1-15 onward.
- **Who / direction:** purchases judged in the 1-3 days between payday and period end; that period's room is understated by one pace (conservative).
- **Severity:** Low. **Confidence:** High (the code comment calls the extra period deliberate). **Relates to:** B34 (introduced by its fix).
- **Status (2026-09-30, K3):** removed. Afford's goal window is `goalWindow` from the plan period, like the roadmap and the forecast; today's period from payday to its end is no longer estimated (this deliberately removes the current-period estimate B34 added). Repro: 11,142.65 due Nov 15 is estimated in Oct 1-15 to Nov 16-30 at 2,785.66, 11,142.64 in all (was four periods from Sep 16-30 at 3,714.22, 14,856.88); on Oct 30 Oct 16-31 carries no estimate.

#### D11. "Room couldn't cover" mixes today's roadmap with the room recorded at confirm time
- **Quantities:** Q36 room shortfall.
- **Rules:** `roadmap(live) − Σ recommendedAmount(stored at confirm)` (`goals/[id]/page.tsx:202-207`; `lib/insights.ts:338`).
- **Repro (DB):** confirm-time room 4,000 against a 5,571.32 roadmap: shortfall 1,571.32. After the user contributes the 4,000 the page says **237.99** couldn't be covered: neither the confirm-time figure nor a current one.
- **Severity:** Low. **Confidence:** High. **Relates to:** new (inherits D2/D4).
- **Status (2026-09-30, K3):** removed. Both sides are fixed for the period: the note is byHand less the room recorded at confirm, and reads 1,571.32 before and after the 4,000 goes in (was 237.99 after).

#### D12. When a goal is completed mid-period, the confirmed card forgets its plan and Afford keeps it
- **Quantities:** Q23 on the Dashboard card against Q9 / Q25.
- **Rules:** the rebuilt draft keeps only goals not achieved with something left (`lib/data/payday.ts:877-878`); Afford adds every confirmed GOAL row (`lib/data/afford.ts:441-448`).
- **Repro (DB):** Oct 1-15 confirmed with 5,000 for a 5,000 goal; the card reads 49,000 available. After the 5,000 is logged and the goal is achieved, the card reads **54,000**; Afford still counts 5,000 committed.
- **Who / direction:** the card overstates flexible money by the finished goal's plan.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K1/K2):** counting half removed. A goal reached since the plan was confirmed keeps its confirmed GOAL rows in the rebuilt draft (`reachedGoals`), read-only, counted in the goal plan and taken from the pool first; confirm writes them back unchanged. Repro: the card reads 49,000 before and after (was 54,000), as Afford counts the 5,000. The card still rebuilds its other figures from live data (D32, K4).

#### D13. An undated goal's "pace" means four things, and its average divides by the period in progress
- **Quantities:** Q41 against Q34 and Q72.
- **Rules:** Goals page: saved / periods since the first contribution including the current one (`lib/data/goals.ts:132-151, 181-190`); wizard: the whole remaining balance (`lib/data/payday.ts:362`); comparator: 0, "no pace of its own" (`lib/data/debt-payoff.ts:44`); Afford and the Inbox: nothing.
- **Repro (DB):** an undated 10,000 debt with 1,000 contributed on Sep 5, seen Oct 20: Goals page pace **250** per period, done around Apr 30 2028; wizard recommends **9,000**; comparator minimum **0**. One 1,000 contribution on Sep 2: pace 1,000 on Sep 15 and **500** on Sep 16, and the projected end moves from Jan 31 to Jun 30 2027 overnight.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K3):** removed. The pace (K3) of an undated goal is its remaining balance at the period's start, asked of the plan period only (the wizard), and never repeated as a per-period figure (Afford, the forecast and the comparator give it none, the planning statement does not judge it). The Goals page's history figure is labelled for what it is, "Average so far" / "Promedio hasta ahora" (was "Pace" / "Ritmo"), and divides by the completed periods since the first contribution: 333.33 on Oct 20 (was 250), and 1,000 on both Sep 15 and Sep 16 (was 500 overnight).

#### D14. The two goal paces convert currency along different paths
- **Quantities:** Q33 against Q34 for a goal in another currency.
- **Rules:** Q33 computes in the goal's currency, rounds, then converts (`lib/data/goals.ts:126, 176`); Q34 divides the already converted remaining (`lib/data/payday.ts:363`).
- **Repro (DB):** a 1,000 USD goal due Dec 31 on DOP display, Oct 1 (current = plan period): Goals page **10,000.20**, wizard **10,000.00**.
- **Severity:** Very low. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K3):** removed. Every goal figure comes from one plan computed in the display currency from the unrounded remainder; the Goals page and the wizard both read 8,571.43 for 1,000 USD due Dec 31 (was 10,000.20 against 10,000.00; seven periods since D9).

### Committed, income, spent and budgets

#### D15. The check-in and the period summary count commitments from today; Afford counts the whole period
- **Quantities:** Q8 and Q23 (Step 3, the confirmed card, "Recommended"), Q7, against Q9 / Q25.
- **Rules:** `owedFrom = max(today, period start)` (`period-summary.ts:304`), so anything that posted since the period began is gone from the plan period's commitments, while income is the whole paycheck; Afford counts the current period's posted and settled rows plus what is ahead (`lib/data/afford.ts:395-428`, the B1 fix).
- **Repro (DB):**
  - Late check-in: rent 20,000 posted Oct 1, check-in opened Sat Oct 3 for Oct 1-15 with a 60,000 paycheck: Step 3 lists no rent and reads **54,000** (60,000 − 6,000 buffer); Afford reads **34,000** for the same period.
  - Confirmed card drift (trace (b)): 43,400 on Oct 1, **46,000** on Oct 11 once Netflix and the contribution posted. The card is always shown once confirmed.
  - Trace (c): after the first Klarna payment posts, the Oct 16-31 wizard lists no installment while Afford counts it.
- **Who / direction:** any check-in opened after its period started (the Budgets page allows it), and every confirmed card. A late plan writes flexible budgets overstated by every charge already posted.
- **Severity:** High. **Confidence:** High. **Relates to:** B38 and the check-in side of B1 (new).
- **Status (2026-09-30, K1/K2):** removed. The wizard, confirm, the confirmed card and "Recommended" count K2's `whole` (posted and settled occurrences at the ledger's amount plus outstanding); Committed shows `outstanding`. Late check-in: 34,000 (was 54,000), Afford 20,000 committed, the same. Trace (b): 43,400 on Oct 1 and on Oct 11 (was 46,000 on Oct 11); Budgets "Committed" 2,600 then 0. Afford's own "Available" (34,400 in trace (b)) still differs by income and buffer: D17, K4. Until K6 (D20), a subscription paid by a charge the user entered is now both reserved by the plan and counted in budget spending.

#### D16. A future period counts every item due before it starts as "overdue" in it
- **Quantities:** Q7 and Q8 for any period after the current one, against Q9 and against the current period's own Q7.
- **Rules:** `owedOccurrences` adds `nextDate` once whenever it is before the window's start (`lib/recurring.ts:218-219`), even when that date is still in the future; the period summary and the wizard use windows starting at the period's start. Afford files by due date.
- **Repro (DB):** Netflix 600 due Oct 5, viewed on Oct 2: Oct 1-15 committed 600; **Oct 16-31 committed 600** (flagged overdue, no occurrence in that period; Afford 0); **Nov 1-15 committed 1,200** (Afford 600). The Budgets-page wizard for those periods reserves the same amounts. Weekend case: on Fri Nov 13, a 50 item due Sat Nov 14 is committed in Nov 1-15 and again, "Overdue", in Nov 16-30. An item due Sat Oct 31 is listed in both the Oct 16-31 plan and, "Overdue", in the Nov 1-15 plan opened on Fri Oct 30.
- **Who / direction:** every check-in on a Friday payday before a weekend period end, and every plan or Budgets view of a period after the current one. Flexible money is understated (conservative), items are called overdue before they are due.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B23, generalized (new: any future period, not only the weekend gap).
- **Status (2026-09-30, K1/K2):** removed. Only a genuine backlog (due before today) is filed in the current period. Repro on Oct 2: 600 / 0 / 600 for Oct 1-15, Oct 16-31, Nov 1-15 (was 600 / 600 / 1,200); the Oct 16-31 wizard reserves 0 (was 600); on Fri Nov 13 the Sat Nov 14 item is not in the Nov 16-30 plan (was listed "Overdue"). `owedOccurrences` keeps its old branch for its remaining callers (the posting preview, the audit), which pass `from = nextDate`.

#### D17. Afford's "Available for flexible categories" for a confirmed period ignores the period's confirmed income, buffer and carryover
- **Quantities:** Q25 against Q23, same label, same period.
- **Rules:** Afford's income is the history average whose walk starts before the evaluated period (`lib/data/afford.ts:156`), its buffer is on that average, carryover is 0, no cap (`lib/afford.ts:436-444`); it does read the period's GOAL rows (`lib/data/afford.ts:441-448`).
- **Repro (DB, trace (b)):** Oct 1-15 confirmed with a 60,000 paycheck against a 50,000 history: Step 3 **43,400**, Afford **34,400** (income −10,000, buffer +1,000).
- **Who / direction:** anyone whose paycheck differs from the average, judging a purchase in a confirmed period; either direction.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new (extends B7's shared label).

#### D18. A bonus typed into a check-in becomes Afford income for six periods; logged as one-off it does not
- **Quantities:** Q6 (and through it Q10, Q11, Q39) against Q3 and the one-off flag.
- **Rules:** snapshots are added to Afford's history unconditionally (`lib/data/afford.ts:273-275`) while `isOneOffIncome` rows are dropped (`:253`); the check-in has no one-off switch and its paycheck row cannot be marked one-off (`lib/transactions.ts:149`).
- **Repro (DB):** B-period pay 60,000; Dec 16-31 checked in at 120,000: Afford projects **70,000** (buffer 7,000) for Jan 16-31. The same bonus as a separate one-off row: **60,000** (buffer 6,000).
- **Who / direction:** anyone paid a 13th salary or bonus through the check-in; Afford, the room check and the tracker overstate room.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new.

#### D19. Afford keeps a buffer floor for every account with any income; the check-in only for accounts with income typed
- **Quantities:** Q25's buffer against Q51.
- **Rules:** `lib/data/afford.ts:772-774` against `lib/payday.ts:340-353`.
- **Repro (DB):** a savings account earning 150 a period beside a 60,000 salary: Step 3 buffer **6,000**, Afford buffer **8,000** (income 60,150).
- **Severity:** Low. **Confidence:** High. **Relates to:** new.

#### D20. A charge the user entered that settles a subscription counts as budget spending; posting's own row for it does not
- **Quantities:** Q16, Q20, Q26, Q27 against Q8's reservation and Q13.
- **Rules:** `outsideBudget` excludes RECURRING rows and charges settled for a CONTRIBUTION, not those settled for a SUBSCRIPTION (`period-summary.ts:256-261, 293`); the monthly pace treats any settled charge as committed.
- **Repro (DB):** Oct 1-15 confirmed with Netflix 600 reserved. The user enters "Fict Netflix" 600 under Entertainment on Oct 5; posting settles the occurrence with it. Spent **600**, safe to spend **15,400**. Same period with posting writing the row: spent 0, safe to spend **16,000**.
- **Who / direction:** users who import or type subscription charges before posting runs. The charge is subtracted twice from the plan and inflates the next suggestion.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new (the subscription twin of the contribution-settlement fix in B16).
- **Status (2026-09-30, K6 settled-charge part only):** the settled-charge part is done; the rest of K6 is not. Every row that stands for a recurring occurrence - a RECURRING row, or a charge that settled an occurrence (RecurringSettlement, either kind) - is left out of budget spending by `outsideBudget` in `getPeriodSummary`, and the Budgets page's category rows read `CategoryLine.spentExcludingOccurrences`, the same test, so they agree with the overall "spent" for these rows (Reports keeps the factual `spent`). Repro: spent 0 and safe to spend 16,000 (was 600 and 15,400), the same as when posting writes the row; the carryover offered to Oct 16-31 is 16,000 (was 15,400); the plan reserves the 600 once and budget spending takes none of it. The category suggestion (Q27) now averages `spentExcludingOccurrences` too, so a settled charge no longer raises the next suggestion (repro: 1,000, was 1,600). D21's other rows, D22, D30 and D31 are untouched.

#### D21. The Budgets page's category rows count recurring charges; its overall "spent" does not
- **Quantities:** Q18 against Q16 on one page.
- **Rules:** `spentByCategory` keeps RECURRING rows (`period-summary.ts:274-281`); `spent` drops them (`:293`).
- **Repro (DB):** Netflix 1,000 posted under Entertainment with a 5,000 budget: the Entertainment row reads **1,000 of 5,000**; overall spent **0**, safe to spend 5,000.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.

#### D22. Shared expenses: suggestions and the monthly average use your share; budgets and the Reports average use the full amount
- **Quantities:** Q27 and Q29 against Q16, Q20, Q17.
- **Rules:** suggestions subtract others' share (`lib/data/payday.ts:310-316`), the monthly average reads own share (`lib/data/monthly.ts:563-588`); budget spent and Reports read the full amount; a reimbursement is income, never an offset.
- **Repro (DB):** Dining history of 16,000 dinners with a 10,000 share: suggestion **10,000**. A 16,000 dinner (share 10,000) with 6,000 paid back: spent **16,000**, safe to spend **−6,000**, income +6,000. On the Reports page, shared 3,000 dinners (share 1,000) twice a month: per-period average **3,000**, monthly average **2,000** (own share).
- **Who / direction:** anyone who fronts shared costs; the budget shows as overspent although own cost matched the plan, and the two averages on one page disagree.
- **Severity:** Low. **Confidence:** High. **Relates to:** new (the full amount in budgets is documented; the mismatch with the suggestion basis is not).

#### D23. Step 4's "Estimated safe to spend per day" is unallocated money, and that money then disappears
- **Quantities:** Q24 against Q20.
- **Rules:** `max(0, available − allocated) / days` (`step-flexible.tsx:33-34`) against `max(0, budget − spent) / days` (`period-summary.ts:335-338`); the unallocated remainder is written to no Budget row.
- **Repro (DB, trace (b)):** Step 4 **2,160/day** (32,400 unallocated / 15); the Dashboard next day **1,066.67/day** (16,000 / 15). The 32,400 appears on no later screen and cannot reach the next carryover.
- **Severity:** Low. **Confidence:** High. **Relates to:** B39, plus new (the unallocated money is dropped).

#### D24. "Recommended" is hidden as soon as any category budget exists, so an essentials-only plan makes "safe to spend" the essentials
- **Quantities:** Q21 and Q20 against Q23.
- **Rules:** computed whenever there is no overall budget (`page.tsx:54-59`), rendered only when there is no budget at all (`period-hero.tsx:67`); confirm writes a row for every category.
- **Repro (DB):** Oct 1-15 confirmed with Bills (essential) 4,000 and every flexible row 0; 3,000 spent on Groceries: Step 3 **50,000** available; the hero shows **1,000** left, 71.43/day, and no "Recommended".
- **Who / direction:** first check-ins with no history (no suggestions) where only essentials were typed; safe to spend is understated by the whole flexible amount.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new.

#### D25. "Committed" counts an occurrence the check-in already treats as paid
- **Quantities:** Q7 against Q8.
- **Rules:** Q8 subtracts occurrences the settlement plan already pairs (`lib/data/payday.ts:593-630`); Q7 subtracts nothing.
- **Repro (DB):** Phone 2,000 due Oct 17, a CSV row for it on Oct 14. On Oct 16 Step 3 shows the Phone as already paid (0); the Dashboard's committed is **2,000** (Afford 2,000) until posting settles it on Oct 17.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K1/K2):** removed. An occurrence posting's settlement plan already pairs is `settled`, so it leaves Committed and Next 7 days as soon as the charge is entered. Repro on Oct 16: Step 3 paid, Committed 0 (was 2,000), Next 7 days no longer lists it.

#### D26. Period income depends on the screen: planned period, date, or estimate
- **Quantities:** Q1, Q5, Q6.
- **Rules:** Q1 moves check-in paychecks to their planned period; Q5 reads every row by date; other paychecks count by date everywhere.
- **Repro (DB):** Oct 1-15 checked in at 60,000 (Sep 30) and the Oct 15 paycheck imported by CSV: Oct 1-15 income **120,000**, Oct 16-31 **0**. Oct 16-31 checked in on Oct 15: the Transactions page filtered to Oct 1-15 shows **60,000 in**, the Dashboard/Reports Oct 1-15 income **0**.
- **Who / direction:** users who mix check-ins with imported paychecks; per-half figures and Afford's same-half averages shift.
- **Severity:** Low. **Confidence:** High. **Relates to:** new (the case U4 asked for).

#### D27. Carryover is taken from a period that is still spendable
- **Quantities:** Q26 against Q20 of the ending period.
- **Rules:** `getAvailableCarryover` reads the previous period's safe to spend at draft time (`lib/data/payday.ts:550-557`).
- **Repro (DB):** Nov 1-15 budget 20,000 with 12,000 spent; on Fri Nov 13 the Nov 16-30 draft includes **8,000** carryover while the Dashboard still offers the same 8,000 over 3 days (2,666.67/day).
- **Severity:** Medium. **Confidence:** High. **Relates to:** B21.

#### D28. The check-in's per-account room ignores recurring contributions; Afford's does not
- **Quantities:** Q50 / Q37 against Q25's account check.
- **Rules:** `bufferInputs` passes subscriptions only (`lib/data/payday.ts:633-654`).
- **Repro (DB):** account A: 50,000 income, a 10,000 subscription and a 20,000 recurring contribution; account B: 20,000 income; goal Y roadmap 30,000. Confirm recommends **A 19,811.32 / B 10,188.68**, leaving A at 188.68 against a 5,000 buffer; Afford counts **30,000** committed on A.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B9.
- **Status (2026-09-30, K1/K2):** removed. Step 3's per-account room (`commitmentPortions`, `AccountBufferPlan.commitmentsTotal`) takes each account's subscriptions and recurring contributions, posted and paid ones on the account they left. Repro: goal Y recommended A 13,636.36 / B 16,363.64 (was 19,811.32 / 10,188.68); A's room 15,000 after the 30,000 Afford counts.

#### D29. Category suggestions average a comparable period that has not ended
- **Quantities:** Q27 against Q6's history rule.
- **Rules:** the suggestion walk starts at the previous same-half period with no has-ended rule (`lib/data/payday.ts:246, 283-289`).
- **Repro (DB):** planning Oct 1-15 on Sep 3 averages Sep 1-15 (30 spent in two days) as a full period: **255** where the complete periods give 300.
- **Severity:** Low. **Confidence:** High. **Relates to:** B35.

#### D30. The suggestion's divisor counts periods whose only spending was recurring; its numerator leaves them out
- **Quantities:** Q27.
- **Rules:** numerator `spentExcludingRecurring…` (`lib/data/payday.ts:310-316`), divisor counts periods with `spent > 0` (`:317-319`).
- **Repro (DB):** Entertainment with only a posted Netflix for five periods and 3,000 of own spending in the sixth: **500**; the same own spending without Netflix: **3,000**.
- **Severity:** Low. **Confidence:** High (the comment calls it intended). **Relates to:** new.

#### D31. A one-time purchase filed under "Subscriptions" is lifestyle spending in the monthly pace and outside the budget
- **Quantities:** Q29 against Q16.
- **Repro (DB):** 4,000 on Oct 3 under Subscriptions: period spent **0** (total 4,000); monthly lifestyle so far **4,000**, projected **20,666.67** for October.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.

#### D32. The confirmed card is recomputed at today's rates and today's buffer setting; the budgets it wrote are fixed
- **Quantities:** Q4, Q23 on the card, Q51, against Q19.
- **Rules:** `summarizePaydayDraft(draft, context.rates)` over a new draft that reads Settings now (`lib/data/payday.ts:866-872`); `PaydayCheckin.totalIncome` and `protectedBuffer` are never read.
- **Repro (DB):** a 1,000 USD paycheck confirmed at 60 with a 20,000 Groceries budget, DOP display. At 62: hero income **62,000**, card income 62,000, card available **55,800** (was 54,000), budget still 20,000. Changing the buffer to 15% in Settings: card available **51,000**, buffer 9,000, with no re-confirm.
- **Severity:** Low. **Confidence:** High. **Relates to:** B38 (currency side), new (settings side).

#### D33. "Count income history from" bounds periods in one place, months in another, and nothing in Reports' per-period average
- **Quantities:** Q6 and Q27 (by period), Q29 (by month), Q17's average (unbounded).
- **Rules:** `countsInIncomeHistory` drops a period that ended before the date (`lib/payday.ts:21-26`); the monthly windows start at the month containing the date (`lib/data/monthly.ts:359`); `averageOfCompletedPeriods` never reads it (`lib/data/reports.ts:109-117`).
- **Repro (DB):** date Aug 20: Afford's walk for Oct 1-15 keeps only Sep 1-15 (Aug 1-15 dropped); the monthly windows are Aug 1 and Sep 1 (August's first 19 days included), 2 months, so "not enough history"; the Reports per-period average stays **13,000 over 5 periods** with or without the date.
- **Severity:** Low. **Confidence:** High. **Relates to:** new. See decision 5.2.

#### D34. The first, partial period counts as a whole one in Reports and not in the monthly average
- **Quantities:** Q17's average against Q29.
- **Repro (DB):** first activity Jun 14 (1,000), then 8,000 a period: Reports average **7,125 over 8 periods** (June 1-15 with two days counted as a period); the monthly average drops June and reads **16,000** over 3 months.
- **Severity:** Low. **Confidence:** High. **Relates to:** new (B30 fixed the monthly side, B33 the in-progress side).

### Balances, currency and shared expenses

#### D35. Rows in another currency are re-converted at today's rate by every reader, while the bank fixed them once
- **Quantities:** Q42, Q44, Q47, Q49, Q13, Q56 against the bank balance.
- **Rules:** posting writes the item's currency (`lib/recurring-posting.ts:283-295`); a blank-received transfer keeps the sent currency on both legs (`lib/transactions.ts:201-213`); balances convert at read time (`lib/data/accounts.ts:84-94`).
- **Repro (DB, trace (d)):** 15 USD posted to a DOP account, bank charged 918: ledger **19,100 / 19,082 / 19,070** at 60 / 61.2 / 62 against the bank's fixed 19,082; Step 1's difference goes from −18 to +12; the monthly "committed so far" reads 900 / 918 / 930. A 100 USD transfer into a DOP account with the received amount blank: **6,050** at 60.5 and **6,120** at 61.2.
- **Who / direction:** accounts holding foreign rows (card subscriptions, installments, transfers). The balance drifts with the rate. It does not reach the plan's cap unless the reported balance is negative (see D40), contrary to what B19 says.
- **Severity:** Medium. **Confidence:** High. **Relates to:** B19.

#### D36. A goal counts a contribution at one rate while the ledger reads it at today's, and an edit re-converts the ledger half
- **Quantities:** Q30 against Q42 and Q13's savings figure.
- **Rules:** GoalContribution is converted once at posting (`lib/recurring-posting.ts:305-308`); the RECURRING row stays in the item currency; manual edits re-convert the twin at today's rate (`lib/goals.ts:160-166, 220-233`).
- **Repro (DB):** a recurring 100 USD contribution from a DOP account into a DOP goal, posted with the stored rate at 58.5: the goal counts **5,850**; once the rate is 60.2 the account shows −**6,020** and the monthly savings **6,020** for the same occurrence. A 100 USD manual contribution from a DOP account logged at 58.5 (twin 5,850 DOP): a date-only edit at 60.2 rewrites the twin to **6,020** while the goal keeps 100 USD.
- **Severity:** Low. **Confidence:** High. **Relates to:** B25, new (posting side).

#### D37. A reimbursement's "pending" floats with the rate
- **Quantities:** Q58.
- **Repro (pure):** a 90 USD expense with a 30 share, 3,600 DOP paid back: settled at 60; **2.86 USD pending** at 63, and the expense is offered again in the picker.
- **Severity:** Very low. **Confidence:** High. **Relates to:** new.

#### D38. A charge settles a recurring occurrence only in the same currency; the duplicate check converts
- **Quantities:** "already paid" (posting, Q8) against the posted-duplicate prompt.
- **Rules:** `chargeMatchesItem` refuses a different currency (`lib/recurring-settlement.ts:124, 206`); `planPostedDuplicates` converts with a 3% tolerance (`:250, 389-399`) but runs only when a row is saved after posting.
- **Repro (DB):** a 15 USD item due Oct 5 on a DOP account; the user enters 907.50 DOP "Fict Netflix" on Oct 3. Posting on Oct 5: **0 settlements**, the ledger holds **907.50 DOP and 15 USD**. The same with the item in DOP: 1 settlement, no RECURRING row.
- **Who / direction:** foreign-currency subscriptions and installments whose local charge is recorded before the due date; the money is counted twice.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new (the currency case of B2/B10/B5).

#### D39. A hand-logged contribution in another currency does not settle its recurring occurrence, so it posts again
- **Quantities:** Q30, Q42.
- **Rules:** the twin is in the account's currency (`lib/goals.ts:50, 68`); the settlement branch needs the item's currency (`lib/recurring-settlement.ts:202-208`).
- **Repro (DB):** a recurring 100 USD contribution from a DOP account to a USD goal due Oct 10; the user logs the 100 USD by hand on Oct 8. After posting: goal saved **200 USD**; ledger 6,000 DOP and 100 USD.
- **Severity:** Medium. **Confidence:** High. **Relates to:** new.

#### D40. "Reconciliation" is two unrelated figures: the Step 1 difference caps nothing, a negative reported balance caps everything
- **Quantities:** Q49 against Q52/Q53.
- **Rules:** Q49 is computed and stored but not read; the cap reduces to `max(0, −reported)` (`lib/payday.ts:355-357`) and never reads the ledger.
- **Repro (DB):** ledger 49,082: reported 49,082 → difference 0, cap 0; reported **40,000** → difference −9,082, **cap 0**; reported **−300** → cap **300**.
- **Severity:** Low. **Confidence:** High. **Relates to:** new. See decision 5.1.

#### D41. Step 1's ledger already holds the period's spending, so a late first check-in is capped by it and charged for it again
- **Quantities:** Q47, Q48, Q53 against Q16.
- **Rules:** `ledgerBefore` removes only this check-in's paycheck (`lib/data/payday.ts:565-574`) and pre-fills the reported balance with it (`:834`); the copy says it is the balance before this period's income.
- **Repro (DB):** balance 1,000 before pay, 5,000 of groceries on Oct 1, check-in on Oct 3: pre-filled reported **−4,000**; confirm scales the flexible budgets from 45,000 to **41,000**; the 5,000 also counts as spent, safe to spend **36,000**.
- **Severity:** Medium. **Confidence:** High (it relies on the user accepting the pre-fill). **Relates to:** new (the case U9 names).

#### D42. Balances and "saved" include rows dated in the future
- **Quantities:** Q42, Q47, Q30.
- **Repro (DB):** a rent row dated Nov 1 lowers the Oct 15 balance and Step 1 ledger to **30,000**. In trace (a) a contribution dated Oct 1 is in "saved" on Sep 30.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.

#### D43. The bank's sell rate is used in both directions
- **Quantities:** Q54 in every conversion.
- **Repro (pure):** BPD buy 59.80 / sell 61.20: 1,000 USD income shows as **61,200 DOP** (the buy side would give 59,800).
- **Severity:** Low. **Confidence:** High. **Relates to:** B44.

### Periods, installments and debts

#### D44. An overdue installment backlog counts once in commitments and once per installment in the tracker
- **Repro (pure):** 5 payments left, `nextDate` Jul 10, today Sep 28: commitments Jul 10, Oct 10, Nov 10 (**3**); tracker **5** rows, three filed in Sep 16-30.
- **Rules:** `lib/recurring.ts:218-219` against `lib/afford-tracking.ts:39-47`.
- **Severity:** Low. **Confidence:** High. **Relates to:** B42.
- **Status (2026-09-30, K1/K2):** removed. K2 counts every backlog occurrence up to the countdown, and the tracker's `remainingInstallments` walks with K2's `scheduleDates`. Repro on Sep 28: 10,500 / 3,500 / 3,500 in Sep 16-30, Oct 1-15, Nov 1-15 and 3 occurrences in Sep 16-30 (was 3,500 and 1), the tracker's 5 rows.

#### D45. The monthly pace ignores a plan's countdown
- **Rules:** `loadActiveRecurringForMatch` selects no `remainingOccurrences` (`lib/data/monthly.ts:214-232`).
- **Repro (DB):** a biweekly plan with 1 payment left, due Oct 5, seen Oct 2: monthly "still due" **7,000** (Oct 5 and Oct 19) where 3,500 will post.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.
- **Status (2026-09-30, K1/K2):** removed. The monthly still-due figure is K2's outstanding subscription occurrences in the month's periods, countdown included. Repro: 3,500 (was 7,000).

#### D46. A past first payment: Afford treats it as paid, the Recurring form posts it
- **Repro (DB):** 4 × 3,500 from Sep 10, on Oct 2: Afford would record **3** payments from Oct 10 (1 treated as paid); the same plan entered on the form posts a Sep 10 row and leaves 3.
- **Severity:** Low. **Confidence:** High (both behaviours are documented). **Relates to:** B17.

#### D47. Editing a posted installment to the real pesos changes the past, not the future
- **Repro (DB, trace (c)):** after the edit to 3,350 DOP, Afford, the room check, the monthly pace and the ledger read **3,350** for October while the three remaining payments stay 50 EUR at today's rate (3,333.33, later 3,444.44) everywhere.
- **Severity:** Low. **Confidence:** High. **Relates to:** new.

#### D48. The cover-transfer dialog pre-fills the browser's UTC date
- **Repro (pure):** at 21:30 on Oct 14 in Santo Domingo, the app's today is **2026-10-14**; the dialog's default is **2026-10-15** (`payday-checkin-dialog.tsx:517`).
- **Severity:** Low. **Confidence:** High. **Relates to:** B36.
- **Status (2026-09-30, K1/K2):** removed. The draft carries the server's `today` and the dialog pre-fills `toISODate(draft.today)`. Repro at 21:30 on Oct 14 in Santo Domingo: 2026-10-14 (was 2026-10-15).

---

## 3. Naming collisions

The same label for different concepts, or one concept under several labels.

- **N1. "Available for flexible categories" / "Disponible para categorías flexibles"** names three computations: Step 3's live figure (Q23), the confirmed card's re-computation from a new draft (Q23 via `summarizePaydayDraft`, drifts: D15, D12, D32), and Afford's projection (`afford.columnFlexibleCheck`, Q25: average income, no carryover, no cap: D17). In trace (b) they read 43,400, 46,000 and 34,400 for one period.
- **N2. "Disponible para gastar por día"** is the Spanish for both the Dashboard's `safeToSpendPerDay` (budget − spent per day) and Step 4's `safeToSpendPerDayEstimate` (unallocated per day). English differs only by "Estimated". "Safe to spend" / "Disponible para gastar" (Budgets) is a third wording of the first. (D23)
- **N3. "Committed" / "Comprometido"** means four things: Dashboard and Budgets (still owed from today, both kinds, posted excluded, Q7); Monthly pace (subscriptions only, calendar month, posted plus due from tomorrow, Q13); Afford "Commitments" / "Compromisos" (whole period plus goal funding, Q9); and the wizard splits it into "Subscriptions" and "Recurring contributions" (outstanding only, Q8).
- **N4. "Spent" / "Gastado"** means budget spent (Q16), a category's total (Q18), and every expense (Q17, labelled "This period"). The first two sit on the same Budgets page and do not add up (D21).
- **N5. "Income" / "Ingreso(s)"** names five populations: the hero's period income (Q1), the confirmed card's typed paycheck for the plan period (Q4) on the same Dashboard, Step 2-3's typed income (Q3), the Transactions and account pages' income by date (Q5), and Afford's estimate (Q6). (D26)
- **N6. "per pay period" / "por periodo de pago"** is the today-anchored Q33 on the Goals card and the plan-anchored, netted Q34 in the debt comparator ("… per pay period on its own") on the same page (D1, D6).
- **N7. "this period" / "este periodo"**: "planned this period", "Roadmap this period", "this period's roadmap amount" and "Already paid this period" mean the plan period; "due this period" and "logged this period" mean the calendar current period. From payday to period end they name different periods on the same card: on Sep 30 one card shows "4 periods left" counted from Sep 16-30 and "planned this period" meaning Oct 1-15.
- **N8. "Pace" / "Ritmo"**: the historical average of an undated goal (Q41), the roadmap figure ("Roadmap pace", Afford's "current pace", Q34), and the comparator's "no pace of its own" (0). (D13)
- **N9. "Recommended" / "Recomendado"**: the Dashboard's flexible budget (Q21), the uncapped roadmap in the wizard's goal row (labelled "Roadmap amount", stored as `recommendedAmount` in the draft), the per-account capped draw (Q37), and the stored allocation `recommendedAmount` (capped; uncapped on rows written before `2c5d541`).
- **N10. "periods left"**: `GoalSummary.periodsLeft` (from today, can be 0), `PaydayGoalDraft.periodsLeft` (from the plan period, at least 1, never shown), `goalPeriodsLeft`.
- **N11. "Reconciliation"** names the Step 1 difference ("a reconciliation check only", "above/below ledger") and the plan cap ("Capped by your reported balance", `reconciliationGap`). Different formulas (D40). Code comments contradict the cap: `lib/payday.ts:302` says the reported gap is "Advisory only: nothing in the plan reads it", yet its sum caps `available` and scales the budgets on confirm.
- **N12. "Room" / "above its buffer"** names three formulas: the check-in's headroom (subscriptions only, Q50), Afford's and the room check's "Room left after it" / "Above its buffer" (all commitments and the essential share, Q25/Q10), and Afford's goal-estimate headroom (all commitments, no essentials). (D28)
- **N13. "Balance" / "Saldo"**: the account balance (today's rates, all dates, Q42), the Step 1 "Ledger balance" (the same minus this paycheck, Q47), the "Reported balance" (typed, Q48), and the debt comparator's balance (a goal's remaining).
- **N14. "Overdue" / "Vencido"**: in the wizard `nextDate` before the window's start, which can be a future date (D16); in Next 7 days `nextDate` before today.
- **N15. "Paid off"**: "Mark as paid off" / "Marcar como pagado" ends an installment plan's countdown; "Paid off in period N" / "Saldada" is the debt comparator's simulation of a goal marked as debt. Installment plans never enter the comparator.
- **N16. The Afford feature in Spanish**: "Desde Cuotas" on the Recurring page (`recurring.fromAfford`) and "Desde Afford" in the export header (`dataExport.headers.fromAfford`).
- **N17. Copy and comments that claim an agreement that does not hold:**
  - `lib/data/afford.ts:38-43` calls the goal pace "the same 'remaining over periods left' figure the Goals page shows and the check-in recommends"; the Goals page shows Q33, not Q34 (D1).
  - `lib/debt-payoff.ts:12-14` says the pace is "the roadmap figure the goal page already shows"; the goal page never prints it.
  - `payday.subscriptionsDue` "… due before next payday" lists occurrences to the plan period's end, after the next payday when that is pulled back to a Friday (D16).
  - `transactions.receivedAmountHint` "… converted at today's rate" describes a one-time conversion; the leg is re-converted on every read (D35).
  - `dashboard.notPostingDescription` says items that are not posting are "missing from your committed total"; they are in it (D7).
  - `dashboard.nextDays(7)` "Next 7 days" is today plus six, while `dashboard.nothingDue` says "the next week".

---

## 4. Proposal: canonical definitions

The smallest set of definitions that removes the divergences above. Where
an existing function is already the right rule, it is named and the others
move to it.

### K1. The period clock
- **Name and signature:** `periodClock(today: Date) → { today, current: PeriodInfo, plan: PeriodInfo, planPayday: Date }`.
- **Meaning:** one answer to "what day is it, which period are we in, which period does the money in hand belong to". Existing pieces are right and stay: `today()`, `periodForDate`, `planPeriodRef`, `paydayDateFor`.
- **Consumers that move to it:** `summarize` in `lib/data/goals.ts` (Goals list, detail, Dashboard card: count from `plan.start`), the goal pages' "due this period", the cover-transfer dialog's default date (server `today` passed down).
- **Removes:** D1, D48; with K3, D13's divisor.
- **Risk:** low; display figures change on payday-to-period-end days only.
- **Depends on:** nothing.

### K2. Period commitments, one occurrence at a time
- **Name and signature:** `periodCommitments(period: PeriodInfo, today: Date) → Occurrence[]`, each `{ itemId, dueDate, amount (in the funding account's currency), status: "posted" | "settled" | "outstanding" | "wont_post", settledBy? }`, plus helpers `whole(period)` and `outstanding(period)`.
- **Meaning:** an occurrence belongs to the period its due date falls in. Only a genuine backlog (`dueDate < today`) is filed in the current period, and every backlog occurrence counts (bounded by the countdown, as posting will charge them). An item posting will skip (achieved goal, no account, archived account) is marked `wont_post`, never silently counted. The current period includes what already posted or settled, at the ledger's amount. The existing rule closest to this is Afford's `loadScheduledCommitments` (`lib/data/afford.ts:334-450`) with the settlement plan (`loadSettlementPlan`) for the status; `owedOccurrences`' "before the window" branch becomes a current-period-only backlog rule.
- **Consumers that move to it:** `getPeriodSummary` (Committed shows `outstanding`; the plan uses `whole`), the wizard's Subscriptions and Contributions and its per-account room (contributions included), the confirmed card and "Recommended", Afford and the room check (already close), the tracker's `remainingInstallments`, the monthly pace's still-due walk (with the countdown), Next 7 days, and the goal roadmap's netting (K3).
- **Removes:** D7 (visible instead of counted), D15, D16, D25, D28, D44, D45; the counting half of D12.
- **Risk:** medium. It changes Step 3 and Committed on every page, and the late-check-in figure drops by what has posted. The audit script's pair 4 and the harness's posting sections cover this ground.
- **Depends on:** nothing; K3, K4 and earmarked income build on it.

### K3. A goal's period plan
- **Name and signature:** `goalPeriodPlan(goal, period: PeriodInfo, clock) → { pace, scheduled, byHand, planned, contributed }`.
- **Meaning:**
  - `pace`: what reaching the target asks of each period from the plan period on, fixed at the plan period's start: (target − saved from contributions dated before `plan.start`) / `goalPeriodsLeft(plan.start, target)`. Gross (before recurring contributions).
  - `scheduled`: the goal's recurring contributions due in *that* period (from K2).
  - `byHand = max(0, pace − scheduled)`: what the check-in should fund.
  - `planned`: the period's confirmed GOAL rows (0 when the period is confirmed and has none).
  - `contributed`: contributions dated in the period, manual and posted.
  - For an undated goal: `pace` is the remaining balance, as today.
- **Existing:** `goalRoadmapAmount` is the formula to adapt (its inputs change); `getGoalRoadmapStatuses` is the container to extend.
- **Consumers that move to it:** the Goals list, detail and Dashboard card (show `byHand` and the period's `contributed` beside `planned`), the wizard's roadmap, the goal detail's behind and room notes, the Inbox goal alert (compare `contributed + outstanding scheduled` with `byHand` and with `planned`), the forecast (each period's own `scheduled`), Afford's estimate (same), and the debt comparator (gross `pace`, or `byHand + scheduled`).
- **Removes:** D1 (with K1), D2, D3, D4, D5, D6, D8, D10, D11, D13, D14.
- **Risk:** medium; it changes what "behind" means and the Inbox's keys may need a new reason. Decision 5.3 chooses the definition of `pace` and of "behind".
- **Depends on:** K1, K2.

### K4. Flexible room for a period
- **Name and signature:** `flexibleRoom(period, inputs: "confirmed" | "projected") → { income, carryover, commitments, goalPlan, essential, buffer, cap, available }`.
- **Meaning:** the check-in's formula, `availableForFlexibleCategories` (`lib/payday.ts:62-73`), which is already right, over one set of inputs. A confirmed period reads what was confirmed: the snapshot income, the stored `protectedBuffer`, the GOAL rows, the essential Budget rows, the stored carryover, and K2's `whole` commitments. An unconfirmed period reads projections (Q6, K2, K3).
- **Consumers that move to it:** Step 3, the confirmed card, "Recommended" (and whether it shows: D24), Afford's flexible check and per-account check, the room check.
- **Removes:** D12, D15 (with K2), D17, D19, D24, D32; decides D23's unallocated money and D27's carryover timing (read at confirm and at period end).
- **Risk:** medium. Afford for a confirmed period will move to the confirmed paycheck.
- **Depends on:** K2, K3, K5.

### K5. Period income, fact and estimate
- **Name and signature:** `periodIncome(period, basis: "fact" | "estimate") → Map<accountId, amount>`.
- **Meaning:** one attribution: a paycheck belongs to the period it funds, whether it came through a check-in or a CSV row matched to one (B5's matcher already recognises the pairing). `fact` counts everything (`getPeriodSummary`'s rule); `estimate` leaves out one-off income, reimbursements, earmarked deposits and the one-off part of a check-in paycheck (a new per-snapshot field). Existing: `getPeriodSummary`'s income and `loadPeriodIncome`.
- **Consumers:** the hero and Reports (`fact`), Afford, the room check, the tracker, the forecast (`estimate`), the Transactions and account pages (relabelled as by-date, or moved to `fact`).
- **Removes:** D18, D26.
- **Risk:** low to medium; per-half history shifts for users who import paychecks.
- **Depends on:** nothing.

### K6. Budget spending
- **Name and signature:** `budgetSpent(period) → { total, byCategory }`.
- **Meaning:** one population for the overall figure, the category rows, the suggestion numerator and carryover: every expense the plan did not already reserve. Excluded: any row that stands for a recurring occurrence (RECURRING or settled, either kind), contribution twins, subscription and savings categories. Shared expenses per decision 5.4. Existing: `getPeriodSummary`'s `outsideBudget` test, applied to the category lines too.
- **Consumers:** Dashboard and Budgets overall and category rows, `getCategorySuggestions`, carryover, the monthly lifestyle split.
- **Removes:** D20, D21, D30, D31; D22 per decision.
- **Risk:** low. Category rows lose recurring charges; a "total" view can stay in Reports.
- **Depends on:** nothing.

### K7. Amounts stored in the account's currency
- **Name and signature:** `Transaction.amount` in the account's currency, with `originalAmount`, `originalCurrency` and `rate` kept beside it; `accountAmount(row) = row.amount`.
- **Meaning:** what the bank moved, fixed at entry. Precedent: `logManualContribution` already writes its twin this way.
- **Consumers:** balances and the ledger, Step 1, posting (convert once, with the rate kept), settlement and duplicate matching (compare in the account's currency), transfers, the monthly pace, reimbursement progress, contribution edits (keep the stored twin unless amount or account changes).
- **Removes:** D35, D36, D37, D38, D39; D43 moves to "which rate at entry"; D47 becomes "the item's amount is the schedule; the posted row is the fact", which is then consistent.
- **Risk:** high: a migration of existing rows, and every reader of `currency`. The four production EUR subscriptions whose posted rows were hand-edited to DOP (project memory) are the real-data case to check.
- **Depends on:** nothing; best done before earmarked income for foreign-currency items.

### K8. Ledger at a date and the reconciliation
- **Name and signature:** `ledgerAt(accountId, date) → amount` (rows dated on or before `date`) and `reconciliation(account, checkin) → { expected, reported, difference }`.
- **Meaning:** Step 1 compares the reported balance with the ledger as of the day before this period's pay landed, excluding this check-in's paycheck; balances exclude future-dated rows (or show them apart). Existing: `ledgerBefore` and `getAccountBalances`. What the difference does to the plan is decision 5.1.
- **Consumers:** Step 1, the cap, the account pages, the check-in's pre-fill.
- **Removes:** D40, D41, D42.
- **Risk:** low to medium.
- **Depends on:** K7 for foreign rows.

### K9. One history window
- **Name and signature:** `comparableHistory(ref, today, purpose)` extended: start at the newest comparable period that has ended or is confirmed; skip a partial first period; apply "count income history from" by period; derive monthly windows from the same boundary. Existing: `comparableHistory` in `lib/data/afford.ts:150-171` is the right rule.
- **Consumers:** category suggestions, the Reports per-period average, the monthly windows, the undated goal's pace divisor (completed periods).
- **Removes:** D29, D33, D34, and D13's divisor.
- **Risk:** low.
- **Depends on:** decision 5.2.

### Order of changes (grouped by the code they touch)

1. **K1 + K2** — `lib/period.ts`, `lib/recurring.ts` (`owedOccurrences`), `lib/data/period-summary.ts`, `lib/data/afford.ts` (`loadScheduledCommitments`), `lib/afford-tracking.ts`, `lib/data/monthly.ts` (still-due walk), `lib/data/dashboard.ts`, `lib/data/goals.ts` (anchoring). Foundation for everything else.
2. **K3** — `lib/data/goals.ts`, `lib/data/payday.ts` (`goalRoadmapAmount`, `getGoalRoadmapStatuses`), `lib/insights.ts`, `lib/data/goal-forecast.ts`, `lib/data/afford.ts` (estimate), `lib/data/debt-payoff.ts`, the goal pages.
3. **K4 + K5 + K6** — `lib/data/payday.ts` (draft, confirm, carryover, suggestions), `lib/payday.ts`, `lib/data/afford.ts` (`projectPeriods`, `evaluateAffordability` inputs), `app/(app)/page.tsx`, `period-hero.tsx`, `payday-checkin-card.tsx`, `lib/data/period-summary.ts` (spent).
4. **K7 + K8** — schema migration, `lib/recurring-posting.ts`, `lib/recurring-settlement.ts`, `lib/data/posted-duplicates.ts`, `server/actions/transactions.ts`, import and review, `lib/goals.ts`, `lib/data/accounts.ts`, `step-balances.tsx`.
5. **K9** — `lib/data/payday.ts` (suggestions), `lib/data/reports.ts`, `lib/data/monthly.ts`, `lib/data/goals.ts` (undated pace).

### Which upcoming task uses which definition

| Task | Uses | Where it plugs in |
|---|---|---|
| Goal roadmap fixes | K1, K2, K3 | `goalPeriodPlan` replaces `goalRoadmapAmount`'s inputs and feeds every goal reader; K2 supplies each period's `scheduled`. |
| Check-in fixes | K2, K4, K5, K6 (K8 for Step 1) | Step 3 becomes `flexibleRoom(plan, "projected")` while drafting and `flexibleRoom(plan, "confirmed")` once confirmed, so the card, "Recommended" and Afford read the same numbers. |
| Income earmarked for a recurring payment | K2 first; then K4, K5, K6; K7 for foreign items | The earmark is a pairing of a deposit with one occurrence key, the same shape as `RecurringSettlement` (charge ↔ occurrence), stored beside it. K2 gives each occurrence an `earmarked` amount so `outstanding = amount − earmarked`: that is what "reduces what the occurrence still asks of Afford, the check-in and the budget" means in code. K5's `estimate` leaves the earmarked deposit out of income history (like a reimbursement), and K4 either leaves it out of the period's income or counts it with its reservation, so it is not counted twice. K6 is unaffected (the charge is already outside the budget). With K7 the earmark and the charge compare in the account's currency. |
| Stored amounts in the account currency | K7, K8 | Everything reading `Transaction.currency` for arithmetic; settlement matching; contribution twins; Step 1. |

---
## 5. Design decisions for you

No choice is made here. Each option lists what it would mean in the app.

### 5.1 The reported balance's role in "Available for flexible categories"

Today the Step 1 difference (reported − ledger) is a check only and feeds
nothing (Q49); the plan is capped only by a negative reported balance
(Q52/Q53). Money that was already in the account before the pay landed is
not counted as available: it stays as a cushion.

- **Option A: keep it a check only (today).**
  - Pros: the plan depends only on this period's income, so leftover money from earlier periods stays untouched as a safety margin; a wrong typed balance cannot inflate the plan.
  - Cons: the difference is computed and stored and does nothing, and "Reconciliation" names two unrelated figures (N11); a shortfall the user types (reported far below the ledger) never lowers the plan (D40); the cushion is invisible, so the user cannot tell how much of it exists.
- **Option B: cap the plan by what the accounts really hold (reported + income − reservations), in both directions of shortfall.**
  - Pros: the plan can never promise money the accounts do not have, whatever the cause (spending not entered, rate drift, bank fees); one "reconciliation" concept.
  - Cons: rate drift on foreign rows (D35) and post-payday spending in the ledger (D41) would lower the plan until K7 and K8 land; a typo in Step 1 changes the budgets.
- **Option C: add the cushion to "Available" (reported balance above the buffer becomes spendable).**
  - Pros: the plan uses all the money there is; matches how some users think of "what I can spend".
  - Cons: savings kept in a checking account become flexible money every period; the buffer and goals would compete with money the user meant to keep; figures would swing with every correction of the ledger.
- **Option D: show the cushion beside "Available" without adding it.**
  - Pros: the user sees both numbers; nothing in the plan changes.
  - Cons: one more figure on Step 3; still needs K8 so the cushion is measured against the right ledger date.

### 5.2 "Count income history from" also limits the monthly pace and Reports

The setting bounds Afford's income walk and the category suggestions by pay
period, and the monthly average by calendar month; the Reports per-period
average ignores it (D33).

- **Option A: income only (Afford).** Pros: the name says income, and a job change affects income, not spending habits. Cons: suggestions keep averaging spending from before the change (a move, a new household) that the user may also want to forget.
- **Option B: every average (income, suggestions, monthly, Reports), at period granularity, one boundary.** Pros: one date means one thing everywhere; removes D33. Cons: the label would need to say "history" rather than "income history"; the monthly average loses the partial month containing the date.
- **Option C: two settings, one for income and one for spending averages.** Pros: each can follow its own life event. Cons: another setting to explain; most users will set only one.
- **Option D: keep the current reach, but align the monthly boundary to periods and apply it to the Reports average.** Pros: smallest change that makes the pages agree. Cons: still one date governing income and spending under an income-only name.

### 5.3 Planned versus contributed for goals

Today a goal's status compares the confirmed plan with the live roadmap and
never looks at contributions (D3), and the roadmap moves as money goes in
(D2, D4). The choices behind K3:

- **What "on track" measures.**
  - Option A: *planned vs pace* (today). Pros: known at confirm time; one alert per period. Cons: a plan that was never carried out looks fine; a plan that was carried out still reads as a plan.
  - Option B: *contributed vs pace*. Pros: says whether the goal actually got its money; works without a check-in. Cons: early in a period every goal is "behind" until the money moves; needs a rule for when in the period to judge (for example only after the plan period's payday, or at period end).
  - Option C: *both, as two statements*: "planned X of the Y the roadmap asks" (at confirm) and "contributed Z of the X planned" (as the period runs). Pros: separates a planning shortfall from a follow-through shortfall. Cons: two alert kinds and more copy.
- **Whether the pace is frozen for the period.**
  - Option A: *frozen at the plan period's start* (remaining as of `plan.start` / periods). Pros: a contribution inside the period does not move the bar (fixes D2, D4). Cons: a large windfall contribution does not lower later periods' ask until the next period.
  - Option B: *what is still ahead* (remaining now / periods after this one, once this period's plan is met). Pros: always the true remaining need. Cons: needs a notion of "this period's plan is met", which is exactly the planned-vs-contributed question.
- **Gross or net of recurring contributions.** Gross (the pace, with `scheduled` shown beside it) keeps the debt comparator and the forecast honest (D5, D6); net (what the check-in should fund by hand) is what Step 3 needs. K3 carries both; the question is which one the Goals page shows as "per pay period".

### 5.4 Other decisions the proposal depends on

- **Shared expenses in budgets (D22).** Budget at the full amount and treat reimbursements as restoring it (pros: the budget tracks cash; cons: needs a link from deposit back to period), or budget at the user's share and count only the share as spent (pros: matches the suggestion; cons: the account's cash and the budget diverge until paid back), or keep today's split and say so on the Budgets page.
- **Unallocated money after a check-in (D23).** Write it as an explicit "unallocated" budget row so safe to spend includes it (pros: nothing disappears; cons: safe to spend rises by money the user chose not to assign), leave it out but carry it to the next period (pros: rewards not spending; cons: carryover grows without a plan), or refuse to confirm with money unallocated (pros: explicit; cons: one more step).
- **A posted installment edited to the real amount (D47).** Offer to update the item's amount for the remaining payments (pros: forward figures follow the bank; cons: a one-off fee would spread to every later payment), or keep the item as the schedule and only the posted rows as facts (pros: simple; cons: the remaining commitments stay a few percent off for foreign plans until K7).

---

## 6. Unproven

Candidates that were not reproduced, and what evidence is missing.

- **Real-data state of the "Pay back money" goal.** Whether it is marked as a debt (which decides whether the comparator rows of trace (a) render), whether a Sep 16-30 check-in was confirmed (which decides Afford's Sep 16-30 estimate), whether the accounts' room covered all of 5,571.32 at confirm time (which decides the room-shortfall note), and whether the goal's currency is the display currency. *Missing:* a read-only look at the real data, which this task excluded.
- **"Supports" counts income twice when the pay came in by CSV** (display only). `reportedSupports = reported + headroom` would include a paycheck the ledger and the reported balance already hold. *Missing:* a run with a CSV paycheck and the check-in's Step 3 per-account view.
- **The practical reach of D38.** How often banks bill a foreign subscription before its due date, and the real spread between a card's EUR or USD charge and the rate table (a DOP row brought in after posting is flagged only within 3%). *Missing:* real statements.
- **The Goals page's contribution netting ignores a plan's countdown** (`lib/data/goals.ts:32-40` selects no `remainingOccurrences`). *Missing:* a run with a finite recurring contribution whose last occurrence precedes the end of the current period.
- **The subscription-room check has no countdown input**, so a large finite plan may be judged as endless. *Missing:* a run with a large weekly or biweekly finite item in its last period.
- **`classifyCompletedMonth` falls back to the full monthly equivalent for a finite item** in a month it did not post. *Missing:* a completed month in which a finite item was active but unposted.
- **Afford's estimate for today's period ignores contributions already logged in it** (D10's window). *Missing:* a run with a contribution logged between payday and period end and a purchase judged in that period.
- **The subscription-room check removes the edited item's own commitment only from the account figure** (U3 in BUG_HUNT_FINDINGS.md). *Missing:* a run where goal funding is capped by room.
- **A check-in period that was skipped reads as zero income** (U4). D26 reproduced the variant where the pay is in the ledger under the other half; the plain skip was not.
- **Concurrent and repeated writes** (U6, B37): not quantities, not re-tested.

---
## 7. Traces

Every number below comes from running the real functions against the
throwaway database `cadence_qmap_scratch` (fictional `Fict …` rows, display
currency DOP, rates USD 1 / DOP 60 / EUR 0.9, buffer 10% with a 2,000 DOP
floor). The scripts are in the session scratchpad, not in the repo.

### (a) "Pay back money": target 29,000 DOP due Nov 15 2026

Setup: 12,286.03 contributed before the check-in. On Wed Sep 30 (Sep B's
payday, so the plan period is Oct 1-15) the check-in recommends and the user
confirms 5,571.32 for the goal. The user then logs 5,571.32 dated Oct 1.
Saved becomes 17,857.35 and remaining 11,142.65.

| Screen | Source | Sep 30 before the check-in | Sep 30 after the 5,571.32 | Oct 1-14 | Oct 15 (payday) |
|---|---|---|---|---|---|
| Goals list and Dashboard goal card: "per pay period · N periods left" | `summarize`, `src/lib/data/goals.ts:118-127` (`periodsRemaining(today, target)`) | 4,178.49 × 4 | **2,785.66 × 4** | 3,714.22 × 3 | 3,714.22 × 3 |
| Goal detail: "Per pay period / N periods to the target date" | same | 4,178.49 × 4 | 2,785.66 × 4 | 3,714.22 × 3 | 3,714.22 × 3 |
| Goals list and detail: "planned this period" | GOAL allocation rows of the plan period's confirmed check-in (`goals/page.tsx:54-64`, `getGoalRoadmapStatuses`) | none | **5,571.32** | 5,571.32 | none (plan period is now Oct 16-31) |
| Roadmap for the plan period (wizard recommendation, goal detail "behind", Inbox) | `goalRoadmapAmount`, `src/lib/data/payday.ts:357-364` (`goalPeriodsLeft(planStart, target)`) | 5,571.32 (3 periods) | **3,714.22** (3 periods) | 3,714.22 | 5,571.33 (2 periods) |
| Wizard re-opened for Oct 1-15 | `getPaydayCheckinDraft` | recommended 5,571.32 | recommended 3,714.22, planned 5,571.32 (held) | same | Oct 16-31: recommended 5,571.33 |
| Inbox "behind its roadmap" | `detectGoalsBehind`, `src/lib/insights.ts:332-375` | none | none (planned 5,571.32 ≥ roadmap 3,714.22) | none | none |
| Goal forecast (Inbox "at risk") paces per period | `forecastGoalFunding` over `projectPeriods` | Oct A/B, Nov A at 5,571.32 | Oct B 3,714.22, Nov A 3,714.22 | same | Oct B 5,571.33, Nov A 5,571.33 |

Why each differs:
- The Goals page counts periods from today. On Sep 30 that includes Sep 16-30,
  which ends tonight and whose money was planned two weeks ago:
  11,142.65 / 4 = 2,785.66. The wizard counts from the plan period's start
  (Oct 1): 3 periods (D1).
- The roadmap divides live `remaining` by the periods from the plan start.
  `remaining` already subtracts the contribution made *inside* the plan period,
  but the plan period is still counted as a period to fund, so its roadmap
  falls from 5,571.32 to 3,714.22 once the plan is carried out. What the
  target still needs is 11,142.65 over the two periods after this one
  (5,571.33 each, the figure the wizard shows from Oct 15), but the forecast
  asks 3,714.22 of each: 7,428.44 in total, 3,714.21 short of the target
  (D2).
- "Planned this period" and the Inbox alert read only the check-in's GOAL
  rows. Nothing compares them with the contributions logged in the period.
  With the plan confirmed and nothing contributed by Oct 14, the page still
  says "5,000 planned this period" and the Inbox raises nothing (repro X3 in
  D3).
- `saved` counts the Oct 1 contribution on Sep 30: `savedFromContributions`
  sums every row regardless of date (`src/lib/goals.ts:316-330`).

### (b) One check-in's "Available for flexible categories" against the other screens

Setup: one DOP account with six comparable periods of 50,000 income, 8,000
Groceries, 3,000 Dining and (A periods) 5,000 Bills (Bills marked essential
fixed). Netflix 600 on Oct 5; a 2,000 recurring contribution on Oct 10 to a
30,000 goal due Dec 31 (roadmap 30,000 / 6 − 2,000 = 3,000). On Sep 30 the
user confirms Oct 1-15 with a 60,000 paycheck and accepts every suggestion:
goal 3,000, Bills 5,000, Groceries 8,000, Dining 3,000.

| Screen | Formula | Oct 1 (Step 3, Step 4, Afford and a Budgets view of Oct 1-15 read the same on Sep 30) | Oct 11 (Netflix and the contribution posted, 4,000 spent on Groceries) |
|---|---|---|---|
| Step 3 "Available for flexible categories" | income 60,000 + carryover 0 − subscriptions 600 − contributions 2,000 − goals 3,000 − essential 5,000 − buffer 6,000 (`availableForFlexibleCategories`, `src/lib/payday.ts:62-73`) | **43,400** | 46,000 on re-opening (posted items drop out of "outstanding") |
| Step 4 "Unallocated" and "Estimated safe to spend per day" | (available − flexible planned 11,000) / days left in the plan period (`step-flexible.tsx:32-34`) | 32,400 → **2,160/day** (15 days) | 35,000 → 7,000/day (5 days) |
| Dashboard hero and Budgets page "Safe to spend" | period budget (sum of category budgets: 5,000 + 8,000 + 3,000) − spent (`getPeriodSummary`) | **16,000**, 1,066.67/day | 12,000, 2,400/day |
| Dashboard confirmed check-in card "Available for flexible categories · Allocated" | `summarizePaydayDraft` over a freshly built draft (`payday-checkin-card.tsx:38-48`) | 43,400 · 11,000 | **46,000** · 11,000 |
| Dashboard "Recommended" | the same live figure (`page.tsx:54-59`), but rendered only when the period has no budget at all (`period-hero.tsx:67, 91-109`) | computed 43,400 from Oct 1, **not shown** (category budgets exist) | computed 46,000, not shown |
| Budgets page "Committed" | occurrences still owed from today to the period end | 2,600 | 0 |
| Afford "available for flexible categories" (Oct 1-15) | average income 50,000 − all the period's commitments 5,600 (600 + 2,000 + GOAL row 3,000) − essential 5,000 − buffer 5,000 (10% of the average) (`evaluateAffordability`, `src/lib/afford.ts:436-444`) | **34,400** | 34,400 |

Three figures under one label ("Available for flexible categories") give
43,400, 46,000 and 34,400 for the same confirmed period. The two "safe to
spend per day" figures are different quantities with one Spanish label. The
32,400 left unallocated in Step 4 is in no Budget row, so it appears on no
later screen and never reaches the next period's carryover. The
Dashboard's 16,000 is essential plus flexible budgets, while Step 3's
43,400 excludes essentials, so the two differ by construction. See N1, N2,
D15, D17 and D23.

### (c) A Klarna plan of 4 × 50 EUR on a DOP account

Recorded through Afford on Oct 1, first payment Oct 20 (Oct 16-31). The item
is stored as 50 EUR (`confirmAffordPurchase`, `src/lib/data/afford.ts:933-950`).
1 EUR = 66.67 DOP at the test rates; the bank is assumed to charge 3,350 DOP.

| Screen | (1) Oct 1, recorded | (2) Oct 21, first payment posted | (3) Oct 21, posted row edited to 3,350 DOP | (3b) same, rate moves to 68.89 DOP/EUR |
|---|---|---|---|---|
| Posted row | none | 50 EUR on the DOP account | 3,350 DOP | 3,350 DOP |
| Wizard, Oct 16-31 commitments | 3,333.33 (50 EUR) | absent (owed from today, already posted) | absent | absent |
| Period summary Oct 16-31 "committed" | 3,333.33 | 0 | 0 | 0 |
| Afford Oct 16-31 committed (includes a 5,000-6,000 goal estimate) | 8,333.33 | 9,333.33 (posted row at today's rate) | 9,350 (the edited pesos) | 9,350 |
| Tracker (payments left, amount left) | 4, 200 EUR, 3,333.33 DOP each | 3, 150 EUR | 3, 150 EUR (the edit does not reach the item) | 3, 3,444.44 DOP each |
| Monthly pace (October) | still due 3,333.33 | spent so far 3,333.33 | spent so far 3,350 | 3,350 |
| Subscription-room check, Oct 16-31 committed | 8,333.33 | 9,333.33 | 9,350 | 9,350 |
| Ledger balance | 219,000 | 215,666.67 (moves with the rate) | 215,650 (fixed) | 215,650 |

What this shows: the count of payments agrees everywhere while the plan is
current. The amounts diverge only in currency: until the user edits it, the
posted row is 50 EUR and every reader converts it at the day's rate (D35).
After the edit, Afford, the room check, the monthly pace and the ledger read
the real pesos, while future installments stay at 50 EUR converted at
today's rate. The wizard for a period already under way leaves the posted
installment out altogether while Afford keeps it (D15). An installment stuck
unposted is counted once by the commitments walk and once per missed date by
the tracker (D44).

### (d) A 15 USD recurring charge on a DOP account

Opening balance 20,000 DOP; the item posts on Oct 5 as **15 USD** on the DOP
account (`recurring-posting.ts:283-295` writes `item.currency`). The bank
converted at 61.2, so it shows 19,082.

| Rate on the day the page is read | Ledger balance (`getAccountBalances`) | Step 1 expected balance | Step 1 difference against 19,082 | Reconciliation cap on "Available" | Monthly "committed spent so far" |
|---|---|---|---|---|---|
| 60 | 19,100 | 19,100 | −18 | 0 | 900 |
| 61.2 | 19,082 | 19,082 | 0 | 0 | 918 |
| 62 | 19,070 | 19,070 | +12 | 0 | 930 |

The ledger, the check-in's expected balance and every display-currency total
re-convert the stored 15 USD at the rate of the day they are read, so the
difference the user sees in Step 1 changes sign with the rate although no
money moved (D35, B19). The reconciliation cap stays 0 in all three: it only
acts when the reported balance itself is below zero (`reportedGap =
max(0, headroom − (reported + headroom))`, which is `max(0, −reported)`,
`src/lib/payday.ts:355-357`). The difference against the ledger never enters
it (decision 5.1).
