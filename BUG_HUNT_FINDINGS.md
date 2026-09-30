# Bug hunt: wrong-but-plausible numbers (2026-09-28)

Scope: the whole codebase, for the bug class described in the brief: values
reused past their valid range, estimates that ignore an end condition,
consumers that disagree, double counting or omission, date and period
boundaries, currency, denominators, copy that overstates its basis, silent
fallbacks, and idempotency. The projectPeriods goal-window bug fixed in
0ba225e is not reported again.

How the evidence was produced:
- Every finding below was reproduced by me, either as a pure-function call
  or on a throwaway database (`cadence_bughunt_scratch`: created, migrated,
  seeded with the default categories, filled with fictional `Fict …` rows,
  and dropped at the end). Nothing ran against `cadence_dev` or production.
- Contexts were built by hand: display currency USD unless noted, rates
  USD 1 / DOP 60 / EUR 0.9, and a buffer of 10% with a 2,000 DOP floor.
- A few findings rest on a precise code path plus a numeric scenario rather
  than a run. Each one says so under "Evidence".
- The repro scripts are outside the repo, in the session scratchpad. No
  source, test or config file was changed.

Severity is about risk to real money: **High** means a wrong figure the user
acts on, or a ledger row that is wrong or missing, in an ordinary scenario.
**Medium** is the same in a narrower scenario. **Low** is a narrow trigger, a
small amount, or display only. **Very low** is an edge case of an edge case.
Confidence is about whether the defect is real, not how often it happens.

---

## High

### B1. Afford's current period sets full average income against only the commitments still ahead
- **What:** `loadScheduledCommitments` walks `owedOccurrences(item, context.today, …)`. For the period containing today, it therefore counts only what is still due from today on. Anything already posted this period (rent on the 16th, say) disappears from `committed`. Income, meanwhile, is a full-period average.
- **Where:** `src/lib/data/afford.ts:346-352`, feeding `evaluateAffordability` at `src/lib/afford.ts:294-326`.
- **Also affected:** the recurring form's subscription room check (`src/lib/data/subscription-room.ts:96-110`, whose reference period is today's) and the tracker's re-check of any installment in the current period.
- **Repro (DB):**
  - Setup: account income 60,000 DOP in every comparable B period, and a 30,000 DOP rent subscription on the 16th, posted 2026-09-16.
  - On 2026-09-28, a 30,000 purchase dated 09-28 gives: `income=60000 committed=0 buffer=6000 headroomBefore=54000 → after 24000, viable=true`.
  - The same purchase in Oct B, with rent still ahead, gives: `committed=30000 headroomAfter=-6000 viable=false`.
  - The Sep B answer should be 60,000 − 30,000 − 6,000 − 30,000 = −6,000.
- **Who / direction:** anyone evaluating a purchase, or adding a large subscription, whose first charge lands in the current period after that period's bills have posted. Afford overstates room by everything already charged this period, typically rent and most subscriptions.
- **Severity / confidence:** High / High. Evidence: DB run.
- **Fix:** for the current period, count every occurrence due from the period's start, whether posted or still owed. Build the income side on the same basis. Alternatively, for the current period, use the real ledger: income received this period, minus charges posted, minus what is still owed.
- **Status:** fixed. The current period now counts every occurrence due in it: the RECURRING rows already posted and the charges that settled an occurrence (RecurringSettlement), plus what is still owed from today, each occurrence key once. The same code covers a confirmed current period, the subscription room check and the tracker's re-check, whose excluded plan keeps its own posted installments counted.

### B2. One logged charge cancels several occurrences of a recurring item (posting and check-in)
- **What:** posting's "already logged" test reloads every non-RECURRING charge in the occurrence's pay period on each run. Its `consumed` set lives for one run only. A charge that already paid for one occurrence therefore pays for the next occurrence in the same period on the next run.
- **Check-in side:** the draft counts every matched charge in the plan period against only the occurrences still owed, so it makes the same mistake.
- **Where:** `src/lib/recurring-posting.ts:168-182` (`loadLoggedCharges`), `:438` (`consumed` is per run) and `:201-241`. For the check-in: `src/lib/data/payday.ts:794-812` and `:595-605`.
- **Repro (DB):**
  - Setup: WEEKLY 500 DOP gym due 09-03, and a manual 500 DOP expense on 09-02 in the same category.
  - Run on 09-03: `alreadyLogged=1 posted=0`. Run on 09-10: `alreadyLogged=1 posted=0`. The ledger holds only the one 500 payment for two occurrences.
  - Check-in variant: the Oct 2 occurrence is consumed by an Oct 1 charge. The Oct A draft on Oct 3 then shows `occurrences=1 logged=1 outstanding=0` for Oct 9.
