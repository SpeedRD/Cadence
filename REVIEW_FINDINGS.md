# Cadence correctness audit - 2026-09-04

Read-only audit of `src/` for the five bug classes surfaced by today's fixes
(double scroll, goal-contribution double count in `monthly.ts`, weekend-shifted
`isPaydayDate`). No code was changed. This file is untracked; do not commit it.

**Method.** Every data module (`src/lib/data/*`), every server action, the
shared libs (`currency`, `money`, `date`, `period`, `month`, `recurring`,
`recurring-posting`, `rates`, `goals`, `ingestion`, email, LLM parse, session),
the cron routes, and the pages/components that compute or display totals were
read in full. Date claims were verified by running the real library functions
via `tsx` from the scratchpad (output quoted where relevant). The three fixes
already made today are not re-reported.

**Severity labels** (as requested):
- `data-corrupting` - a wrong or duplicate value is persisted, or a persisted
  process silently stops.
- `user-misleading-but-harmless` - a displayed figure is wrong; nothing
  persisted (a note says when it *feeds* a persisted planning figure).
- `cosmetic` - visible but inconsequential.

**Confidence**: CONFIRMED = traced end to end in code (and executed where
practical). PLAUSIBLE = code path confirmed, trigger requires an external
condition I could not exercise.

---

## Summary