- **Who / direction:** weekly and biweekly items, and SEMI_MONTHLY items with both anchors in one half of the month, whenever one occurrence is paid by hand. Expenses are omitted from the ledger, so balances run high, and the check-in reserves nothing for a charge still due.
- **Severity / confidence:** High / High. Evidence: DB runs.
- **Fix:** tie a logged charge to the occurrence it settled. Either persist the link (the charge's id on the consumed occurrence, or a marker row), or skip charges already credited to an earlier occurrence of the same item. Apply the same pairing in `loggedOccurrencesByItem`.
- **Status:** fixed. Posting records each settled occurrence as a `RecurringSettlement` row (charge id and occurrence key, both unique), written in the claim's own transaction, so a charge settles at most one occurrence ever, and `loggedOccurrencesByItem` reads posting's per-occurrence verdicts instead of a per-period count.

### B3. Posting matches items one at a time, so one charge cancels look-alike items the check-in keeps apart
- **What:** `findLoggedCharge` passes a single item to `matchRecurringToTransactions`. The matcher's ambiguity guard (same amount and category on two items means the name must match) therefore never triggers. `consumed` is also scoped to one item, so the same charge can cancel an occurrence of every look-alike item.
- **Where:** `src/lib/recurring-posting.ts:224-238`; guard at `src/lib/data/monthly.ts:164-184`.
- **Repro (DB):**
  - Setup: two MONTHLY 50 USD subscriptions in the same category, Gym (10-05) and Therapy (10-10), plus a manual 50 USD expense on 10-03 with note "Dr. Perez visit".
  - The Oct A check-in says `Gym alreadyLogged=false, Therapy alreadyLogged=false`.
  - Posting through 10-10: `alreadyLogged=2 posted=0`. One 50 USD charge cancelled 100 USD of occurrences.
- **Who / direction:** any two recurring items with the same amount, currency and category, which is common for fixed-price services. Charges are omitted and balances overstated. The check-in and posting disagree.
- **Severity / confidence:** High / High. Evidence: DB run.
- **Fix:** match against all due items at once, as the check-in does, and let a charge be consumed by at most one item. B2's persisted pairing also covers this.
- **Status:** fixed. One planner, `planSettlements` in `src/lib/recurring-settlement.ts`, matches every item's occurrences together in due-date order with the look-alike guard judged over all active items, and both posting and the check-in use it.

### B4. Resuming a paused item, or raising an achieved goal's target, back-posts every skipped occurrence
- **What:** pausing leaves `nextDate` where it was. So does the `goal_achieved` skip. On resume or re-activation, posting walks every missed occurrence, up to 24, and writes a dated ledger row for each. Money that never moved lands in past periods. Restoring an archived account (skip reason `account_archived`) does the same.
- **Where:** `src/server/actions/recurring.ts:100-122` (the toggle only flips `active`); `src/lib/recurring-posting.ts:140-144` (skip without advancing, by design) and `:439-474`.
- **Repro (DB):**
  - A 15.49 USD monthly item paused with `nextDate` 2026-02-15, resumed on 09-28: `posted=8`, dated Feb 15 through Sep 15.
  - A 5,000 DOP monthly contribution whose goal was achieved in March (`nextDate` stuck at 04-01), with the target raised on 09-28: `posted=6`, dated Apr 1 through Sep 1. That is 30,000 DOP out of the account and into the goal.
- **Who / direction:** anyone who pauses a subscription while it is cancelled or suspended, or whose auto-contribution parks on a reached goal. Expenses are overstated and balances understated, backdated into closed periods. Goals are over-credited.
- **Severity / confidence:** High / High. Evidence: DB runs.
- **Fix:** on resume, on re-activation after `goal_achieved`, and on account restore, move `nextDate` to the first occurrence on or after today. Posting the backlog should need an explicit confirmation from the user.
- **Status:** fixed. Every transition that makes a skipped item postable again (resumed, a goal leaving the achieved state, an account restored or assigned, or a goal, kind or active flag changed through the Recurring form) now moves an overdue `nextDate` to the first occurrence on or after today with posting's own recurrence rules (`skipMissedOccurrences`), leaves `remainingOccurrences` alone because the skipped occurrences were never charged, and keeps a date the user types by hand; an item that is merely overdue after a failed run keeps its backlog.

### B5. No de-duplication against an already-posted RECURRING row
- **What:** posting runs at 00:15 local (cron) and on every request, so the RECURRING row for a charge is normally written before the real charge arrives by CSV, email approval or manual entry. None of those paths compares against RECURRING rows:
  - The CSV duplicate check looks only at `source: "CSV"`.
  - Approving an email writes the expense without any check.
  - The manual form does not check either.
- **Where:** `src/lib/data/import-duplicates.ts:59-66`; `src/server/actions/review.ts:81-94`; the create path of `saveTransactionAction`.
- **Repro (DB):**
  - A Netflix item of 15.49 posted on 2026-10-15.
  - `findCsvDuplicates` for the bank's own 2026-10-15 15.49 row reports `0` matches, so the import writes a second expense.
- **Also:** a paycheck recorded by a check-in (a PAYDAY_CHECKIN income row) and later imported from the bank CSV is doubled the same way. The CSV check ignores non-CSV rows.
- **Who / direction:** anyone who both auto-posts recurring items and imports statements or approves receipts. That is exactly the workflow the import-review and "looks recurring" features encourage. Expenses (or income) are doubled and balances are off by each duplicate.
- **Severity / confidence:** High / High. Evidence: DB run; the approve and manual paths by code path.
- **Fix:** in CSV duplicate detection and in approval, flag a candidate that matches a RECURRING or PAYDAY_CHECKIN row on the same account within the occurrence's period, using the posting matcher. Offer "this is the posted charge" as the resolution, which replaces or links the row instead of adding one.
- **Status:** fixed. The CSV import, receipt approval and the manual form now run `planPostedDuplicates` (settlement's window, look-alike guard and one-to-one rule, plus a 3% cross-currency "possible match" warning) against RECURRING and PAYDAY_CHECKIN rows on the same account, and a match is written only after the user says whether it is the posted charge (nothing added; a RECURRING row takes the incoming amount and currency) or a different one. A same-currency match on a recurring item is exact (skipped by default, refused unanswered) when the incoming row names the item or shares its category (when that category tells the item apart), or lands within 4 days (`PROXIMITY_DAYS`) of the posted row; further away with neither, it is only a "possible match" warning like the cross-currency one - shown with what it matched, imported by default and never refused unanswered - and within one batch exact matches claim posted rows before possible ones, so a same-amount charge from another merchant is never silently skipped and bank text that does not repeat the item's name is still caught.

### B6. The CSV amount parser reads "1,500" as 1.50
- **What:** `parseAmount` treats any comma after the last dot as a decimal comma. A whole-number amount with a thousands comma becomes a thousandth of itself; nothing warns and the row imports as valid. The typed-amount parser reads the same text correctly.
- **Where:** `src/lib/csv.ts:138-145`, used for both the amount and the "your share" column at `src/components/import/csv-importer.tsx:210, 232`.
- **Repro (pure):**
  - `"1,500"` gives csv=1.5, typed=1500.
  - `"-1,250"` gives csv=-1.25.
  - `"RD$ 12,345"` gives csv=12.345, rounded to 12.35 on import.
  - `"1,500.00"` gives 1500 (correct).
- **Who / direction:** imports from any bank that exports whole-peso amounts with a thousands separator. The amounts are understated by 1000x.
- **Severity / confidence:** High / High (how often it bites depends on the bank's format). Evidence: pure run.
- **Fix:** use `parseAmountInput`'s rule: a lone comma followed by exactly three digits is a thousands separator. Also surface rows whose parse is ambiguous rather than silently accepting them.
- **Status:** fixed. `parseAmount` now delegates to `parseAmountInput`, so "1,500" is 1500 in both and a row whose amount cannot be read is skipped as invalid instead of imported as a guess.

### B7. Afford's checks ignore essential fixed categories, yet show the check-in's "Available for flexible categories" label
- **What:** `evaluateAffordability` calls `availableForFlexibleCategories` with `essentialFixed: 0`. The check-in subtracts the essential fixed budgets (rent, utilities kept as "Essential fixed categories" rather than as recurring items) before flexible. The per-account check (income − committed − buffer) ignores them too.
- **Where:** `src/lib/afford.ts:314-326` and `:294-296`.
- **Repro (pure):**
  - Projection for one period: income 60,000, committed 3,000, buffer 6,000, essential fixed 30,000.
  - Afford gives `availableBefore=51000`; after a 20,000 purchase, `31000 viable=true`.
  - The check-in's own formula gives 21,000, and 1,000 after the purchase. A 25,000 purchase passes Afford (26,000 left) but leaves the plan 4,000 short.
- **Who / direction:** users who keep rent or fixed bills as essential category budgets rather than recurring items. Afford overstates room by the essential total.
- **Severity / confidence:** High / High. Evidence: pure run.
- **Fix:** project essential fixed spending per period, from the essential categories' last budget or suggestion (`getCategorySuggestions`), and subtract it in both checks. At minimum, change the label and copy so the figure is not presented as the check-in's.
- **Status:** fixed. Both checks subtract the essential fixed categories as the check-in fills them (the period's budget, else a confirmed allocation, else `getCategorySuggestions`). Each account carries its share of projected income, and the results page shows the amount and its basis, or says nothing is assumed when there is no data.

### B8. A salary that moved between accounts is projected in both
- **What:** `averageSinceFirstActivity` runs per account, from each account's own oldest non-zero period. When pay moves from account A to account B, A keeps averaging its old pay over six periods while B averages its new pay over one.
- **Where:** `src/lib/data/afford.ts:156-165`, called per account at `:452`; period-wide income is summed at `:512`.
- **Repro (DB):**
  - Setup: 2,000 in "Old Bank" in Apr A–Aug A, then 2,000 in "New Bank" from Sep A. Both accounts stay active.
  - Oct A projection: `projected period income (all accounts) = 3666.67 (real recurring pay = 2000)`. New Bank's own figure is 2,000.
- **Who / direction:** anyone who changes the account their pay lands in and keeps the old account open. Afford's period-wide check, the goal estimate's headroom and the goal forecast all overstate income by up to about 5/6 of a paycheck, decaying over six comparable periods (about six months).
- **Severity / confidence:** High / High. Evidence: DB run.
- **Fix:** start every account's divisor at the oldest period with income in any account (a global first-activity index) rather than per account. A zero in an account that used to be paid is then a real zero. Mention "count income history from" as the manual override.
- **Status:** fixed. `incomeHistoryDepth` counts every account from the oldest comparable period with income in any account, and the income copy names "Count income history from" as the manual override.

---

## Medium

### B9. The check-in's per-account room ignores recurring contributions, so goal funding is drawn from money already committed
- **What:** `bufferInputs` passes only subscriptions to `planAccountBuffers`. An account's headroom for goal funding therefore still includes what its recurring contributions will take. Afford subtracts both kinds.
- **Where:** `src/lib/data/payday.ts:633-654` (draft) and `:1250-1274` (confirm).
- **Repro (DB):**
  - Setup:
    - Account A: income 50,000 DOP, a 10,000 subscription and a 20,000 recurring contribution to goal X.
    - Account B: income 20,000.
    - Goal Y: roadmap 30,000.
  - The draft funds Y with `A:19811.32 B:10188.68`. A then ends at 50,000 − 10,000 − 20,000 − 19,811.32 = **188.68**, against a 5,000 buffer.
  - The period-wide total still balances, so no deficit prompt appears.
- **Who / direction:** users with recurring contributions and goal funding on the same account. Per-account room is overstated, and the account ends below its buffer or overdrawn.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** pass outstanding recurring contributions to `planAccountBuffers` next to subscriptions, in both draft and confirm.

### B10. Posting and the check-in judge "already paid" over different charges, so one payment yields a posted duplicate
- **What:** there are two mismatches:
  - Posting only looks at charges on the item's own account; the check-in looks at every account.
  - Both look only inside the occurrence's own pay period, so a bill paid a day early, across the boundary, is missed.
- **Where:** `src/lib/recurring-posting.ts:170-178`, `:207-214`; `src/lib/data/payday.ts:794-797`.
- **Repro (DB):**
  - Netflix is due 09-20 on "Visa", but 15.49 was logged on "Checking" on 09-18. The check-in says `alreadyLogged=true outstanding=0`; posting on 09-20 still writes a second 15.49 row.
  - Rent of 900 is due 10-01 and was paid and logged on 09-30. The Oct A check-in reserves 900 (`alreadyLogged=false`), and posting on 10-01 writes a duplicate 900 row.
- **Who / direction:** bills paid early or from another account. Expenses are doubled, or the plan reserves money that has already left.
- **Severity / confidence:** Medium / High. Evidence: DB runs.
- **Fix:** use one candidate set for both: every account, plus a window of a few days before the period start for an item due in the first days of a period. Then apply B2's one-charge-one-occurrence pairing.
- **Status:** fixed. Posting and the check-in now share one candidate set: every account, and each occurrence's pay period extended back to five days before the due date (`SETTLEMENT_LEAD_DAYS`, which covers a payday pulled back to Friday before a period starting on the 1st or 16th); the persisted pairing stops an early charge from settling two occurrences.

### B11. A goal pace netted of the plan period's recurring contributions is reused in every period
- **What:** `goalRoadmapAmount` subtracts the plan period's own recurring contributions to the goal. Afford, and the goal forecast built on it, then repeat that net figure in every period of the window, while each period's real contributions are also counted as scheduled commitments. The error equals the difference in contribution counts per period, and its sign flips with which half of the month "today" is in.
- **Where:** `src/lib/data/payday.ts:356-363, 395-414`; `src/lib/data/afford.ts:411-413, 435-439, 469-477`; `src/lib/data/goal-forecast.ts:41-64`.
- **Repro (DB):**
  - Setup: goal 3,000 due 2027-03-31, with a 100 monthly contribution on the 20th.
  - Today Oct 5 (plan Oct A): A periods are 0 + 250 (right) and B periods 100 + 250 = **350** (100 too much).
  - Today Oct 16 (plan Oct B): B periods are 100 + 172.73 (right) and A periods 0 + 172.73 (**100 too little**).
- **Who / direction:** anyone with a dated goal that is also auto-funded. Afford understates room in half the periods and overstates it in the other half, by the contribution amount each time. The Inbox forecast raises or misses "can't keep the pace" accordingly.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** give Afford the gross pace (remaining ÷ periods left). Per period, subtract that period's own scheduled contributions to the goal, floored at 0.
- **Status:** fixed (K3, QUANTITIES_MAP.md D5). Afford and the goal forecast ask each period its own by-hand figure: the pace fixed at the plan period's start, less that period's own recurring contributions to the goal (already among its commitments). Harness ("a goal's period plan (K3)", D5 / B11): a 30,000 goal due Dec 30 with a 2,000 contribution on the 10th is asked 5,000 in the B periods and 3,000 in the A periods, by the forecast and by Afford, before and after the contribution posts (was 3,000, then 4,666.67, in every period).

### B12. The debt comparator reads the netted pace as the minimum payment, so a debt paid by an auto-contribution shows as never paid off
- **What:** `listDebtGoals` sets each dated debt's `minimum` to the roadmap pace. That pace is net of recurring contributions, and the simulation never adds those contributions back. The minimum also flips between the A and B plan halves (see B11).
- **Where:** `src/lib/data/debt-payoff.ts:36-47`; `src/lib/debt-payoff.ts:104-108`.
- **Repro (pure):**
  - Car loan 12,000 over 3 periods with 4,000 due this period, so pace 0. Card 3,000 with 1,000 due, so pace 0.
  - `compareDebtStrategies` gives `{"avalanche":null,"snowball":null,"flow":0}`. The page reads "Nothing reaches these debts yet: none has a target date", which is false.
- **Who / direction:** debts funded by recurring contributions. The time to payoff is overstated, up to "never".
- **Severity / confidence:** Medium / High. Evidence: pure run on the real `goalRoadmapAmount` and `compareDebtStrategies`.
- **Fix:** use the gross pace (or the pace plus the scheduled contribution) as the minimum, and fix the `debtNothingFlowing` condition.
- **Status:** fixed (K3, D6). The comparator's minimum is the gross pace; what already went into a debt in the plan period is passed beside it (period 1 is not paid twice), and a debt's target period asks whatever it still owes. Two debts paid by 4,000 and 1,000 contributions: minimums 3,000 and 750, both paid off in period 4 (was flow 0, "never"). The "nothing flowing" note is now true when it shows: only undated debts and no extra leave the flow at 0.

### B13. The roadmap is recomputed live, so a recurring contribution posting mid-period raises a false "behind roadmap"
- **What:** the pace is (live remaining ÷ periods left from the plan start) − (contributions still due in the plan period). When the plan period's contribution C posts, remaining drops by C and the "still due" offset drops to 0, but the period count stays the same. The pace therefore rises by C·(n−1)/n. A confirmed plan that followed the roadmap exactly is then flagged.
- **The reverse case:** a manual contribution mid-period lowers the Goals page's "per pay period" to (R−C)/n while the periods still ahead need (R−C)/(n−1).
- **Where:** `src/lib/data/payday.ts:356-414, 464-538`; `src/lib/insights.ts:280-321`; `src/app/(app)/goals/[id]/page.tsx:192-208`.
- **Repro (DB):**
  - Setup: goal 1,200 due Dec 31 and a 100 contribution on Oct 10. On Oct 1 the roadmap is 100, and the Oct A check-in is confirmed with 100.
  - After the 10-10 posting: `roadmap=183.33 planned=100`. The Inbox shows "Fict Trip is behind its roadmap | Behind by=83.33, Room couldn't cover=83.33".
- **Who / direction:** every dated goal with a recurring contribution, every period. A false alarm; it also claims the room could not cover the pace, which is false.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** measure a period's roadmap against the balance at the plan period's start, adding back contributions dated inside the plan period, so it stays fixed through the period.
- **Status:** fixed (K3, D4). The pace is fixed at the plan period's start and the period's scheduled contributions are counted whole, so a posting mid-period moves neither: 3,000 by hand before and after the Oct 10 posting, no "behind" insight.

### B14. Items that will never post still count as committed and still net the roadmap, and the alert says the opposite
- **What:** `getPeriodSummary`, the check-in draft and confirm, and the Goals page's due-contribution netting all include items that posting skips forever:
  - contributions to an achieved goal;
  - contributions or subscriptions with no account.
  - Afford leaves out the achieved-goal case (`afford.ts:344`); posting skips all of them.
  - Separately, the dashboard's not-posting alert says these items "are missing from your committed total" when they are in it.
- **Where:** `src/lib/data/period-summary.ts:147-151, 294-316`; `src/lib/data/goals.ts:24-54`; `src/lib/data/payday.ts:366-373`; copy at `src/lib/i18n/en.ts:231-232` / `es.ts:220-221`.
- **Repro (DB):**
  - Achieved goal with a 200 monthly contribution: posting reports `skipped=goal_achieved`. Yet Oct B `committed=400 (x2, overdue)`, Nov A 200, Nov B 400, and the Oct B check-in reserves `contributions total=400`.
  - Unlinked 100 contribution to a 1,200/6-period goal: `roadmap=100 Goals page perPeriod=100` where it should be 200. Posting on 10-10: `skipped=missing_account`.
- **Who / direction:**
  - The check-in under-allocates flexible money every period by money that will never leave.
  - The roadmap and "per pay period" understate what the goal needs, and the goal falls behind silently.
- **Severity / confidence:** Medium / High. Evidence: DB runs.
- **Fix:** apply posting's `skipReasonFor` in `getPeriodSummary`, in `loadDueContributionsByGoal` and in the check-in. List skipped items separately rather than silently leaving them out. Fix the alert copy to match.
- **Status:** fixed. The committed half was fixed with K2 (D7); the goal-netting half holds under K3: a goal's `scheduled` is K2's whole occurrences, which leave out every item posting will skip, so such an item lowers no pace - the Goals page, the roadmap, the forecast and Afford all ask 200 of the 1,200 goal next to a 100 contribution with no account.

### B15. A posting backlog keeps contributing after the goal is reached part-way through the run
- **What:** `skipReasonFor` is evaluated once per item, from the row loaded before the loop, and the backlog walk never re-checks `achievedAt`.
- **Where:** `src/lib/recurring-posting.ts:402-474`.
- **Repro (DB):** a 5,000 DOP goal with a 5,000 monthly contribution and three overdue occurrences gives `contributions posted=3, savedAmount=15000`.
- **Who / direction:** backlogs, after a cron outage, an account restore or B4. Money leaves the account for an already-funded goal, so the goal is over-credited and the balance understated.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** before each contribution claim, re-read the goal's remaining balance inside the transaction and stop at achievement. Optionally cap the last contribution at the remaining amount.
- **Status:** fixed. Before each contribution it would write, the claim locks the goal row and re-sums its contributions inside the write transaction, and a reached goal leaves that occurrence and the rest of the backlog unclaimed (reported as `goal_achieved`); the last contribution is not capped, matching single posted and manual contributions today.

### B16. A contribution occurrence consumed as "already logged" never reaches the goal
- **What:** when a same-amount, same-category expense exists in the period, the occurrence is rolled forward with no GoalContribution. The "already logged" branch returns before the contribution is written.
- **Where:** `src/lib/recurring-posting.ts:295-299`.
- **Repro (DB):**
  - Setup: 5,000 DOP contribution due 09-20 in the Savings category, and a CSV "Transfer to savings" of 5,000, Savings, dated 09-17.
  - Result: `alreadyLogged=1, contributions=0, savedAmount=0`.
- **Who / direction:** users who import bank statements, or log their own transfer to savings. The goal is understated by every consumed occurrence.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** for CONTRIBUTION items, never consume by category alone. Either require a manual-contribution twin (`goal-contribution:` externalId), or create the GoalContribution linked to the matched charge instead of skipping it.
- **Status:** fixed. A matched charge that settles a contribution occurrence becomes that contribution's twin: posting writes the GoalContribution with the occurrence key (dated and sized from the charge), and every twin reader (monthly pace, period budget, transaction list lock, edit and delete cascades, the audit) recognises the pair; a hand-logged contribution's own expense settles only its own goal's occurrence and adds nothing.

### B17. Afford accepts a first payment in the past, judges past periods with no commitments, then back-posts immediately
- **What:** `affordInputSchema.firstDate` has no lower bound. Past installments are evaluated in their own past periods, where the commitment walk (which starts at today) finds nothing. After "I bought this", the next request posts every past installment. `recurringSchema.nextDate` behaves the same way (see B27).
- **Where:** `src/lib/validation.ts:704` (and `:377`); `src/lib/data/afford.ts:346-348, 604-609`.
- **Repro (DB):**
  - Setup: rent of 1,500 already posted on Aug 5 and Sep 5; a 600 sofa in 3 payments with first date 2026-08-05, evaluated on 09-28.
  - The verdict shows `2026-08-A committed=0 headroomAfter=1600 | 2026-09-A committed=0 headroomAfter=1300`.
  - Confirming then posts `2026-08-05 200, 2026-09-05 200` at once.
- **Who / direction:** recording a purchase made weeks ago. The verdict overstates room in those periods, and backdated rows land in closed periods.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** reject a past first date, or treat installments before today as already paid: exclude them from the checks, count down `remainingOccurrences`, and start `nextDate` at the first future one.
- **Status:** fixed. Installments dated before today are treated as already paid: they are left out of the checks and of what "I bought this" records (the countdown and `nextDate` start at the first payment still ahead, the anchor stays the plan's own), a plan with none ahead is refused, and the schedule and the Record it note say which payments count as paid.

### B18. Email ingestion permanently drops receipts when the parsing call fails
- **What:** `parseTransactionEmail` returns `null` on any API error (rate limit, 5xx, bad key), which is the same value as "not a transaction". `syncConnection` then advances `lastSyncedAt` to `now` unless the account cap or provider truncation applies. Both the cron and "Sync now" report success.
- **Where:** `src/lib/llm/parse-transaction-email.ts:102-105`; `src/lib/ingestion.ts:96-100, 205-217`.
- **Repro (pure, offline):** with the SDK pointed at a dead local port: `parse result when the API is unreachable: null`.
- **Who / direction:** Gmail and Outlook users, during any API outage. Every receipt in the window is omitted for good, with no signal.
- **Severity / confidence:** Medium / High. Evidence: offline run plus code path.
- **Fix:** return a distinct failure from the parser. On any failure, do not advance the cursor past the oldest failed message, and report the failure count.
- **Status:** fixed. `parseTransactionEmail` now returns parsed, "not a transaction" or failed (with a reason), a sync holds `lastSyncedAt` at the oldest failed message (or the cap or truncation boundary if that is earlier), skips messages already staged by their key before any LLM call, and reports the failure count in the sync result, the "Sync now" message and the cron's 500 response and logs.

### B19. An account balance re-converts every foreign-currency row at today's rate
- **What:** `getAccountBalances` converts each row into the account's currency with the current rate table. A USD subscription posted to a DOP account (posting keeps the item's currency) changes the DOP balance whenever the rate moves.
- **Where:** `src/lib/data/accounts.ts:85-90`; rows written by `src/lib/recurring-posting.ts:313-325`.
- **Repro (DB):** a 100 USD charge on a DOP account shows a balance of `-6000` at rate 60 and `-6300` at rate 63.
- **Who / direction:** accounts holding rows in another currency (card subscriptions billed in USD). The balance drifts with the rate. The check-in then sees a reconciliation gap that caps the flexible budget, although no money moved.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** store the amount in the account's currency at posting and entry time (as manual contributions already do), or store the rate used, and sum stored native amounts.

### B20. The monthly pace extrapolates a confirmed one-off (and full shared amounts) by days elapsed
- **What:** `getCurrentMonthPace` projects lifestyle spending as (so far ÷ days elapsed) × days in month. The input keeps extraordinary rows and full shared amounts. The average it is compared with (`typicalOnly`) excludes them.
- **Where:** `src/lib/data/monthly.ts:737-747`; comparison at `:783-800`.
- **Repro (DB):**
  - Setup: 30,000 DOP of lifestyle spending in each of Jun, Jul and Aug, and a 30,000 laptop marked one-off on Sep 3.
  - On Sep 3: `lifestyleSpentSoFar=30000 projectedLifestyle=300000`, against an average of 30,000. The card reads roughly "270,000 above your average".
- **Who / direction:** any one-off or shared expense early in the month. The projection overstates spending by a factor of up to about 30. This contradicts the one-off prompt's promise (`en.ts:527`) that one-offs are kept out of the monthly pace's averages.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** extrapolate only typical spending (`typicalOnly`), then add one-offs and others' shares as a separate, non-extrapolated line.
- **Status:** fixed. `getCurrentMonthPace` now projects only typical spending (one-offs out, shared expenses at the user's share, the same population the average is made of) and reports the rest as `setAsideSoFar`, which the Dashboard card shows as its own "not projected" line and counts once, unprojected, in its total cash outflow.

### B21. Carryover is counted in the new plan while the previous period is still spendable (weekend payday)
- **What:** after a Friday payday, the plan period is the next one, and `getAvailableCarryover` reads the ending period's `safeToSpend`. The dashboard still offers that same money for the remaining weekend days of the ending period.
- **Where:** `src/lib/data/payday.ts:549-556`, used by the draft at `:766` and `:982-986`.
- **Repro (DB):** Nov A budget 20,000 with 12,000 spent. On Fri Nov 13, the Nov B plan's `carryover=8000`, while the dashboard shows Nov A `safeToSpend=8000 over 3 days (2666.67/day)`.
- **Who / direction:** check-ins done on a Friday payday before a weekend period end (Nov 13 2026, Feb 26 2027, …). With carryover included by default, available money is overstated by whatever is then spent over the weekend.
- **Severity / confidence:** Medium / High. Evidence: DB run.
- **Fix:** on a check-in opened before the previous period ends, show the carryover as provisional and re-read it on confirm. Or take it only once the previous period has ended, and let the next confirm or draft pick it up.

### B22. Afford's "average of your last 6 comparable pay periods" is a constant; the real basis varies per account
- **What:** the page passes `HISTORY_PERIODS` (6) to the copy. The real divisor is per account, from that account's first activity (`averageSinceFirstActivity`), and "count income history from" can shorten the walk. `PeriodProjection.historyPeriods` holds the walked count, but nothing reads it, and the walked count is not the divisor either.
- **Also affected:**
  - "received no income in the last 6 comparable periods" (`noHistoryForAccount`);
  - the subscription-room description (`subscription-room.ts:148`, `en.ts:759-760`).
- **Where:** `src/app/(app)/afford/page.tsx:39`; `src/components/afford/afford-results.tsx:513, 595`; `src/lib/data/afford.ts:548-554` (whose comment says the page reads it); `en.ts:886-894`, `es.ts:876-884`.
- **Repro (DB):**
  - A brand-new user with one period of income gives `income=2000 historyPeriods=6`. The copy says it averages 6 periods; the figure is a single paycheck.
  - The salary-move case of B8 also says 6 while one account averages over 1.
- **Who / direction:** every Afford result. The copy overstates how much history backs the projection. It is worst for new users and after a job change, which is exactly when a single period should be flagged.
- **Severity / confidence:** Medium / High. Evidence: DB run plus render path.
- **Fix:** return each account's `income.periods` in the projection and render it, e.g. "average of 1 comparable pay period", and warn when it is below a minimum.
- **Status:** fixed. The projection returns the divisor (`incomePeriods`) and the results page, `noHistoryForAccount` and the subscription-room description render it, with a low-history note below `MIN_INCOME_HISTORY_PERIODS` (3). The `HISTORY_PERIODS` prop that fed the copy is gone.

---

## Low

### B23. An item due between a Friday payday and the plan period's start is committed in both periods and labelled "Overdue"
- **What:** the plan period's committed walk starts at `owedFrom = max(today, plan.start)`. An item due on the Saturday or Sunday between the payday and the plan start has `nextDate < owedFrom`, so `owedOccurrences` files it as overdue in the plan period. The current period owes it too.
- **Where:** `src/lib/data/period-summary.ts:294-316`; `src/lib/recurring.ts:158`.
- **Repro (DB):**
  - Fri 2026-11-13 is payday, since Nov 15 is a Sunday. A 50 subscription is due Nov 14.
  - Nov A `committed=50` and Nov B `committed=50 (overdue)`. The wizard reserves `outstanding=50` in the Nov B plan.
- **Who / direction:** check-ins on weekend-shifted paydays. The plan double-reserves each such item, so flexible money is understated (the conservative direction), and the item carries a false "Overdue" badge.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** when the plan period starts after today, count only occurrences dated on or after `plan.start`, plus genuinely overdue ones (`nextDate < today`).

### B24. The Goals page's "per pay period" differs from the check-in's and the Inbox's roadmap on payday days
- **What:** `listGoals` computes remaining ÷ `periodsRemaining(today, target)`, net of contributions due from today to the current period's end. The wizard, Afford and the Inbox use `goalRoadmapAmount`: from the plan period's start, net of the plan period's contributions. The two differ from payday to period end (1–3 days a period). The goal detail page shows both figures on one card. The Inbox "behind roadmap" detector uses the plan-period figure.
- **Where:** `src/lib/data/goals.ts:116-127` vs `src/lib/data/payday.ts:356-363`.
- **Repro (DB):**
  - Goal 1,200 due Dec 31, with a 50 contribution on the 20th.
  - Sep 15: the Goals page shows 150 (8 periods); the roadmap and wizard show 121.43 (7 periods, net of 50).
  - Fri Nov 13: 300 vs 350.
- **Who / direction:** display only, on the day the user checks in. The page understates the pace when the next period's contribution is small, and overstates it otherwise.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** compute the Goals page figure with `goalRoadmapAmount` over `planPeriodRef`. The line-918 copy in `getPaydayCheckinDraft` matches `goalPeriodsLeft` exactly and needs no change.

### B25. Editing a cross-currency contribution re-converts its ledger twin at today's rate
- **What:** `updateManualContribution` recomputes the twin's amount on every edit, even when neither the account nor the amount changed. `updateRecurringContributionAmount` does the same.
- **Where:** `src/lib/goals.ts:205-216` and `:144-149`.
- **Repro (DB):** a 100 USD contribution from a DOP account logged at rate 58.5 gives a twin of `5850` DOP. A date-only edit at rate 60.2 rewrites it to `6020` DOP.
- **Who / direction:** goals whose currency differs from the account's. The account balance moves by the rate difference with no money moving.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** keep the twin's amount unless the amount or account changed (`isSameMoney` exists for this). When only the amount changes, scale the stored twin in proportion.

### B26. Moving a finite item's `nextDate` back onto a posted day uses up an installment
- **What:** the `already_posted` branch still decrements `remainingOccurrences`.
- **Where:** `src/lib/recurring-posting.ts:277-310`.
- **Repro (DB):** a 6-payment plan from Jul 10 has `remaining=3` after Sep 10. Setting `nextDate` back to 09-10 and posting to Dec 31 charges `5 of 6`, then ends with `remaining=0, active=false`.
- **Who / direction:** users who correct a plan's date. One installment is never charged, so expenses are understated.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** do not decrement on `already_posted`, or refuse an edit that moves `nextDate` onto an existing RECURRING row.
- **Status:** fixed. The `already_posted` claim rolls `nextDate` forward without touching `remainingOccurrences`, so every installment is still charged.

### B27. The import review's pre-filled next date can be in the past or clamped for good
- **What:** `inferredNextDate` is the latest row plus one cadence (`addMonths`), with no "on or after today" rule and no anchor. The Recurring page's suggestions do guarantee a date on or after today (`recurring-detection.ts:510-515`). Saving the pre-fill:
  - with a past date back-posts every occurrence since (B4, B17);
  - with a clamped date fixes `anchorDay` at 28.
- **Where:** `src/lib/import-grouping.ts:190-202, 235`; `src/components/import/import-review.tsx:317`; `src/lib/validation.ts:445-452`.
- **Repro (pure):**
  - Nov 30, Dec 31, Jan 31 gives `2027-02-28`, so anchor 28.
  - A Dec–Feb statement gives `2026-03-05`, which is in the past.
- **Who / direction:** creating items from an older statement. Backdated charges are posted, and a month-end item stays on the 28th.
- **Severity / confidence:** Low / High. Evidence: pure run.
- **Fix:** reuse `firstDueDate` and the anchor fit from `recurring-detection.ts` for the import pre-fill.
- **Status:** fixed. The import review's pre-fill comes from `nextDueOfImportedSeries`, which reuses `firstDueDate` and the anchor fit from `recurring-detection.ts`, so it is never before today, and a month-end series carries its anchor through the dialog (a validated `anchorDay` field on `recurringSchema`) to the saved item.

### B28. Merging a category deletes its budgets in every period, and the toast doesn't say so
- **What:** `reassignAndDeleteCategory` moves transactions and items but runs `budget.deleteMany` for the merged category in all periods. The period budget shrinks while the spending moves in, and past periods' figures change too. The toast counts only moved rows.
- **Where:** `src/lib/data/categories.ts:271`; `src/server/actions/categories.ts:117-120`.
- **Repro (DB):**
  - Restaurants (budget 3,000) is merged into Dining (5,000), with 2,000 spent in each.
  - Safe to spend goes `4000 → 1000` with no new spending. Result: `{"transactions":1,"recurringItems":0,"budgets":1}`.
- **Who / direction:** anyone tidying categories. Safe to spend drops, including for past periods and the "last budget" suggestions built on them.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** add the merged category's budget into the target's for each period (converting currency), and name the change in the toast.
- **Status:** fixed. Merging adds each of the merged category's budgets to the target's for the same period (in the target's currency, converted at the merge), moves the budget where the target has none, and the toast counts the budgets merged in; the merge dialog's hint and badge now say the same.

### B29. A goal the confirmed plan funded with 0 is never flagged, while the empty Inbox says every goal is on its roadmap
- **What:** confirm drops a GOAL row whose recommended and planned amounts are both 0, so the goal's status has `planned = null`. `detectGoalsBehind` skips `planned = null`, and the forecast skips confirmed periods. Planning 1 instead of 0 would flag the goal as 199 behind.
- **Where:** `src/lib/data/payday.ts:1335`; `src/lib/insights.ts:283`; copy at `en.ts:1253-1254`.
- **Repro (DB):**
  - Confirmed Oct A with no GOAL row for a goal paced at 200: `status.planned=null roadmap=200 → goal_behind insights: 0`.
  - With a planned-1 row, the insight fires: `199`.
- **Who / direction:** exactly the goals in the worst shape, with no room at all, get no signal.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** treat "dated goal, confirmed check-in, no row" as planned 0 in `getGoalRoadmapStatuses`.
- **Status:** fixed (K3, D8). A confirmed period with no GOAL row for a goal reads planned 0, and the planning statement flags it ("The plan for X is behind its roadmap", 5,000 behind, all of it beyond the room at confirm).

### B30. The monthly average counts a partial first month as a full month
- **What:** `computeCompletedMonthWindows` includes the first-activity month in full.
- **Where:** `src/lib/data/monthly.ts:277-300`.
- **Repro (DB):** first expense on Jun 25 (6,000), then Jul and Aug at 30,000 each, gives `monthsUsed=3 averageLifestyle=22000`.
- **Who / direction:** users in their first months. The "typical month" is understated, and the pace card reads "above average" too easily.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** skip the first-activity month unless the activity starts in its first few days, or prorate it by days covered.
- **Status:** fixed. The first-activity month is left out of the average unless the first activity falls on or before day 7 of it (`FIRST_MONTH_MAX_START_DAY`, `firstUsableMonth`), and with fewer than three full months left the card and Reports say there is not enough history yet.

### B31. A new item's scheduled amount fills months before its first due date
- **What:** `classifyCompletedMonth` adds an active item's monthly equivalent to any completed month that ended after the item's `createdAt`, even when the first due date is later.
- **Where:** `src/lib/data/monthly.ts:600-620`.
- **Repro (DB):** an Afford plan of 5,000 DOP per month, created Aug 20 with its first payment Oct 1, gives `Aug 2026 committed=5000`, while nothing was charged.
- **Who / direction:** monthly history and averages. Committed spending is overstated for months before a plan starts (and for skipped items; see B14).
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** gate on the item's first due date (or `nextDate` for an unposted item) rather than `createdAt`, and apply posting's skip reasons.
- **Status:** fixed. A scheduled amount now enters a completed month only from the month of the item's first occurrence (the earlier of its first posted RECURRING row and its `nextDate`), on top of the existing `createdAt` gate; posting's skip reasons are still not applied, which stays with B14.

### B32. Insight dismissals never expire and ignore the period
- **What:** dismissals are keyed by (source, goal or item id) and never expire. Dismissing "behind roadmap" in one period hides it in every later period of that goal. Dismissing a `not_posting` skip hides a later failure of the same item, and dismissing a plan's shortfall hides a new shortfall in a different period.
- **Where:** `src/lib/insights.ts:142, 191, 289, 349`; `src/lib/data/insights.ts:113-119`.
- **Repro (pure):** Sep B, 10 behind: dismissed. Dec A, 400 behind: `0 insights` after the Sep B dismissal.
- **Who / direction:** the Inbox and the nav badge stay silent about new, larger problems. The goal page and dashboard alerts still show them.
- **Severity / confidence:** Low / High. This is documented as intended ("for good"), but it contradicts the insight's per-period evidence. Evidence: pure run.
- **Fix:** include the period (and for Afford the failing period, for not_posting the reason) in the key, or expire a dismissal when the evidence changes materially.
- **Status:** fixed. A dismissal's key now names the evidence it was made on (the period for a goal behind its roadmap, a goal at risk and an Afford plan's failing period; the skip reason, or `failed`, for a not-posting item), so it hides only that evidence and a later or different problem shows.

### B33. The Reports "average per period" includes the partial current period
- **What:** `getSpendingTrend` walks `periodSeries(currentPeriod, 6)`, and the page divides the total by 6.
- **Where:** `src/lib/data/reports.ts:19`; `src/app/(app)/reports/page.tsx:29-30`.
- **Repro (DB):** on Sep 17, five periods at 1,000 plus Sep B at 50 so far gives `average=841.67`, where the five complete periods say 1,000.
- **Who / direction:** display only. Understated early in each period, and before six periods of history exist.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** average completed periods only, or label the current one as partial and leave it out of the mean.
- **Status:** fixed. The Reports average is over completed periods since the first activity (`getSpendingTrendSummary`), the period in progress stays in the chart labelled "so far" and is left out of the mean, and with no completed period no average is shown.

### B34. The current unconfirmed period, when it precedes the plan period, gets no goal estimate
- **What:** after 0ba225e, each goal's window starts at the plan period. From payday to period end, today's period comes before it, so Afford estimates no goal funding for it even when it has no confirmed check-in.
- **Where:** `src/lib/data/afford.ts:434-439, 469`.
- **Repro (DB):** goal 3,000 due Mar 31. On Sep 14, Sep A has `estimate 214.29`. On Sep 15 (payday), `Sep A committed=0 (estimate 0)`.
- **Who / direction:** only a purchase dated in those 1–3 days, when that period's own check-in was never confirmed. Room is overstated by the pace. In practice it is usually the confirmed period, so the effect is small.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** estimate the pace for an unconfirmed current period too, or accept it and document it. The pay for it has landed, so the user is planning the next one.
- **Status:** fixed. From payday to period end, an unconfirmed current period is added to each dated goal's window, except a goal whose target date falls before the plan period ends, whose whole balance stays in the plan period alone.
- **Status (K3, 2026-09-30):** the current-period estimate this fix added is removed on purpose (QUANTITIES_MAP.md D10, a user decision): Afford's goal window is the roadmap's, from the plan period on, so from payday to the end of its period today's period carries no goal estimate.

### B35. Category suggestions average an in-progress comparable period when planning two or more periods ahead
- **What:** `getCategorySuggestions` starts at `previousComparablePeriod(planRef)` without the "has ended" rule that Afford's `comparableHistory` applies. The Budgets page can open the wizard for any future period.
- **Where:** `src/lib/data/payday.ts:245-290`.
- **Repro (DB):** planning Oct A on Sep 3 averages Sep A (2 days, 30 spent) as a full period: `(5×300+30)/6 = 255`, where the complete periods give 300.
- **Who / direction:** early check-ins for future periods. Suggestions are understated.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** reuse `comparableHistory`'s start rule (walk back to the most recent comparable period that has ended or is confirmed).

### B36. The check-in's cover-transfer dialog pre-fills tomorrow after 8pm local
- **What:** `toISODate(new Date())` in the browser is the UTC date. Every other form uses the server's `today()`.
- **Where:** `src/components/payday/payday-checkin-dialog.tsx:517`.
- **Repro (pure, TZ=America/Santo_Domingo):**
  - 2026-09-15 19:59 gives 2026-09-15 (Sep A).
  - 20:30 gives **2026-09-16** (Sep B).
  - 2026-09-30 21:00 gives **2026-10-01**.
- **Who / direction:** evening check-ins, which are common on payday. The transfer is dated in the next period or month; balances are unaffected because they sum every row.
- **Severity / confidence:** Low / High. Evidence: pure run.
- **Fix:** pass `context.today` from the server into the dialog, as the other forms do.

### B37. Two concurrent confirms of one check-in store a wrong snapshot
- **What:** `liveAccounts` is read before the write transaction. The second request sees the first's snapshot, with its income transaction, but a balance read from before that income, so `ledgerBefore` subtracts income the balance never contained.
- **Where:** `src/lib/data/payday.ts:1124-1136, 1463, 564-590`.
- **Repro (DB):**
  - Two parallel `confirmPaydayCheckin` calls return `ok` twice and leave 1 check-in and 1 income row, but a snapshot with `expected=-4000 reported=1000 difference=5000`.
  - Two sequential confirms give `expected=1000 difference=0`.
- **Who / direction:** a double submit or retry. The stored reconciliation fields are wrong. Nothing re-reads them today, so the damage is limited to the audit record and to exports.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** read balances inside the transaction, after locking the check-in row (`SELECT … FOR UPDATE` on the unique key).

### B38. The dashboard's "Recommended" budget grows as the period's subscriptions post
- **What:** the draft of a confirmed period recomputes subscriptions from today, so posted ones drop out of `available`.
- **Where:** `src/app/(app)/page.tsx:54-59`; `src/lib/data/payday.ts:879-888`.
- **Repro (DB):** confirmed Oct A (income 5,000) with an 800 subscription on Oct 5 gives `available=3700` on Oct 1 and `4500` on Oct 6.
- **Who / direction:** shown only when the current period's check-in is confirmed and no overall budget exists. The recommendation is then overstated by what has already posted.
- **Severity / confidence:** Low / High. Evidence: DB run.
- **Fix:** for a confirmed period, count occurrences from the period's start (or read the confirmed allocation rows).

### B39. Step 4's "Estimated safe to spend per day" is unallocated money per day, not the dashboard's figure
- **What:** Step 4 computes (available − allocated) ÷ days, which is 0 once everything is allocated. The dashboard's figure is (budget − spent) ÷ days. The Spanish label ("Disponible para gastar por día") is the dashboard's label word for word.
- **Where:** `src/components/payday/step-flexible.tsx:33-35`; `en.ts:1450`, `es.ts:1438`.
- **Repro (code path):** allocating exactly what is available gives Step 4 "0/day". The dashboard then shows the period budget ÷ days (for example 40,000/15 = 2,666.67).
- **Who / direction:** display only. It understates what can be spent and invites confusion between the two figures.
- **Severity / confidence:** Low / High. Evidence: code path.
- **Fix:** label it "Unallocated per day", or compute the dashboard's figure from the planned budgets.

### B40. A plan in deficit shows "No spending history yet"
- **What:** the note is gated on scaled suggestions, and every suggestion scales to 0 when available ≤ 0.
- **Where:** `src/components/payday/step-flexible.tsx:35-39`; `src/lib/payday.ts:181-183`.
- **Repro (pure):** raw suggestions 400 and 150 with `available=-500` give `g:0 d:0 | hasSuggestions = false`, so the note shows.
- **Who / direction:** users in deficit are told they have no history, which is false.
- **Severity / confidence:** Low / High. Evidence: pure run.
- **Fix:** gate the note on the raw suggestions, and show a deficit note when the scaled ones are all 0.

### B41. A SEMI_MONTHLY suggestion's next date ignores the weekend shift posting applies
- **What:** detection steps each anchor with MONTHLY, which has no shift. Posting's SEMI_MONTHLY rule pulls a weekend date back to Friday.
- **Where:** `src/lib/recurring-detection.ts:531-548` vs `src/lib/recurring.ts:32-70`.
- **Repro (pure):** for anchors 1 and 16 after Oct 16 2026, detection gives `2026-11-01 (Nov A)` and posting's rule gives `2026-10-30 (Oct B)`.
- **Who / direction:** accepted semi-monthly suggestions. The first occurrence lands in the next pay period.
- **Severity / confidence:** Low / High. Evidence: pure run.
- **Fix:** step with `advanceDate(…, "SEMI_MONTHLY", a, b)` from the last realization.
- **Status:** fixed. A suggestion's next date for each anchor is stepped with posting's own SEMI_MONTHLY rule, so anchors 1 and 16 after Oct 16 2026 suggest Oct 30.

### B42. An overdue installment plan counts as 3 payments in commitments and 5 in the tracker
- **What:** `owedOccurrences` counts a backlog once (documented), while `remainingInstallments` files every overdue installment in the current period. Posting will charge all of them.
- **Where:** `src/lib/recurring.ts:152-168` vs `src/lib/afford-tracking.ts:30-49`.
- **Repro (pure):**
  - Setup: 5 payments left, `nextDate` Jul 10, today Sep 28.
  - Commitments: `Jul 10, Oct 10, Nov 10` (3 × 1,000).
  - Tracker: 5 rows, three of them in Sep B.
- **Who / direction:** only items stuck unposted (a failed posting run). Items on archived or missing accounts are excluded from the tracker. Commitments are understated by the backlog.
- **Severity / confidence:** Low / High (the reachable trigger is narrow). Evidence: pure run.
- **Fix:** count every owed backlog occurrence for finite items, bounded by `remainingOccurrences`.

### B43. A target date in the middle of a period drops that period from the roadmap
- **What:** `periodsRemaining` counts only periods ending on or before the target, although that period's pay arrives before the target.
- **Where:** `src/lib/period.ts:205-217, 226-228`.
- **Repro (pure):** plan Sep 16 with target Oct 14 gives `goalPeriodsLeft=1`; with target Oct 15 it gives 2. Oct A's pay lands Sep 30, before Oct 14.
- **Who / direction:** goals dated mid-period. The pace is overstated (here the whole balance in one period, not half in each of two).
- **Severity / confidence:** Low / Medium. The rule is documented, but it ignores when pay arrives. Evidence: pure run.
- **Fix:** count a period if its payday (`paydayDateFor`) falls on or before the target.
- **Status:** fixed (K3, D9). `periodsRemaining` counts a period when its pay (`paydayDateFor`) lands on or before the target date: plan Sep 16 / target Oct 14 counts 2 periods. A target on a pay boundary now includes the period paid that day (Dec 31 includes Jan 1-15; a Sunday Nov 15 includes Nov 16-30, paid Fri Nov 13).

### B44. Banco Popular rates: the sell rate is used in both directions, and a rate up to 7 days old wins over a fresh market rate
- **What:** `toRateTableEntries` sets DOP to `dollarSellRate`, so USD→DOP conversions (USD income shown in DOP) use the bank's sell side. A stored BPD rate up to `BPD_RATE_MAX_AGE_DAYS = 7` overrides a fresh open.er-api rate, with `stale` left unchanged.
- **Where:** `src/lib/bpd-rate-payload.ts:32, 121-126`; `src/lib/rates.ts:87-93`; `src/lib/bpd-rates.ts:155-169`.
- **Repro (code path):** USD income converted at the sell rate is overstated by the bank's spread (around 1–2%). A week-old BPD rate stays in use through any market move that week.
- **Who / direction:** multi-currency totals. Small, but it applies to every figure.
- **Severity / confidence:** Low / Medium (a documented design choice). Evidence: code path.
- **Fix:** store buy and sell rates and use the side that matches the direction, or the midpoint. Prefer the newer of the two sources.

### B45. Failures are reported as success, or not at all
- **What:**
  - If the whole posting run throws, `recurringPosting` becomes `null` and the Inbox shows no `not_posting` insight (`src/lib/data/context.ts:57-60`, `src/lib/insights.ts:131`).
  - Ingestion returns `accountsSynced: connections.length` even when a connection threw, so "Synced N" and the cron's 200 overstate the sync (`src/lib/ingestion.ts:236-250`).
  - `/api/cron/recurring` returns 200 with `itemsFailed > 0` (`route.ts:34-37`).
  - The BPD cron logs "cached today's rate" for a stored rate up to 7 days old, and returns 200 on failure (`src/app/api/cron/bpd-rate/route.ts:37-47`).
- **Repro (code path):** each branch is as quoted. Nothing distinguishes a failed run from a clean one.
- **Who / direction:** the operator. Failures stay hidden, which feeds B18.
- **Severity / confidence:** Low / High. Evidence: code path.
- **Fix:** count failed connections separately; return 5xx (or a `failed` count the monitor reads) on partial failure; surface a posting-run failure as its own insight.
- **Status:** fixed. A posting run that throws is carried in the context as `recurringPostingFailure` and shown as a critical, non-dismissible Inbox insight; ingestion counts `accountsFailed` beside `accountsSynced`; `/api/cron/recurring` and `/api/cron/ingest` answer 500 on a failed item, connection, message or run; and the BPD cron (still 200 by design) now says whether it stored a fresh rate, kept the stored one from a given date, or failed, and warns when the stored rate is past the freshness window.

### B46. Copy claims recurring items and committed outflows reduce safe to spend; they don't
- **What:** `safeToSpend = periodBudget − spent`. RECURRING rows are excluded from `spent`, and committed outflows are never subtracted. They are only reflected if a check-in lowered the budget. The following strings claim otherwise:
  - `recurring.description`: "Both kinds reduce safe to spend for the period they fall in" (`en.ts:692-693`).
  - `recurring.stopsCounting`: "It stops counting against safe to spend straight away" (`en.ts:737`). Deleting an item changes nothing.
  - `dashboard.setBudgetPrompt`: "what you can spend each day after committed outflows" (`en.ts:269-270`).
  - The es.ts equivalents.
- **Where:** `src/lib/data/period-summary.ts:283-284, 324-327`.
- **Repro (code path):** budget 1,000 and an 800 subscription due Sep 30. On Sep 28, safe to spend per day is 333, not 67, and deleting the item leaves it at 333.
- **Who / direction:** users who set budgets by hand. The copy implies a safety margin that does not exist.
- **Severity / confidence:** Low / High. Evidence: code path.
- **Fix:** reword to "the payday check-in sets them aside before your budget", or subtract outstanding committed items when the budget was set by hand.
- **Status:** fixed (text, not calculation, as decided). `recurring.description`, `recurring.stopsCounting` and `dashboard.setBudgetPrompt` now say that the payday check-in sets committed items aside before the budget it proposes and that safe to spend is the budget minus what was spent; deleting an item no longer claims to change it. English and Spanish.

### B47. Inbox and badge copy misstates severity and completeness
- **What:**
  - The nav badge says "N need attention" but counts every insight, advisory ones included (`src/app/(app)/layout.tsx:18`, `en.ts:172-173`). Two "looks recurring" suggestions give "2 need attention" with an empty "Needs attention" group.
  - The Afford "no longer fits" insight is filed as critical (`insights.ts:194`), while the dashboard and Recurring copy call the same check "advisory" (`en.ts:246-247`).
  - `inbox.emptyDescription` ("every goal plan is on its roadmap…", `en.ts:1253-1254`) also shows when items were merely dismissed, and when a goal was planned at 0 (B29).
- **Repro (code path):** as quoted.
- **Severity / confidence:** Low / High. Evidence: code path.
- **Fix:** count only critical insights in the badge (or say "N to review"), align the Afford severity, and word the empty state conditionally.
- **Status:** fixed. The badge says "N to review" (English and Spanish), the Afford "no longer fits" insight is advisory and sits in the advisory group, and the empty Inbox says how many dismissed items are hidden instead of claiming everything is in order; the goal-planned-at-0 case (B29) is untouched.

### B48. Other copy that claims more than the data supports
- **What:**
  1. **Afford:** "No payday check-in exists for these periods yet" renders even when an evaluated period is confirmed and its GOAL rows are counted (`afford-results.tsx:513`, `en.ts:887`).
  2. **Afford:** "Commitments added since … have shrunk the room" (`dashboard.affordShortDescription`, `en.ts:246`) names only new commitments. The re-check also re-averages income, uses today's rates and adds goal estimates.
  3. **Subscription room:** it says "its other recurring items due then are subtracted" but also subtracts goal estimates. SEMI_MONTHLY items are never checked (`recurring-dialog.tsx:148-149`), and the threshold is per charge, so a weekly 3,000 DOP item (about 13,000 a month) is never checked (`src/lib/subscription-room.ts:11-15`).
  4. **Settings:** "Count income history from" (`en.ts:1135-1136`) names only Afford and the planner, but it also trims the monthly pace and Reports history (`monthly.ts:284-294`).
  5. **Settings:** "Fixed minimum buffer" reads as one floor, but it applies per income account and is summed (`src/lib/payday.ts:29-35`, `afford.ts:454, 515`). Two income accounts reserve two floors.
  6. **Payday:** `confirmIncomeNote` says "will be created" on a re-confirm that updates or deletes rows (`en.ts:1459`).
  7. **Dashboard:** "Next 7 days" / "Nothing due in the next week" queries `nextDate ≤ today + 7`, which is 8 days, plus overdue items (`src/lib/data/dashboard.ts:44`, `en.ts:260-261`).
  8. **Shell:** `staleRatesSince` says every converted amount uses the old fetch, while DOP and EUR may come from a fresh BPD rate (`rates.ts:87-93`, `en.ts:188`).
  9. **Goals:** "planned this period" and "Planned this period" mean the plan period, which is the next one after payday (`en.ts:983, 1301`; `payday.ts:465`).
  10. **Plurals:** English "1 periods left" and "1 periods to the target date" (`en.ts:936, 947`); `dashboard.periodsTo` in both languages.
  11. **Recurring:** `suggestionsDescription` says "manual and imported", but the detector reads only MANUAL and CSV rows, not approved email rows (`recurring-suggestions.ts:51`).
  12. **Shell:** "16-end" is hard-coded in English in the Spanish shell (`src/components/shell/app-shell.tsx:52`).
- **Repro:** each string was read against its computation, as cited.
- **Severity / confidence:** Low / High. Evidence: code path.
- **Fix:** one wording pass driven by the computations. Item 3's threshold should be checked on the monthly equivalent.
- **Status:** items 1, 2, 3, 4, 5, 8, 10, 11 and 12 fixed (copy, English and Spanish; item 1 also carries a `confirmed` flag from the projection so the note can say whether check-ins exist for none, all or some of the evaluated periods; item 5 adds a hint under the field). Item 3's behavior and item 7 were fixed earlier: the room check runs when one charge or the monthly equivalent reaches the threshold (SEMI_MONTHLY stays unchecked), and "Next 7 days" covers today and the following six. Still open: items 6 and 9 (payday wizard and goals-roadmap strings, out of scope here). No string used by the wizard was needed for the other items.
- **Status (K3, 2026-09-30):** item 9 fixed. The Goals list, detail and Dashboard card name the period ("Oct 1-15: 5,571.32 planned · 5,571.32 contributed"), and the Inbox shows the period as its own evidence line beside "Planned" (the labels no longer say "this period"). Item 6 is still open.

---

## Very low

### B49. Edge-case arithmetic
- **What:**
  1. **Typed amounts:** `parseAmountInput("0,125")` returns **125**, and `"0,500"` returns 500. `"0.125"` is rejected as too many decimals (`src/lib/money.ts:84-87`).
  2. **Flexible scaling:** `scaleFlexibleSuggestions` can return a negative row: 10 suggestions of 1 with 0.05 available give `-0.04, 0.01×9`. Confirming then fails `planAmount ≥ 0` (`src/lib/payday.ts:190-195`).
  3. **SEMI_MONTHLY anchors 30 and 31:** both anchors land on the same Friday in Jan and Feb 2027, giving one charge a month there (`2027-01-29, 2027-02-26, 2027-03-30, 2027-03-31`). The form accepts any distinct pair.
  4. **Monthly history:** `existedIn` compares a `createdAt` timestamp with the month end at UTC midnight, so an item created during the last day of a month (or after 8pm local on the day before) is excluded from that month (`monthly.ts:603-604`).
  5. **Email approval:** approving a staged email checks only that the account exists, not that it is ACTIVE (`review.ts:74-78`), so it can post to an archived account.
- **Severity / confidence:** Very low / High. Evidence: pure runs for items 1–3, code path for items 4 and 5.
- **Fix:** 1: reject a leading-zero comma group. 2: clamp at 0 and give the remainder to the largest positive row. 3: refuse anchor pairs that collide. 4: compare against the day after the month end. 5: require ACTIVE.
- **Status:** item 1 fixed (only item 1). A comma group counts as thousands only after a 1-3 digit leading group that is not a lone 0, so "0,125" and "0,500" are rejected as too many decimals like "0.125".
- **Status:** items 3, 4 and 5 fixed (only those). The form refuses a SEMI_MONTHLY pair whose weekend-shifted dates can coincide in some month of 2000-2099 (74 of 465 pairs), an item created on a month's last day counts for that month, and approving a staged email or importing a CSV needs an ACTIVE account; an edit that changes only the second day is refused too, while saving a pair an item already has is not; item 2 is still open.

---

## Unproven (not reproduced; what's missing)

- **U1. An email with no date in the body may be dated by the UTC received day.** `parse-transaction-email.ts:83` sends `Received: <UTC ISO>` with no timezone. A receipt received at 9pm local on the 30th could be staged as the 1st. *Missing:* a real model run on such an email (the outcome depends on the model).
- **U2. Incoming money in an email may be approved as an expense.** The filters include "payment received" (`email/filters.ts:14`), the schema has no direction field, and approval hard-codes `type: "EXPENSE"` (`review.ts:88`). *Missing:* evidence that the model marks an incoming-payment email as a transaction. The reviewer can also reject it.
- **U3. The subscription room check subtracts the edited item's own commitment only from `committed`.** The goal estimate was computed with the item in place, so room may be slightly overstated when goal funding is capped by headroom (`subscription-room.ts:106-120`). *Missing:* a DB run with room-capped goal funding showing the figure.
- **U4. A period whose check-in was skipped reads as zero income** (`afford.ts:203-244`, paychecks come from snapshots). This is probably true to the data (the pay is not in the ledger either). *Missing:* a case where the pay is in the ledger and still omitted.
- **U5. Biweekly suggestions may step from a weekend-shifted charge.** *Missing:* evidence that banks shift biweekly charges off weekends; the app's own BIWEEKLY advance does not shift.
- **U6. Double submit on money-writing actions** (`confirmAffordPurchase`, `addContributionAction`, transaction and transfer create, recurring create, accepting a suggestion) has no server-side idempotency key. *Missing:* a demonstration that a second request reaches the server; `SubmitButton` disables while pending, but a network retry or two tabs was not tried.
- **U7. `storeBpdRates` may let an older rate overwrite a newer one.** It does not refuse an older `asOf`, and the DOP and EUR upserts are not in one transaction (`bpd-rates.ts:101-130`). *Missing:* a run of a re-run scraper with an older payload.
- **U8. A stale or fallback rate may be frozen into rows.** A posting or logged contribution made while the rate table is stale (or at the hard-coded DOP 60) fixes that figure permanently (`recurring-posting.ts:335-338`, `goals.ts:46-48`), and a late backlog converts at the run date's rate. *Missing:* a run with the rate service down and no stored rows.
- **U9. Pass-4 copy nuances not checked line by line:**
  - `basisLastBudget` shows a scaled amount;
  - `accountBelowBuffer` is measured against the buffer, not zero;
  - `goalFundingShortfall` is what's left after earlier goals;
  - `step1BalanceMeaning` when the pay came in by CSV;
  - "before next payday" lists include the payday;
  - `confirmBudgetsNote` counts untouched rows;
  - `itemsDueBefore` and `recurringStillToCome` count items, not charges;
  - `fromAffordDescription` "each re-checked" counts plans on inactive accounts;
  - `monthlySavingsHint` includes contributions that cannot post;
  - the "Total cash outflow" projection sits under "Based on the last N months".

  *Missing:* for each, the render path traced against the computation.

## Checked and found sound

- **Dates and timezone:**
  - `today()` uses APP_TIMEZONE (default America/Santo_Domingo). Every data layer reads `context.today`, and both the cron and `getAppContext` post with `today()`. The cron runs at 04:15 UTC (00:15 local).
  - `fromISODate` builds UTC-midnight dates, and no server path reads them with local getters.
- **Pay periods:**
  - `payDayOfMonth`, `isPaydayDate`, `isAfterPaydayInPeriod` and `paydayDateFor`: the Saturday and Sunday pull-back, Feb 28/29 and 30/31-day B periods.
  - `planPeriodRef` across Friday-shifted paydays.
  - `goalPeriodsLeft` and `goalWindow` on the 15th, 16th and last day, and for past targets.
- **Recurrence:**
  - `advanceDate`: MONTHLY anchored on the 31st (Jan 31 → Feb 28 → Mar 31, no drift), YEARLY on Feb 29, and SEMI_MONTHLY 1/16, 15/31 and 1/15, including a shift into the previous month.
  - `owedOccurrences` countdown for finite items.
- **Posting concurrency:** the compare-and-swap on (`nextDate`, `remainingOccurrences`, `active`) inside the write transaction plus the `(source, externalId)` unique key. Overlapping runs back off. There is exactly one posting path.
- **Money writes:**
  - Staged email approval is protected by `(source, externalId)` and a status check. Importing the same CSV twice is rejected by the fingerprint key.
  - Transfer legs are created, edited and deleted atomically, with the deferred integrity trigger.
  - `recomputeGoalSaved` locks the goal row. Check-in re-confirm updates the income row through `incomeTransactionId`.
  - Opening-balance and budget saves are protected by unique keys with retry.
- **Currency:** `convert` direction (amount ÷ from × to), the EUR cross rate and the throw on a missing rate. `getRateTable` never returns a partial table, and the stale flag is set on fallback.
- **Afford:**
  - The goal-window fix (0ba225e); an undated goal is excluded from the estimate.
  - Achieved-goal contributions and paused items are excluded.
  - One-off income and reimbursement deposits are excluded from the income walk.
  - The plan's own item is excluded on re-check.
  - The installment rounding difference is disclosed on the page (`scheduleRoundedUnder` / `scheduleRoundedOver`).
- **Check-in:**
  - Income attribution through snapshots is consistent across `getPeriodSummary`, Reports and Afford.
  - The reconciliation cap, and the scaled-flexible reconciliation to the cent.
  - The confirm upsert on the `(year, month, period)` unique key.
- **`incomeHistoryStartDate`:** the same "period ended before" rule in Afford, category suggestions and monthly.
- **Other:**
  - Extraordinary detection (3× median, at least 3 prior rows, 6 months).
  - Reimbursement progress.
  - The debt-payoff simulation's rollover and cents (both orders give the same total periods).
  - CSV fingerprinting.
  - `BEARER_AUTH_PATHS` covers all cron routes.
- **The line-918 copy of the period-count rule:** it feeds only the displayed `periodsLeft` and equals `goalPeriodsLeft` exactly.

## Suggested fix order (grouped by the code they touch)

1. **Posting's "already logged" matching:** B2, B3, B10, B16, plus B15 (achieved-goal re-check in the same loop) and B26. All in `src/lib/recurring-posting.ts` (`loadLoggedCharges`, `findLoggedCharge`, `postOccurrence`) and the check-in's `loggedOccurrencesByItem`. Introduce a persisted charge-to-occurrence pairing once and use it in both.
2. **Back-posting from stale `nextDate`s:** B4, B17, B27. The resume toggle, goal target raise, account restore, `affordInputSchema` and `recurringSchema` date bounds, and the import pre-fill.
3. **Cross-source de-duplication:** B5. `import-duplicates.ts` and `review.ts`, reusing the matcher from step 1.
4. **Afford projection:** B1, B7, B8, B22, B34. All in `projectPeriods`, `loadScheduledCommitments` and `evaluateAffordability` in `src/lib/data/afford.ts` and `src/lib/afford.ts`.
5. **Goal roadmap:** B11, B12, B13, B14, B24, B29. `goalRoadmapAmount`, `getGoalRoadmapAmounts`, `getGoalRoadmapStatuses` (`src/lib/data/payday.ts`), `summarize` and `loadDueContributionsByGoal` (`src/lib/data/goals.ts`), `listDebtGoals`, and `getPeriodSummary`'s item filter. Decide once whether the roadmap is gross or net and anchored at the plan period's start, then make every reader use it.
6. **Check-in draft and confirm:** B9, B21, B23, B37, B38, B39, B40. `getPaydayCheckinDraft`, `confirmPaydayCheckin` and `bufferInputs`, plus `period-summary.ts`'s `owedFrom`.
7. **CSV parsing:** B6 (`src/lib/csv.ts`). It is independent and small, so it could be done first.
8. **Currency at rest:** B19, B25, B44. Store amounts in the account's currency (or with the rate used), and handle the BPD rate direction.
9. **Monthly and Reports averages:** B20, B30, B31, B33, B35 (`monthly.ts`, `reports.ts`, `getCategorySuggestions`).
10. **Ingestion and ops signals:** B18, B45 (`ingestion.ts`, `parse-transaction-email.ts`, the cron routes, `context.ts`).
11. **Insights:** B32, B47 (`insights.ts` keys and severity, the badge).
12. **Remaining copy and edge cases:** B28, B36, B41, B42, B43, B46, B48, B49.