| # | Sev | Cat | Finding |
|---|-----|-----|---------|
| T1 | data-corrupting | 3 | Monthly/yearly recurring dates drift permanently after a short month (Jan 31 -> Feb 28 -> Mar 28 ...). |
| K1 | data-corrupting | 5 | A recurring item whose `nextDate` points at an already-posted day is stuck forever: every run fails on the externalId unique key and never advances; nothing in the UI. |
| D2 | data-corrupting | 2 | A subscription charge approved from email/CSV/manual entry is posted *again* by recurring posting on its due date; the "Already paid" badge hides the duplication. |
| T2 | data-corrupting (if triggered) | 3 | On the weekend after a Friday-shifted payday the wizard plans the *ending* period; confirming rewrites that period's existing paycheck row. |
| C2 | data-corrupting (minor) | 1 | Confirming a payday plan re-denominates every untouched category budget into the display currency at today's rate. |
| K2 | data-corrupting (if triggered) | 5 | `setOpeningBalance` is find-then-write with no transaction; a double submit creates two opening-balance rows and doubles the balance. |
| C3 | data-corrupting (if triggered) | 1 | `convert()` silently returns the raw amount when a rate is missing; a partial rate fetch is returned as fresh. Hardcoded fallback rates are only flagged on Settings. |
| D1 | user-misleading (feeds carryover) | 2 | Safe-to-spend subtracts subscriptions, contributions and essentials that the payday plan already carved out of the budget. Carryover inherits the understatement and is persisted. |
| D6 | user-misleading | 2 | Skipped/overdue recurring items vanish from committed, upcoming and the check-in; the posting summary never reaches any page. |
| D9 | user-misleading | 2 | Email ingestion caps at 20 candidates but advances `lastSyncedAt` to now; the overflow is never fetched again. |
| C1 | user-misleading (persists `achievedAt`) | 1 | Auto-posted contributions in a foreign currency float with the exchange rate; `savedAmount`/`achievedAt` change retroactively and the goal page reports "drift". |
| D3 | user-misleading | 2 | Heuristic matcher matches one transaction per item and by category alone; weekly items leak into lifestyle; a same-amount expense marks a subscription paid. |
| D4 | user-misleading | 2 | RECURRING rows are never matched by `externalId`; editing amount/currency, pausing or deleting an item double-counts its history (delete also undoes today's fix). |
| D5 | user-misleading | 2 | Payday plan reserves a goal twice: the recurring contribution to it plus its roadmap amount. |
| D7 | user-misleading | 2 | Committed figures count only the single stored `nextDate`, and drop an item entirely once one occurrence matched. |
| D8 | user-misleading | 2 | Historical monthly average fabricates committed/contribution amounts for months before an item existed; opening balances extend the history window. |
| F1 | user-misleading (persisted) | 4 | `includedCarryover` is stored as sent by the client; not clamped to the server's recomputed carryover. |
| F2 | user-misleading | 4 | Category suggestions divide by 6 even when fewer periods of history exist. |
| D10 | user-misleading | 2 | Income entered for a since-archived account disappears from the confirmed check-in summary and is dropped from `totalIncome` on re-confirm. |
| T3 | user-misleading | 3 | Check-in income is dated `today`, so the paycheck that funds period P lands in period P-1's income figure on the hero and reports. |
| K3 | user-misleading | 5 | `recomputeGoalSaved` read-then-write can lose an update under concurrent contributions (self-heals). |
| K4 | user-misleading | 5 | Concurrent Microsoft token refreshes (cron + "Sync now") can store the older rotated refresh token. |
| C4 | cosmetic | 1 | Rate refresh between wizard render and confirm can make the server demand a deficit acknowledgement the client never shows. |
| F3 | cosmetic | 4 | Snapshot `expectedLedgerBalance`/`difference` mean different things on first confirm vs re-confirm. |
| F4 | cosmetic | 4 | `paydayConfirmSchema` has no magnitude/decimal bounds and allows duplicate category ids. |
| F5 | cosmetic | 4 | Transaction/transfer/recurring actions do not check that `accountId`/`categoryId` exist or are active; FK errors surface raw. |
| D11 | cosmetic | 2 | An EXPENSE filed under an INCOME-kind category is in `spent` but in no breakdown. |
| K5 | cosmetic | 5 | Recurring edit form writes every field from a possibly stale form, clobbering a wizard reassignment. |
| K6 | cosmetic | 5 | Budget save / payday confirm collisions are caught by unique indexes but surface as raw errors. |
| T5 | cosmetic | 3 | "Last fetched"/"Last synced" timestamps render in UTC, not APP_TIMEZONE. |

---

## 1. Currency conversion

### C1. Foreign-currency auto-posted contributions float with the exchange rate
- **src/lib/recurring-posting.ts:146-155**, **src/lib/goals.ts:23-38, 40-48**, **src/server/actions/goals.ts:77-85**, **src/app/(app)/goals/[id]/page.tsx:52, 165-169**
- **Issue:** The manual contribution path forces `currency: goal.currency`, so a manual contribution is fixed forever. The posting job writes the GoalContribution in `item.currency`. `recomputeGoalSaved` converts those rows at *today's* rate on every rebuild (every posting, every manual contribution, every goal edit), so a DOP goal fed by a USD recurring item has its `savedAmount` rewritten as the rate moves, `achievedAt` is set and then cleared again (line 47) as the converted sum crosses the target, and the goal page's "drifted" warning fires from FX movement alone because `contributionTotal` is converted at yet another moment.
- **Severity:** user-misleading-but-harmless, but `savedAmount` and `achievedAt` are persisted and flip.
- **Confidence:** CONFIRMED.
- **Fix:** Convert once at posting time (write the GoalContribution in the goal's currency, as the manual path does), so the cache is a plain sum; or store the conversion rate on the row.

### C2. Payday confirm re-denominates untouched category budgets
- **src/lib/data/payday.ts:345-352, 441-443, 490-492, 875-901** vs the guard in **src/server/actions/budgets.ts:43-53**
- **Issue:** The draft seeds each category's `plannedAmount` from the existing Budget row converted into the display currency (`round2(convert(...))`). Confirm then writes `amount: plannedAmount, currency: context.displayCurrency` unconditionally (885-888). A budget stored as DOP 10,000 with display USD becomes USD 166.67; switch display back and confirm again and it becomes DOP 10,000.20 (rounding + rate movement). The Budgets page explicitly guards this with `isSameMoney`; the wizard does not.
- **Severity:** data-corrupting (small magnitude, but a stored value changes without an edit, on every confirm).
- **Confidence:** CONFIRMED.
- **Fix:** In the confirm loop, skip the update when `existingBudget.currency !== displayCurrency && isSameMoney(plannedAmount, displayCurrency, existing.amount, existing.currency, rates)`, mirroring `saveBudgetAction`.

### C3. Missing rates convert at face value; partial fetch returned as fresh; fallback constants unflagged
- **src/lib/currency.ts:50-54**, **src/lib/rates.ts:17, 74-77, 94-96, 114**, **src/app/(app)/settings/page.tsx:80-84**
- **Issue:** `convert` returns `amount` unchanged when either rate is falsy. In the fresh-fetch branch a code the API omits is skipped (`continue`) and the table is still returned with `stale: false`; every DOP row would then be summed as USD at face value, and `confirmPaydayCheckin` would persist `totalIncome` that way. Separately, when the API is unreachable and nothing was ever stored, `FALLBACK_RATES` (DOP 60) is used with `stale: true`, which is surfaced only on the Settings page; the dashboard, check-in and reports show converted totals with no indication.
- **Severity:** data-corrupting under the partial-fetch trigger; user-misleading for the fallback case.
- **Confidence:** CONFIRMED code path; PLAUSIBLE trigger (requires the API to omit a listed currency or be down on first use).
- **Fix:** Reject a fetched payload unless every code in `CURRENCIES` is present; make `convert` throw (or return `NaN` and have callers flag) on a missing rate; show the `stale` flag wherever converted totals are rendered.

### C4. Rate refresh between render and confirm can deadlock the deficit gate
- **src/components/payday/payday-checkin-dialog.tsx:78-83, 113-123, 192-193**, **src/lib/data/payday.ts:692-708**
- **Issue:** The client decides whether to show the deficit checkbox using the rates it was rendered with; the server recomputes with `context.rates` at submit. If the 24h rate cache refreshes in between and `available` crosses zero, the server returns "acknowledge deficit first" but the client never rendered the checkbox, so the plan cannot be confirmed until the page is reloaded.
- **Severity:** cosmetic (rare; reload fixes it).
- **Confidence:** PLAUSIBLE.
- **Fix:** Return the server-computed `available`/`needsDeficitAck` in the failure state and render the checkbox from it, or always render both acknowledgement boxes when the server says so.

### Checked and found nothing (currency)
- Every `convert()` call site converts exactly once from a row's own currency: `period-summary.ts` (budgets, transactions, recurring), `dashboard.ts`, `reports.ts`, `transactions.ts` (list and grouped summary), `recurring.ts`, `goals.ts` (`display*` derived from native, never from another `display*`), `monthly.ts`, `payday.ts` (income per account, allocations by their stored currency, buffer floor per account, carryover by check-in currency).
- `accounts.ts` converts native -> account currency -> display; through USD this equals a direct conversion (no rounding between the two), so no compounding.
- `planAccountBuffers` sums in each account's currency and converts only the total; identical formula client (`payday-checkin-dialog.tsx:87-107`) and server (`payday.ts:668-690`).
- Rounding before summation (`round2` per committed item, per category line) changes totals by at most fractions of a cent and drives no equality check.
- Every edit form prefills the stored native amount and currency (`recurring-list.tsx:163-164`, `transaction-table.tsx:210-211, 230-231`, goal/contribution dialogs), so re-saving never re-denominates; the one converted form (Budgets) is guarded by `isSameMoney`.
- `formatMoney(value, currency)` pairs checked in period-hero, step-commitments (native with `item.currency`, converted with `displayCurrency`), step-balances, upcoming-list, goal-card, accounts page: all consistent.
- Every write schema uses `z.enum(CURRENCIES)`, so an unknown currency cannot reach a row.

---

## 2. Double-counting, double-exclusion and silent drops

### D1. Safe-to-spend double-excludes what the payday plan already carved out
- **src/lib/data/period-summary.ts:111-123, 137-147**, **src/lib/data/payday.ts:467-475, 875-901**, **src/app/(app)/page.tsx:44-49**, **src/components/dashboard/period-hero.tsx:34-43**, **src/lib/i18n/en.ts:123-124**, carryover **src/lib/data/payday.ts:223-230 -> 694, 723, 736, 864-871**
- **Issue:** The plan computes `available = income + carryover - subscriptions - contributions - goals - essential - buffer`, writes Budget rows for essential + flexible categories only, and the dashboard recommends `available` as the *overall* budget. The hero then computes `safeToSpend = periodBudget - spent(all EXPENSE rows) - committed(upcoming subs + contribs)`. Worked example: income 3,000, subs 200, contribs 300, goals 200, essential 800, buffer 300 -> available 1,200, set as overall budget. Mid-period the subs (200), contribs (300) and essentials (800) post along with 600 of flexible spending: `spent` = 1,900, safe-to-spend = 1,200 - 1,900 = -700 "over the plan", while the flexible remainder is really +600. Without an overall budget the same happens via `categoryBudgetTotal` (essential + flexible only). `getAvailableCarryover` reads the previous period's understated `safeToSpend`, clamps at 0, and the result is persisted as `PaydayCheckin.includedCarryover` and the CARRYOVER allocation.
- **Severity:** user-misleading-but-harmless for the hero; feeds a persisted planning figure (carryover).
- **Confidence:** CONFIRMED.
- **Fix:** Decide what `periodBudget` denominates. Either recommend `available + subscriptions + contributions + essential` as the overall budget (gross), or, when the budget is net, restrict `spent` to budgeted categories (exclude `source: RECURRING`, subscription/savings-default categories) and drop `committed` from the subtraction. Apply the same rule in `getAvailableCarryover`.

### D2. A subscription approved from email/CSV/manual entry is posted again by recurring posting
- **src/lib/recurring-posting.ts:82-88, 120-139**, **src/server/actions/review.ts:81-109**, **src/lib/data/payday.ts:319-337**, **src/components/payday/step-commitments.tsx:83**
- **Issue:** `loadDueItems` selects on `active && nextDate <= today` only; nothing consults existing transactions. The email pipeline stages the Netflix receipt; the user approves it on Sep 10 as a GMAIL-source EXPENSE; the Netflix RecurringItem also posts a RECURRING-source EXPENSE on Sep 10. Both rows count in `spent`, the trend and monthly lifestyle. The check-in's "Already paid this period" badge (heuristic match) actively tells the user the charge is covered, but does not prevent the second posting. Same for a manually logged early payment.
- **Severity:** data-corrupting (a duplicate EXPENSE row is persisted).
- **Confidence:** CONFIRMED.
- **Fix:** Make "already paid" a real state: when a matching non-RECURRING expense exists for the occurrence window, advance `nextDate` without posting (and optionally link the row); or dedupe at approve time by offering "this is the <item> charge" which advances the item.

### D3. Heuristic matcher: one transaction per item, category-only matches, nondeterministic order
- **src/lib/data/monthly.ts:109-136 (118, 122, 131)**, **src/lib/data/payday.ts:302-317 (no `orderBy`), 336-337, 640-641**, **src/lib/payday.ts:199-203**
- **Issue:** `transactions.find` returns the first match, so the `+=` accumulation on 131 is dead. A weekly subscription auto-posted 4x in a month has one row in `committedActual`; the other three are unmatched, land in `lifestyle` (304) and are then projected (497). In the check-in, one match (the Sep 8 posting) marks a weekly item "already logged" and removes its still-due Sep 15 occurrence from `subscriptionsTotal` and the buffer math. A category-only match is also a false positive: "Gym" 50.00 in Health is marked paid by a 50.00 doctor visit in Health. Two same-amount, same-category items (Spotify/Apple Music 9.99) are disambiguated by DB row order.
- **Severity:** user-misleading-but-harmless (drives the flexible-suggestion scaling and the deficit gate, not persisted directly).
- **Confidence:** CONFIRMED.
- **Fix:** Match `source: RECURRING` rows deterministically by `externalId` prefix `${item.id}:`; for other rows collect *all* matches per item; require the name match when category+amount is shared; order items deterministically.

### D4. Editing, pausing or deleting a recurring item double-counts its posted history
- **src/lib/data/monthly.ts:120-121, 138-153, 251, 296-313, 367-378**, **prisma/schema.prisma:316** (`onDelete: SetNull`)
- **Issue:** Only currently-active items are loaded and matching requires the *current* amount and currency; `externalId` is ignored even though every RECURRING row carries `${itemId}:${date}`. Netflix posted at 15.99 in August, price edited to 17.99 in September: August is classified as 15.99 lifestyle (unmatched) + 17.99 committed (scheduled fallback, 370) = 33.98 for one charge. Pausing has the same effect for every past month. Deleting a CONTRIBUTION item nulls `recurringItemId` on its GoalContributions, so they re-enter `goalContributionTotal` (251) as "manual" while their twin RECURRING transactions still land in `savingsFromCategory`/`lifestyle` - the exact double count fixed today comes back.
- **Severity:** user-misleading-but-harmless.
- **Confidence:** CONFIRMED.
- **Fix:** Classify `source: RECURRING` rows by the item id in `externalId` (committed for SUBSCRIPTION, savings for CONTRIBUTION) regardless of the item's current amount/active state, and only apply the scheduled fallback when no RECURRING row exists for that item in the month. Give GoalContribution a durable link to its Transaction (or match on `externalId`) instead of relying on the SetNull FK.

### D5. A goal is reserved twice in the plan
- **src/lib/data/payday.ts:401-426 (411), 645-658, 692-700, 817-833**, **src/lib/data/period-summary.ts:18-30** (`CommittedItem` has no `goalId`)
- **Issue:** `contributionsTotal` (all due CONTRIBUTION items) and `goalPlanTotal` (`displayRemaining / periodsLeft` per goal) are both subtracted from `available` with no netting. Goal "Car" remaining 2,000 over 10 periods -> roadmap 200; a recurring "Car fund" contribution of 200/period to the same goal -> the plan subtracts 400 for a 200 need, and the flexible suggestions are scaled down accordingly. `listGoals().perPeriod` likewise ignores scheduled contributions.
- **Severity:** user-misleading-but-harmless (the over-reservation lands in persisted `recommendedAmount` audit rows).
- **Confidence:** CONFIRMED.
- **Fix:** Carry `goalId` on `CommittedItem` and reduce each goal's `recommendedAmount` by the due recurring contributions targeting it (floor 0).

### D6. Skipped, capped or failed recurring items disappear from every total; the posting summary is discarded
- **src/lib/data/period-summary.ts:81-88**, **src/lib/data/dashboard.ts:36-46**, **src/lib/data/payday.ts:302-307, 588-593**, **src/lib/data/context.ts:33-39**, **src/lib/data/recurring.ts:75-80**
- **Issue:** All four queries use `nextDate >= max(today, period.start)`. A skipped item (no account, archived account, no goal) is deliberately not advanced, so the day after its due date it drops out of `committed`, the "N items due before" count, the 7-day upcoming list and the check-in's subscription list, with no transaction to replace it. `RecurringPostingSummary.skipped/failed` is only `console.log`ged (`context.ts:34-36`) and returned as cron JSON; the only UI signal is the `needs` badge on the Recurring page. Example: Netflix due Sep 2 on an archived account: counted on Sep 1, gone on Sep 3, safe-to-spend overstated by 15.99 indefinitely. Archiving an account (`accounts.ts:151-156`) and deleting a goal (SetNull) both put items in this state without any warning.
- **Severity:** user-misleading-but-harmless.
- **Confidence:** CONFIRMED.
- **Fix:** Treat active items with `nextDate < today` as still owed (include in committed/upcoming, badge as overdue), and return the posting summary from `getAppContext` so the dashboard can list skipped/failed items.

### D7. Committed figures count a single stored `nextDate`; a matched item is dropped from "still due"
- **src/lib/data/monthly.ts:499-506**, **src/lib/data/period-summary.ts:81-88, 137-139**
- **Issue:** A weekly 50.00 item with Sep 11/18/25 still ahead contributes 50 (period summary) or 0 (monthly pace, because one occurrence already matched at 502). Completed months use `monthlyEquivalent` instead, so the current month and the historical average use different definitions for non-monthly items and `compareToAverage` (549-551) is biased.
- **Severity:** user-misleading-but-harmless.
- **Confidence:** CONFIRMED.
- **Fix:** Enumerate occurrences with `advanceDate` from `nextDate` through the window end, and never skip an item just because one occurrence matched.

### D8. Historical average fabricates committed amounts for months before an item existed
- **src/lib/data/monthly.ts:162-170, 138-153, 181-199, 367-378**
- **Issue:** `getFirstActivityDate` includes every Transaction type (an OPENING_BALANCE dated "as of Jan 1" opens six months of "history"), and `classifyCompletedMonth` adds each active item's scheduled amount to *every* completed month with no match, `createdAt` never being loaded. A user who starts in July and adds Netflix in August gets `sufficient: true` with five months of zero real spending but full fabricated committed/contribution totals, deflating the lifestyle average and inflating the committed average.
- **Severity:** user-misleading-but-harmless.
- **Confidence:** CONFIRMED (code); the opening-balance trigger depends on data.
- **Fix:** Restrict first activity to EXPENSE/INCOME rows and apply the scheduled fallback only for months on/after the item's `createdAt` (or its first RECURRING row).

### D9. Email ingestion permanently drops candidates beyond the per-run cap
- **src/lib/ingestion.ts:66-75, 117-124**, **src/lib/email/gmail.ts:75-79**, **src/lib/email/outlook.ts:23-28**
- **Issue:** Both providers list the newest 40 messages since `lastSyncedAt`; the transactional ones are sliced to 20; then `lastSyncedAt` is set to `now`. Anything older than the 20 kept (or beyond the 40 listed) is before the next window and is never fetched again. Gmail's day-granular `after:` gives at most a same-day overlap; Graph's `receivedDateTime ge <iso>` gives none. The comment at 20-22 ("catches up over a few syncs") is not what the code does.
- **Severity:** user-misleading-but-harmless (transactions silently never staged).
- **Confidence:** CONFIRMED.
- **Fix:** Advance `lastSyncedAt` only to the `receivedAt` of the oldest candidate actually processed when the cap was hit (or page through until the window is exhausted).

### D10. Income for a since-archived account vanishes from the confirmed check-in and from `totalIncome` on re-confirm
- **src/lib/data/payday.ts:285, 362-386, 578, 622-630, 716-727**
- **Issue:** Draft and confirm read ACTIVE accounts only. A snapshot for an archived account keeps its INCOME transaction (still in ledger income) but is omitted from the card's `totalIncome` and from `available`; re-confirming rewrites `PaydayCheckin.totalIncome` without it while the snapshot row remains.
- **Severity:** user-misleading-but-harmless (edge case; `totalIncome` is not read back anywhere today).
- **Confidence:** CONFIRMED.
- **Fix:** Include existing snapshots for archived accounts read-only in the draft's income sum and preserve them on re-confirm.

### D11. EXPENSE rows under an INCOME-kind category are in `spent` but in no breakdown
- **src/lib/data/period-summary.ts:149-154, 163-172**, **src/app/(app)/transactions/page.tsx:68-71** (category picker has no kind filter)
- **Issue:** Category lines keep only `kind === "EXPENSE"` and the Uncategorized bucket only `categoryId === null`, so such rows make `sum(lines) != spent` on Reports, Budgets and the payday history average.
- **Severity:** cosmetic.
- **Confidence:** CONFIRMED.
- **Fix:** Filter the picker by transaction type, or fold non-EXPENSE-kind spending into the Uncategorized line.

### Notes (not bugs, listed for completeness)
- CSV import has no dedup (`import.ts:98`, `externalId` null by design per the schema comment): re-importing a statement double-counts. Documented limitation.
- `transactions.ts:139-163` vs `67-79`: the header "N records" counts transfers/opening/external rows while its totals exclude them. Cosmetic.
- Archived accounts: no spending/income/pace/report query filters by account status, so views agree with each other; only the Accounts page "net" is ACTIVE-only, as labelled.

### Checked and found nothing (double counting)
- `period-summary.ts`: TRANSFER/EXTERNAL_TRANSFER/OPENING_BALANCE excluded from spent/income; overall vs category budgets never summed; Uncategorized bucket present.
- `reports.ts` uses the same type filter; every row maps to a bucket.
- `accounts.ts`: transfer legs net across accounts; `balanceSign` consistent between balances and ledger; opening balance in balance, never in cashflow.
- `transactions.ts` grouped summary excludes transfers from both totals.
- Goal cache: every GoalContribution write (manual add/delete, auto-post, goal currency edit) is followed by `recomputeGoalSaved`; nothing increments `savedAmount`.
- `recurring-posting.ts`: CAS + unique `(source, externalId)` prevent double posting; skipped items are not advanced.
- Payday `totalIncome` is entered income only; the PAYDAY_CHECKIN INCOME row is never merged back in; re-confirm updates the existing INCOME row.
- Staged PENDING rows are never read by any total; the pending count is shown on /review.

---

## 3. Date and period boundary logic

### T1. Monthly and yearly recurring dates drift permanently
- **src/lib/recurring.ts:6-18**, **src/lib/date.ts:127-137**, **src/lib/recurring-posting.ts:117, 220**, also **src/lib/import-grouping.ts:180-191**
- **Issue:** `advanceDate` computes each occurrence from the previous (clamped) one, not from an anchor day. Executed against the real functions:
  ```
  MONTHLY from Jan 31: 2026-01-31 -> 2026-02-28 -> 2026-03-28 -> 2026-04-28 -> 2026-05-28 -> 2026-06-28
  YEARLY  from 2028-02-29: 2028-02-29 -> 2029-02-28 -> 2030-02-28 -> 2031-02-28 -> 2032-02-28
  ```
  A rent item due on the 31st is charged on the 28th forever after February, and the stored `nextDate` drifts the same way. `scripts/verify-domain.ts:150` asserts only the first clamp step, so the drift is not covered.
- **Severity:** data-corrupting (transactions persisted on the wrong day, indefinitely).
- **Confidence:** CONFIRMED (executed).
- **Fix:** Keep the anchor day-of-month (store it, or derive from the item's original `nextDate`/`createdAt`) and compute occurrence *n* as `addMonths(anchor, n)`; same for YEARLY.

### T2. Weekend after a Friday-shifted payday plans the ending period and can rewrite its paycheck
- **src/lib/data/payday.ts:136-140, 710-775**, **src/app/(app)/page.tsx:36-49**
- **Issue:** `planPeriodRef` targets the next period only when `isPaydayDate(today)` is true. After today's weekend fix that is the Friday; on the Saturday/Sunday it reverts to the period that ends that weekend. Executed:
  ```
  2026-08-14 Fri isPayday=true  current=2026-08-A plan=2026-08-B
  2026-08-15 Sat isPayday=false current=2026-08-A plan=2026-08-A   <- regression
  2026-05-29 Fri isPayday=true  current=2026-05-B plan=2026-06-A
  2026-05-30 Sat isPayday=false current=2026-05-B plan=2026-05-B   <- regression
  2026-05-31 Sun isPayday=false current=2026-05-B plan=2026-05-B   <- regression
  ```
  A user paid Friday who opens the wizard Saturday sees the *old* period's confirmed plan ("Review confirmed plan"); entering the new paycheck and confirming runs the re-confirm path, which `updateMany`s the previous paycheck's INCOME row to today's date and amount (753-756) - the earlier paycheck is overwritten, and the new period still has no check-in on Monday.
- **Severity:** data-corrupting if the user confirms in that window; user-misleading otherwise.
- **Confidence:** CONFIRMED (executed; write path traced).
- **Fix:** In `planPeriodRef`, treat every day from the shifted payday through the period's real end as "plan the next period" (compare `today >= payDayOfMonth(...)` for the boundary of `currentPeriod`), and drive the auto-open the same way.

### T3. Check-in income is dated `today`, so it lands in the previous period's income figure
- **src/lib/data/payday.ts:710, 755, 761**, **src/lib/data/period-summary.ts:114-118**, **src/lib/data/reports.ts:35-46**
- **Issue:** On a payday the plan is for period P but `checkinDate = today` is the last day of P-1, so the paycheck funding P counts as P-1 income on the hero ("Income logged this period"), the reports trend and the transactions summary, while the check-in card attributes the same money to P. Every period's displayed income is one paycheck out of phase.
- **Severity:** user-misleading-but-harmless (cross-view inconsistency; may be intended as the cash date).
- **Confidence:** CONFIRMED.
- **Fix:** Either date the income row on `plan.start`, or have the period summary attribute PAYDAY_CHECKIN income by its check-in's period rather than by date.

### T5. Timestamps rendered in UTC
- **src/app/(app)/settings/page.tsx:80**, **src/components/settings/provider-connections.tsx:19**
- **Issue:** `toISOString().slice(0,16)` shows UTC wall time, not `appTimeZone()`; four hours off for the default zone.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Format with `Intl.DateTimeFormat(..., { timeZone: appTimeZone() })`.

### Checked and found nothing (dates)
- `date.ts`: `addMonths` wraps negative months correctly (`addMonths(Mar 31, -1) = Feb 28`), `daysInMonth`, strict `fromISODate`, `daysBetween` rounding, `civilDateInZone`.
- `period.ts`: `nextPeriod`/`previousPeriod` at December/January, `previousComparablePeriod(2026-01-A) = 2025-12-A`, `periodsRemaining` at the same-day, in-period, past-target and next-month edges (executed: 0, 1, 1, 0), `daysRemainingInPeriod` divides by at least 1, Feb 2028 B is "Feb 16-29".
- `month.ts`: `daysElapsedInMonth` never 0.
- `isPaydayDate` shifted days stay inside the month (earliest boundary is the 13th).
- `csv.ts` `parseDateWithFormat` validates month and day-in-month; 2-digit years map to 20xx; no `new Date(string)` on ambiguous input.
- `validation.ts` `isoDate` goes through `fromISODate`; LLM dates (`parse-transaction-email.ts:93`) likewise; email `receivedAt` only feeds the prompt.
- No client component constructs "today" itself: every default date comes from `context.today` (`transactions/page.tsx:87`, `recurring/page.tsx:46`, `goals/[id]/page.tsx:51`, `account-row-actions.tsx:129`). The only `new Date`/`toISOString` uses in `src/components`/`src/app` are the two cosmetic UTC displays above.
- `checkinPromptDismissedOn` is written from `context.today` and compared with `isSameDay` on UTC-midnight values (`page.tsx:36-38`).
- Both cron routes pass `today()`; `getAppContext` uses the same.
- Budgets/period rail `elapsed` and the transactions `from`/`to` filters parse through the shared helpers.

---

## 4. Client-trusted figures

Persisted figure -> where it comes from at write time:

| Figure | Where | Source |
|---|---|---|
| SUBSCRIPTION / RECURRING_CONTRIBUTION `recommendedAmount`, `plannedAmount`, `accountId` | payday.ts:797-816 | server (live recurring rows) |
| GOAL `recommendedAmount` | payday.ts:822-823 | server (plan-anchored recompute) |
| GOAL `plannedAmount` | payday.ts:829 | client (user's edit, by design), goal existence validated |
| ESSENTIAL/FLEXIBLE `recommendedAmount`, `basis` | payday.ts:838-841, 847-850 | server (`getCategorySuggestions`) |
| ESSENTIAL/FLEXIBLE `plannedAmount` and the Budget rows | payday.ts:839, 848, 875-901 | client (user's edit, by design), category membership validated |
| BUFFER rows and `protectedBuffer` | payday.ts:668-690, 855-863 | server (never sent by client) |
| CARRYOVER `recommendedAmount` | payday.ts:867 | server |
| CARRYOVER `plannedAmount` / `PaydayCheckin.includedCarryover` | payday.ts:694, 723, 736, 868 | **client, unvalidated** (F1) |
| `expectedLedgerBalance`, `difference` | payday.ts:744, 778-780 | server (see F3) |
| `reportedBalance`, `incomeEntered`, `incomeNote` | payday.ts:779-782 | client (user input, by design) |
| `totalIncome` | payday.ts:625-630 | server from client `incomeEntered` with server account currency |
| Dashboard "recommended overall budget" | page.tsx:44-49, period-hero.tsx:38-43, budgets/page.tsx:60-62, 103, 163 | prefill only; saved via `saveBudgetAction` with whatever the user submits |
| Approve staged: amount/date/currency/category | review.ts:81-109 | client (review edit, by design); `source`/`externalId` from the staged row |
| CSV import rows | import.ts:60-98 | re-validated; category ids checked against known ids |

### F1. `includedCarryover` is persisted as sent, never clamped to the recomputed carryover
- **src/lib/validation.ts:280**, **src/lib/data/payday.ts:587, 692-700, 723, 736, 868**, **src/components/payday/step-commitments.tsx:371-374**
- **Issue:** The server recomputes `carryover.amount` (587) but only writes it into the CARRYOVER row's `recommendedAmount`; `available`, `PaydayCheckin.includedCarryover` and the row's `plannedAmount` use `input.includedCarryover` verbatim (`z.number()`, any sign or size). The realistic trigger is a stale wizard: the draft's carryover was computed at render, transactions logged in the prior period since then change the server's figure, and the stale client value is what gets persisted and used for the deficit gate.
- **Severity:** user-misleading-but-harmless, persisted.
- **Confidence:** CONFIRMED.
- **Fix:** Clamp server-side to `[0, carryover.amount]` (the UI only ever offers those two values) and use the clamped value everywhere.

### F2. Category suggestions divide by six regardless of available history
- **src/lib/data/payday.ts:142, 186-201, 209**
- **Issue:** `historicalTotals / HISTORY_PERIODS` averages over six comparable periods even when only one or two have any data. Two periods of 300 groceries suggests 100 with basis "average".
- **Severity:** user-misleading-but-harmless (the suggestion is persisted as `recommendedAmount`).
- **Confidence:** CONFIRMED.
- **Fix:** Divide by the number of comparable periods that contain any spending (or that fall after the first activity date).

### F3. Snapshot `expectedLedgerBalance`/`difference` change meaning on re-confirm
- **src/lib/data/payday.ts:578, 744, 778-780**, **src/components/payday/step-balances.tsx:31**
- **Issue:** `account.balance` is read before the transaction. On first confirm it excludes the income about to be created, so `difference` ~ the paycheck; on re-confirm the ledger already contains that income, so `difference` ~ 0 with the same reported balance. The persisted audit trail is not comparable across confirms.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Compute `expectedLedgerBalance` excluding this check-in's own income transaction (subtract the existing snapshot's `incomeEntered` when `incomeTransactionId` is set).

### F4. `paydayConfirmSchema` has no magnitude/decimal bounds and allows duplicate ids
- **src/lib/validation.ts:252-283**, **src/lib/data/payday.ts:660-663, 742-793**
- **Issue:** `reportedBalance`/`incomeEntered`/`plannedAmount` are bare `z.number()`: a value above `AMOUNT_MAX` fails inside the transaction as a raw Decimal overflow; `100.005` is summed into `totalIncome` as-is but stored on the Transaction as 100.01. A repeated `categoryId` is summed twice in `essentialFixedTotal`, produces two allocation rows, and the last Budget write wins. The UI never sends these shapes.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Reuse the amount parser's bounds (`round2`, `<= AMOUNT_MAX`) and dedupe by id in the schema.

### F5. Reference ids are not checked for existence/status in several actions
- **src/server/actions/transactions.ts:38-40, 111-154**, **src/server/actions/recurring.ts:23-28**
- **Issue:** `accountId`/`categoryId`/`goalId` are written as sent; a missing id surfaces as a raw FK error, and a create against an ARCHIVED account is accepted (only the picker is filtered). `approveStagedAction` and `importTransactionsAction` do check.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Look up the account (ACTIVE for creates) and category/goal before writing, returning a localized `fail(...)`.

### Checked and found nothing (client-trusted)
- The file doc comment's claim holds for every "recommended" figure: all are recomputed in `confirmPaydayCheckin` from live data; the client cannot influence `recommendedAmount`, `protectedBuffer`, `expectedLedgerBalance`, or the SUBSCRIPTION/BUFFER rows.
- The dashboard recommended budget is a URL prefill (`?suggested=`) that the Budgets page never saves on its own; the eventual save goes through `budgetSchema`.
- `addContributionAction` forces the goal's currency; `saveGoalAction` recomputes the cache after a currency change; `reassignRecurringAccountAction` checks the account is ACTIVE and the item exists.
- Staged review edits only touch PENDING rows and carry `source`/`externalId` from the staged row, so the unique key still dedupes.
- CSV rows are re-parsed (`fromISODate`, positive amounts, direction/type consistency) and category ids are resolved against the known set.

---

## 5. Concurrency and idempotency

Write paths by pattern: (a) idempotent by key, (b) guarded, (c) read-modify-write unguarded, (d) multi-statement without a transaction.

| Path | Where | Pattern |
|---|---|---|
| Recurring posting occurrence | recurring-posting.ts:120-157 | (b) CAS + unique - but see K1 |
| Payday confirm | payday.ts:712-902 | (b) single tx; unique on period |
| Transfer create/edit/delete | transactions.ts:107-154, 61-68 | (b)/(a) |
| Budget save | budgets.ts:33-64 | (c) but unique-protected |
| Opening balance | accounts.ts:119-149 | **(c)+(d)** K2 |
| Goal cache rebuild | goals.ts:11-52 | **(c)** K3 |
| Staged approve | review.ts:71-118 | (c) status check, unique-protected, P2002 handled |
| Ingestion sync | ingestion.ts:61-127 | (a) skipDuplicates; `lastSyncedAt` after rows |
| Token refresh | tokens.ts:15-49 | **(c)** K4 |
| Rates upsert loop | rates.ts:70-97 | (d) but each row idempotent |
| Recurring edit / toggle | recurring.ts:23-28, 59-65 | (c) K5 |
| Settings | settings.ts, auth.ts | (a) partial upserts |

### K1. An item whose `nextDate` points at an already-posted day is stuck forever
- **src/lib/recurring-posting.ts:120-157, 205-230**, **src/server/actions/recurring.ts:23-28**
- **Issue:** `postOccurrence` claims the date with the CAS, then `transaction.create` throws P2002 because `${itemId}:${date}` already exists; the whole `$transaction` rolls back, so `nextDate` is *not* advanced, and the per-item `catch` just logs. Every subsequent run repeats the failure; the item never posts again and nothing is shown in the UI (the summary is only logged). Triggers: saving the recurring edit form after the item has posted (the form's `nextDate` was prefilled before the post and is written back verbatim at 25), or manually setting `nextDate` to a past date that already has a row. This is the idempotency gap next to the CAS.
- **Severity:** data-corrupting (a persisted process stalls silently).
- **Confidence:** CONFIRMED.
- **Fix:** Treat P2002 on the Transaction create as "already posted": keep the `nextDate` advance and skip the row (e.g. `create` inside a savepoint, or check `findUnique` by `(source, externalId)` before creating). Surface `itemsFailed` on the dashboard.

### K2. `setOpeningBalance` can create two opening-balance rows
- **src/lib/data/accounts.ts:119-149, 72-77**
- **Issue:** `findFirst` then `create`, no transaction, no unique key on `(accountId, type = OPENING_BALANCE)`. Two submits (second tab, retried request) both see no existing row and both insert; `balance` then includes both while the Accounts UI shows only the last one (`Map` keeps the last).
- **Severity:** data-corrupting if triggered.
- **Confidence:** CONFIRMED pattern; PLAUSIBLE trigger (the dialog's submit button is disabled while pending, so it needs two tabs or a retry).
- **Fix:** Add a partial unique index on `("accountId") WHERE type = 'OPENING_BALANCE'` and upsert against it, or wrap in `$transaction` with the count check inside.

### K3. `recomputeGoalSaved` lost update
- **src/lib/goals.ts:11-52**, **src/server/actions/goals.ts:77-86, 107-108**, **src/lib/recurring-posting.ts:159-163**
- **Issue:** Interleaving A.create, A.read(A only), B.create, B.read(A+B), B.write, A.write leaves the cache at A's stale sum. Self-heals on the next contribution or Settings "Recalculate goals".
- **Severity:** user-misleading-but-harmless.
- **Confidence:** PLAUSIBLE (single user; needs overlapping posting + manual contribution).
- **Fix:** Run aggregate + update inside one transaction with `SELECT ... FOR UPDATE` on the goal, or recompute from a DB aggregate in the same statement.

### K4. Concurrent Microsoft refreshes can persist the older rotated refresh token
- **src/lib/email/tokens.ts:39-48**, **src/lib/ingestion.ts:71, 133-158**, cron + manual "Sync now" both call `runIngestion`
- **Issue:** Two overlapping syncs both refresh with the same refresh token; Microsoft rotates it, and whichever `update` lands last wins. If the loser's (older) token is stored and the provider has invalidated it, the connection breaks until reconnect.
- **Severity:** user-misleading-but-harmless (sync silently fails; logged only).
- **Confidence:** PLAUSIBLE (depends on provider reuse window).
- **Fix:** Serialize refreshes per connection (advisory lock or `updateMany` where `accessTokenExpiresAt` equals the value read).

### K5. Recurring edit writes every field from a possibly stale form
- **src/server/actions/recurring.ts:23-28**, **src/lib/data/recurring.ts:109-112**
- **Issue:** `update({ data: values })` overwrites `accountId`, `nextDate`, `amount` with what the form was rendered with; a reassignment made from the payday wizard in another tab is clobbered. Also the source of K1's stale `nextDate`.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Compare against the current row and write only changed fields, or send a version/updatedAt and reject stale saves.

### K6. Find-then-create collisions surface as raw errors
- **src/server/actions/budgets.ts:33-64**, **src/lib/data/payday.ts:713-740**, migration `20260831000000_init/migration.sql:211, 246`
- **Issue:** Both are protected by unique indexes, so no duplicate is possible, but a P2002 from a concurrent save is not caught (only `review.ts` handles it) and reaches the user as a generic error.
- **Severity:** cosmetic. **Confidence:** CONFIRMED.
- **Fix:** Use `upsert` where the key is fully known, or catch P2002 and retry once.

### Checked and found nothing (concurrency)
- `postDueRecurringItems`: CAS on `nextDate` inside the tx plus the unique key; overlapping cron and page-load runs cannot double-post; a concurrent `active=false` stops the loop via the CAS predicate.
- Ingestion: `lastSyncedAt` is captured before the fetch and written after `createMany`, so a crash mid-run re-fetches rather than losing; `skipDuplicates` covers overlapping runs. (D9 is a logic bug, not a race.)
- Transfers: both legs created/updated in one `$transaction`; delete uses a single `deleteMany`.
- `deleteTransactionAction` on a PAYDAY_CHECKIN income row leaves `incomeTransactionId` dangling, but re-confirm handles a 0-count update by creating a new row (payday.ts:749-771).
- Settings and PIN writes are partial upserts on the singleton; no whole-row overwrite.
- OAuth state is a per-provider httpOnly cookie; session tokens are HMAC with expiry; no in-memory state that must be shared (only `lastFailureAt` backoff, per instance, harmless).
- `getAppContext` is `cache()`d per request; the catch-up runs at most once per render.
