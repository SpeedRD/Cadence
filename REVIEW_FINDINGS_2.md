# Adversarial review of Cadence's money logic, round 2

Reviewed code: `origin/main` at `652dfe1` ("Euro rate counts as fit when the table carries the bank's EUR rate"). The session started on `b0b7433`. That checkout lacked the two newest commits (R19-R30), so I fast-forwarded it partway through and re-ran every reproduction on `652dfe1`.

Method:
- I read each module first and wrote down what it must do and which inputs could break it. Only then did I compare against its comments. I did not read `QUANTITIES_MAP.md`, `REVIEW_FINDINGS.md`, the Status lines of `BUG_HUNT_FINDINGS.md`, or the newer sections of `scripts/verify-domain.ts` until my views had formed.
- Four read-only subagents proposed candidates, one per scope group. Every finding below was reproduced by me on my own throwaway Postgres databases (`rev_me`, `rev_s_*`) with fictional data.
- Display currency in the reproductions is DOP. Rates are the bank's DOP 63.10 / EUR sell 73.20 (1 EUR = 73.20 DOP) unless stated.

Severity scale: **High** means wrong money is written, or a figure the user would act on is wrong. Medium and Low as usual.

## Summary

| Severity | Count | Findings |
|---|---|---|
| High | 3 | S1, S2, S3 |
| Medium | 13 | S4 to S16 |
| Low | 7 | S17 to S23 |

Also in this report: the independent recomputation (6 mismatches, all of them findings), the baseline runs, the checks that pass on wrong code, and the list of unproven candidates.

---

## High

### S1. Pausing and resuming an installment around an "It's that payment" pairing posts one installment too many
- **Where:**
  - `src/lib/data/recurring.ts:297-320` (`skipMissedOccurrences`). Its comment says "`remainingOccurrences` is not touched: a skipped occurrence was not spent".
  - The edit-form path: `updateRecurringItemDetailed` (`:435-462`) moves `nextDate`, then `reconcileSettlements` (`:642-650`) releases the pairing.
  - Reached from `setRecurringItemActive` and from restoring an archived account (`src/lib/data/accounts.ts`).
- **What happens:** the user answers "It's that payment" for the next installment, and a `RecurringSettlement` is written with `claimedByPostingAt` null. The item is then paused, or its account is archived, across the due date, and later made postable again.
  - The skip jumps over the paid occurrence. Posting never claims that occurrence, so its installment is never counted down.
  - The edit-form variant deletes the pairing outright. The charge becomes ordinary spending again.
- **Reproduction 1:** Aplazame, 100 EUR monthly, 3 payments, on a DOP card.
  - Oct 18: charge of 6,667 DOP, recorded as the Oct 20 payment.
  - Paused Oct 19, resumed Oct 25.
  - Result: 1 manual charge + 3 RECURRING rows (Nov 20, Dec 20, Jan 20) = **4 payments for a 3-payment plan**. Both the toggle and the edit form give this; the edit form says "released". Without the pause it is 1 + 2 = 3.
- **Reproduction 2 (independent script, scenario `pauseResume`):** Laptop, 158.37 EUR × 6.
  - Payment recorded for Oct 28; paused Oct 27, resumed Nov 2.
  - The plan will make **7** payments.
- **Who / direction:** anyone with an Afford installment plan who pauses it. One extra installment is charged and written: 6,666.67 DOP in reproduction 1, 11,983.57 DOP in reproduction 2. Commitments over-count by the same amount.
- **Confidence:** high.

### S2. A deposit that changes between opening the check-in and confirming it creates a phantom paycheck row
- **Where:** `src/lib/data/payday.ts:1608-1610` re-reads the deposits under the lock, and `:1681-1707` derives `ownIncome = incomeEntered - adopted`. `checkinVersion` guards the check-in row, not the deposits Step 2 showed.
- **Reproduction:**
  - Oct 30: plan period Nov A. Main (DOP) already holds a 15,450 salary (Oct 30) and a 5,000 family transfer (Oct 28).
  - Step 2 lists both and prefills 20,450.
  - Before confirming, the user earmarks the transfer, in another tab, for the Nov 5 158.37 EUR installment.
  - The user confirms the wizard as loaded.
  - Confirm adopts only 15,450 and writes a **PAYDAY_CHECKIN INCOME row of 5,000**. Ledger income on Main becomes 25,450; 20,450 actually arrived.
- **Other routes, same root cause (code reading):** deleting or marking one-off an adopted deposit between draft and confirm.
- **Who / direction:**
  - Account balance and income are overstated by 5,000.
  - The 5,000 is counted twice: once as the installment's cover, once as pay.
- **Confidence:** high.

### S3. The backfill script freezes fallback and stale rates that the app itself now refuses to write
- **Where:** `scripts/backfill-account-currency.ts:97-135` (`loadRates`). A missing currency falls back to `FALLBACK_RATES`, a stale open.er-api row is used as is, and no `ratesFitForWriting` check runs before `--apply`.
- **Reproduction:**
  - Setup: a pre-K7 row of 158.37 EUR on a DOP account. No EUR rate is stored; DOP is a 10-day-old 58.0; there is no bank rate.
  - `--apply` prints two notes, then writes **10,320.85 DOP at rate 63.0434782609**, using EUR at the fallback 0.92.
  - At a bank EUR sell rate of 70.25 the figure would be 11,500.63.
  - A second `--apply` reports "Nothing to change", so the frozen figure is never corrected.
- **Who / direction:** whoever runs the backfill without a fresh rate set. Wrong money is written permanently, 1,179.78 DOP low here. The notes are printed but do not stop the write. R20 forbids exactly this for every app write path.
- **Confidence:** high.

---

## Medium

### S4. Moving a schedule back moves a settlement posting already claimed onto a future occurrence, which then never posts
- **Where:** `src/lib/data/recurring.ts:546-551` and `:618-640` (`reconcileSettlements`, claimed branch). Candidates are every new date before `formerNext`, including ones still ahead. Posting then rolls past them as claimed (`settlementClaimed`).
- **Reproduction:** weekly "Lavanderia", 500 DOP, on Tuesdays.
  - Oct 19: manual charge of 500.
  - Oct 20: posting settles the Oct 20 occurrence with it. `nextDate` becomes Oct 27.
  - Oct 21: the user moves the day to Fridays, with `nextDate` Oct 23.
  - The claimed Oct 20 pairing is rekeyed to Oct 23. Posting on Oct 23, run twice, posts nothing. The ledger has Oct 19 (manual) and Oct 30 only.
  - The same history with Oct 20 posted as a RECURRING row instead gives Oct 20, Oct 23 and Oct 30.
- **Who / direction:** one occurrence (500) is under-counted in the ledger and in that period's commitments. Safe to spend is overstated.
- **Confidence:** high.

### S5. A carryover that settles at exactly 0 is never reconciled again
- **Where:** `src/lib/data/flexible-room.ts:156` (`reconcilingRow` requires `plannedAmount > 0` or basis "adjusted"). Once settled, a 0 the user took is indistinguishable from a carryover the user declined.
- **Reproduction:**
  - Nov A was confirmed with the carryover included (provisional). Oct B ended overspent: income 10,000, spending 12,000. On Nov 1 the carryover settles at 0.
  - Nov 3: an Oct B expense is corrected by −3,000, so Oct B now leaves 1,000. Nov A's carryover stays **0**.
  - The same history ending with 1 left settles at 1 and then reconciles to 3,001.
  - Independent script, scenario `leadDayAndZeroCarry`: a 22,000 typo is fixed to 2,000. The carryover should be 18,871.90; the app keeps 0.
- **Who / direction:** Nov A's room is understated.
- **Confidence:** high.

### S6. A small deposit in the lead days counts both as this period's income and inside Step 1's "before the pay" balance, which hides the reconciliation cap
- **Where:**
  - `src/lib/data/payday.ts:640` (`reconciliationLedger`): its date is `fundingWindow.from − 1`, and the window opens on the deposit that passes the 50% rule.
  - `loadLedgerDeposits` adopts every deposit from `incomeWindow.from` onward.
- **Reproduction:**
  - Main stands at −2,000. A 3,000 extra lands Oct 13; it is under 50% of the last 18,450 paycheck. The 15,450 salary lands Oct 15.
  - Step 2 adopts 18,450, the 3,000 included. Step 1's ledger date is Oct 14, so the expected balance (and the prefill) is 1,000.
  - Cap 0, available 20,871.90. Measured before any of the period's income, the cap is 2,000 and available is 18,871.90.
  - Independent script: cap 2,000 vs app 0.
- **Who / direction:** the room is overstated by the hole the lead-day deposit filled, and the cushion double-counts it.
- **Confidence:** high.

### S7. A confirmed plan's income is frozen while the earmark cover it was computed against is live
- **Where:** `src/lib/data/flexible-room.ts:381` (income is the stored `totalIncome`) against live `wholeAmount` commitments and `loadLedgerDeposits`' cover-dependent adoption.
- **Reproduction (interaction I3):**
  - A 25,000 deposit has 3,000 earmarked for the Oct 28 TV installment (3,000). Step 2 adopts 22,000, and the check-in is confirmed at 22,000.
  - The installment is then lowered to 1,500, so the cover drops to 1,500 and the deposit's pay part is 23,500. The confirmed room still counts 22,000.
  - Independent script, scenario `earmarkRaised`: 23,500 vs 22,000.
  - Raising the installment does the reverse. Subagent repro: an 8,000 transfer, the installment restored from 50 to 158.37 EUR, and the room overstated by 1,500.
  - When the user does reopen, R1 forces the new figure. In scenario `adoptEarmark`, a re-confirm at 21,000 is refused (`below_ledger_deposits`, 22,000), and 22,000 is accepted.
- **Who / direction:** either direction, by the change in cover, until the check-in is reopened. The confirmed card and "Recommended" show the wrong room.
- **Confidence:** high.

### S8. Goal money that leaves without pairing with a recurring occurrence is counted in no period figure, so the carryover keeps it
- **Where:**
  - `leftoverFrom` (`src/lib/flexible-room.ts:148`) and `periodLeftover`.
  - Budget spending excludes contribution twins (`src/lib/budget-spending.ts:79-81`).
  - The commitments count a hand-logged contribution only when it settles an occurrence.
  - Combined with `skipReasonFor`'s `goal_achieved`: a hand-logged contribution that fills the goal turns the automatic one it was meant to pay into "goal reached" instead of "settled".
- **Reproduction 1 (interaction I2, scenario `contributionPayday`):**
  - Fondo has a target of 10,000 and 7,000 saved. A 4,000 automatic contribution is due Oct 15 (payday). The user hand-logs 4,000 on Oct 15.
  - The goal fills, and the automatic occurrence becomes `wont_post` instead of settled.
  - The 4,000 left Banco from Oct B's pay but is in no Oct B figure. The leftover is **28,500**; it should be 24,500.
  - Logging 2,000, which pairs and does not fill the goal, lowers the leftover by 2,000. Logging 1,571.32, which fills it, does not.
- **Reproduction 2 (`leadDayAndZeroCarry`):** an unplanned 1,500 contribution gives a leftover of 20,871.90; it should be 19,371.90.
- **Who / direction:** the carryover into the next period is overstated by the goal money.
- **Confidence:** medium. The behaviour is reproduced. Excluding goal money could be intended, but paired and unpaired contributions of the same money are treated differently.

### S9. The monthly pace counts a YEARLY item twice
- **Where:** `src/lib/data/monthly.ts:666-680` (`classifyCompletedMonth`). It adds `monthlyEquivalent` (amount/12) to every month without a charge, and the full charge in the month that has one.
- **Reproduction:** "Domain renewal", 1,200 DOP yearly, posted 2025-08-10 and 2026-08-10.
  - Apr–Sep 2026 committed is 100, 100, 100, 100, **1,200**, 100.
  - `averageCommitted` is 283.33. Cash is 200 a month; amortized it is 100.
- **Who / direction:** "Average monthly committed spending" and the Dashboard pace are inflated.
- **Confidence:** high.

### S10. The monthly pace counts an occurrence twice when the charge that paid it is dated in the previous month
- **Where:** `src/lib/data/monthly.ts:669-671`. It asks whether a charge is dated in the month, not whether the month's occurrences are paid. A settlement can pair a charge up to 5 days before the due date.
- **Reproduction:** Netflix, 500 monthly on the 1st. The Aug 1 occurrence is settled by a CSV charge dated Jul 29.
  - July counts 1,000. August still adds the scheduled 500.
  - `averageCommitted` is 583.33; it should be 500.
- **Who / direction:** overstated.
- **Confidence:** high.

### S11. RECURRING rows posted for past dates set "first activity", so empty months enter the lifestyle average
- **Where:** `src/lib/data/history-window.ts:35-69` (`getFirstActivityDate`, line 56 lets a subscription's RECURRING row count). It feeds the monthly windows and Reports.
- **Reproduction:**
  - The user starts logging in Sep 2026 (1,000 a week). In September they add a 158.37 EUR × 6 plan starting Apr 5, with "post" chosen for past payments.
  - First activity becomes **2026-04-05**. Lifestyle by month: 0, 0, 0, 0, 0, 4,000. `averageLifestyle` is 666.67; real spending is about 4,000.
  - The Reports per-period average is 5,165.6 over 5 periods, including two periods with zero.
- **Who / direction:** the lifestyle average is deflated about 6×, so the current month reads far above average.
- **Confidence:** high. This is the deflation the function's own comment cites as its reason for excluding other row types.

### S12. A euro sell rate above 75 DOP is refused, which drops the bank rate and blocks every DOP conversion
- **Where:** `src/lib/bpd-rate-payload.ts:106` (`parseBpdPayload`) and `src/lib/bpd-rates.ts` (`storeBpdRates`) check `euroSellRate` with `isPlausibleDopRate`, the dollar's 55–75 band.
- **Reproduction:**
  - Dollar sell 63.10 with euro sell 74.90 is stored. Dollar sell 63.10 with euro sell **75.40** (EUR/USD 1.195) gives `out_of_range`, and the scraper's payload is rejected too.
  - With no bank rate, `rateFitForWriting("DOP")` is false.
  - Every EUR→DOP item then waits (`waitingForRates`), and manual or foreign entries into DOP accounts are refused, for as long as the euro stays above 75.
- **Who / direction:** writes are blocked rather than wrong. EUR installments stop posting and their backlog later posts at whatever rate the run has.
- **Confidence:** high.

### S13. A goal's currency can change while it holds contributions; its saved total and achievedAt then follow the exchange rate, fallback included
- **Where:**
  - `src/server/actions/goals.ts:47-49`: no lock like accounts' R19.
  - `src/lib/goals.ts` (`rebuildGoalSaved`): converts with `getRateTable()` and no fitness check, then writes `savedAmount` and `achievedAt`.
- **Reproduction:**
  - A 4,491.32 DOP debt is paid in full and achieved. The user switches the goal to USD with a target of 74.24.
  - At DOP 61.0 the rebuild writes saved 73.63 and clears `achievedAt`. The monthly 1,000 DOP contribution item to it (next Oct 20) is active again.
  - With no stored rates, the fallback DOP 60 writes 92.86 and achieved.
- **Who / direction:** wrong persisted saved total, and money posted into a debt that is already paid.
- **Confidence:** high.

### S14. Correcting a recurring contribution whose goal is in a third currency re-converts its ledger twin at today's rate
- **Where:** `src/lib/goals.ts` (`updateRecurringContributionAmount`, `toAccountMoney` with `twinAsStored`, ~line 214). The kept conversion's original is EUR (the item's currency), not the goal's USD, so it falls through to `inAccountCurrency`.
- **Reproduction:**
  - A USD goal is fed by a 41.29 EUR item from a DOP account. The twin is 2,900.62 DOP (rate 70.25); the contribution is 47.95 USD.
  - Corrected to 55.00 USD at USD/DOP 62: the twin becomes **3,410.00** DOP (original 55 USD), and the EUR original is lost.
  - Scaled at its stored conversion it would be 3,327.25.
- **Who / direction:** the ledger moves by rate drift, +82.75 DOP here.
- **Confidence:** high.

### S15. Posting claims an occurrence with the item as it loaded it; an edit committed in between is overwritten
- **Where:** `src/lib/recurring-posting.ts`. `postOccurrence` advances with the loaded `item.frequency`, `anchorDay` and `amount`. The compare-and-swap checks only `id`, `active` and `nextDate` (and the countdown).
- **Reproduction:**
  - Monthly Gym, 500 DOP, due Oct 4. Posting loads it.
  - An edit committing WEEKLY at 650 with the same date, under the item lock, lands before the claim. I forced the interleaving with a psql session holding the lock for 3.5 s.
  - Result: a 500 row is written, and `nextDate` becomes **Nov 4 on a WEEKLY item**. The Oct 11, 18 and 25 charges never post.
- **Who / direction:** a wrong amount is written and three weekly charges are lost. It needs a request to run posting concurrently with the save; posting runs on every request.
- **Confidence:** high that the race exists; how often it occurs is unknown.

### S16. The debt comparator subtracts a payment dated ahead from period 1's minimum but not from the balance
- **Where:** `src/lib/data/debt-payoff.ts:40-42`. `balance` is `displayRemaining` (as of today); `paidThisPeriod` is `plan.contributed` (the whole window, including dates after today).
- **Reproduction:**
  - Today is Oct 4. A 4,491.32 card debt with target Nov 30 has a full payment logged for Oct 8. There is also a 20,000 undated loan.
  - Card shows balance 4,491.32, minimum 898.26, paid 4,491.32. The comparator puts Card's payoff in **period 5** and Loan's in period 28. Card is really paid in period 1, which frees its minimum for the loan.
- **Who / direction:** payoff dates are later than they will be.
- **Confidence:** high.

---

## Low

### S17. Moving an item's date just past the charge's window releases the user's "It's that payment" answer, and the occurrence posts again
- **Where:** `src/lib/data/recurring.ts:642-650`.
- **Reproduction:** item due Oct 30, charge Oct 29 recorded as that payment. The date is moved to Nov 4. The pairing is released (the toast says so), Nov 4 posts 1,333.33, and the user has paid twice. Moving to Nov 3 rekeys correctly.
- **Confidence:** high.

### S18. A deposit fully earmarked before a check-in is treated as adopted pay afterwards, so its earmark can no longer be lowered
- **Where:** `src/lib/period-income.ts:160-182` (`isAdoptedDeposit`). The window is any confirmed adoption on the account plus createdAt ≤ updatedAt; it does not ask whether this deposit's pay part was adopted.
- **Reproduction:** a 5,000 transfer is fully earmarked; Step 2 adopts only the salary. After confirm, lowering the earmark to 4,000 returns `adopted_paycheck`.
- **Confidence:** high.

### S19. The zero-amount refusal (R29) is not applied to transfers, CSV import, receipt approval or posting
- **Where:** `src/lib/account-money.ts` (`transferLegsInAccounts`) and the import, staged-approval and posting writes.
- **Reproduction:** a 0.25 DOP transfer from a DOP account to a USD account stores the receiving leg as **0.00 USD** (original 0.25 DOP).
- **Confidence:** high.

### S20. The bank's EUR rate is stored as a rounded cross-rate, so some conversions come out one cent low
- **Where:** `src/lib/bpd-rate-payload.ts:121-125` (EUR = dollar sell / euro sell, stored at 10 decimals), then `rateBetween`/`atRate`.
- **Reproduction:** 158.37 EUR at euro sell 68.50 (dollar 58.00) converts at 68.4999999973. That stores 10,848.34; the bank's figure is 10,848.35. 501 of 13,122 rate/amount combinations scanned are off by one cent.
- **Confidence:** high.

### S21. A posted row freezes the rate of the run, not of its due date
- **Where:** `src/lib/recurring-posting.ts`: one rate table per run.
- **Reproduction:** a backlog of four 158.37 EUR and four 41.29 EUR occurrences, posted in one run. Every row gets rate 70.250000001.
- **Related (code reading):** the first request after local midnight posts that day's occurrence at the stored bank rate, usually the previous day's, before the scraper stores the new one.
- **Note:** the file header promises "at the day's rate".
- **Confidence:** high. This is a design limitation rather than a defect.

### S22. A goal in a third currency carries a permanent "not yet contributed" of a few cents
- **Where:** the contribution is rounded in the goal's currency (`convertedForGoal`), while the ledger row is rounded in the account's. `followThroughShortfall` (`src/lib/goal-plan.ts:142-148`) compares the two in the display currency.
- **Reproduction (`ratesBankFresh`):**
  - A 50 EUR contribution item from a DOP account into a USD goal: the ledger row is 3,660.00 DOP; the contribution is 58.00 USD, which displays as 3,659.80.
  - With the plan's by-hand 2,982.11 also contributed (47.26 USD), the follow-through shortfall stays **0.20**.
  - `getGoalRoadmapStatuses` keeps reporting it for the period after, which is what the Inbox's "goal behind" reads.
- **Confidence:** high.

### S23. Recurring detection suggests a charge already tracked by an item with another name on another account
- **Where:** `src/lib/recurring-detection.ts:647-670` (`isTracked`).
- **Reproduction:** item "Music", 650 DOP, on Bank, category Subscriptions. Monthly SPOTIFY charges of 650 DOP on Card are still suggested ("Spotify", monthly, next Oct 12). Accepting the suggestion creates a second item for the same money.
- **Confidence:** high.

---

## Interactions requested

- **A pairing recorded ahead, the date edited across a period end, posting run twice:** correct (Gym 40 EUR, Oct 30 to Nov 2). The pairing is rekeyed, nothing posts for Nov 2, and the countdown goes 6 to 5. Oct B spending excludes the charge and Nov A counts it as settled.
  - A move just past the window releases the pairing (S17).
  - Moving the schedule back moves a claimed pairing forward (S4).
- **A contribution due on a payday, the goal filling part-way, a hand-logged contribution, carryover being reconciled:** S8. The carryover reconciliation itself worked: the Oct A late row moved Oct B's carryover from 12,000 to 10,500.
- **Step 2 adoption of a partly earmarked deposit, the installment lowered, reopened and confirmed again:** S7. The reopen path refuses 21,000 and accepts 22,000, which is correct. S2 and S18 are adjacent.
- **Rates:**
  - Bank rate fresh while open.er-api is stale: posts at the bank rate. 9.99 EUR → 731.27 DOP, matching my independent figure.
  - Bank rate older than 7 days: the item waits, and commitments use open.er-api.
  - Posting on the scraper's day: S21.
  - A goal in a third currency: S14 and S22.
  - A euro sell rate above the band: S12.
- **Two sessions:**
  - Two confirms: one wins, the other gets `changed_since_loaded`, and only one paycheck row is written.
  - A confirm during a carryover adjustment: consistent by code reading, apart from S5.
  - Posting while "It's that payment" is answered: both take the item lock first, and the claim re-reads the pairing. No deadlock path found.
  - A schedule edit during posting: S15.
- **Time:**
  - Rent anchored on the 31st posts Jan 31, Feb 29 2028 and Mar 31.
  - SEMI_MONTHLY 15/31 posts Jan 14 (Saturday the 15th moved back), Jan 31, Feb 15, Feb 29 and Mar 15.
  - A contribution due on payday Feb 29 is filed in Mar A.
  - Oct 31 2026 (a Saturday) pays Oct 30.
  - Stored dates are civil days and `today()` uses Santo Domingo. I found no evening shift in the money paths.
- **The user's real shape (scenario `realShape`):** every figure matched my independent recomputation.

## Independent recomputation

The script is `recompute.mjs`, written in node with raw SQL through `pg` and plain arithmetic; it imports nothing from `src/`. I built it from the rules as I understood them before reading the app's claims:
- A period runs the 1st–15th or the 16th–end.
- Pay lands on the 15th or the last day, pulled back to Friday off a weekend.
- A deposit funds the period whose income window it falls in (from the earlier of its payday and 5 days before the start).
- A contribution counts in the period whose pay funded it.
- Earmarked deposit money lowers its occurrence and is left out of the income estimate.
- Budget spending is every expense that is not a recurring occurrence's row, a charge paying one, or a contribution twin, at the user's share.
- Room = income + carryover − whole commitments − GOAL rows − essentials − buffer − cap.
- The leftover is that room's essential + available − spending.
- Goal pace = (target − saved before the plan period's pay − money dated ahead in the goal's window) ÷ the periods whose pay lands by the target date.

I ran it against eleven seeded scenarios, each on its own database (the app's state was built through its own write paths): `realShape`, `pairingEdit`, `contributionPayday`, `adoptEarmark`, `ratesBankFresh`, `ratesBankOld`, `leapYear`, `spending`, `pauseResume`, `leadDayAndZeroCarry`, `earmarkRaised`. I compared, per period:
- whole subscriptions and contributions, and the outstanding amount;
- income as fact and as estimate;
- budget spending;
- the confirmed room and the leftover;
- the stored carryover;
- the plan period and each goal's pace.

**232 comparisons agree**, 21 of them ground-truth checks. **6 disagree, and each one is an app finding, not a script error:**

| Scenario | Check | Independent | App | Finding |
|---|---|---|---|---|
| contributionPayday | Oct B leftover net of goal money that left | 24,500 | 28,500 | S8 |
| pauseResume | Laptop payments over the plan (created with 6) | 6 | 7 | S1 |
| leadDayAndZeroCarry | Oct A reconciliation cap | 2,000 | 0 | S6 |
| leadDayAndZeroCarry | Oct B leftover net of goal money that left | 19,371.90 | 20,871.90 | S8 |
| leadDayAndZeroCarry | Oct B carryover taken from Oct A | 18,871.90 | 0 | S5 |
| earmarkRaised | Oct B plan income (own row + adopted deposits less live cover) | 23,500 | 22,000 | S7 |

A first pass that encoded only the app's own definitions agreed with it on all 159 comparisons. The mismatches appeared only after I added ground truths those definitions do not state:
- an installment plan makes as many payments as it was created with;
- goal money that left a period is not left over;
- a plan's income is what funded it;
- the cap is measured before any of the period's income;
- a carryover the user took follows its source period.

## Baseline runs

- **`scripts/verify-domain.ts`:** 3,057 checks pass ("All checks passed", exit 0). Two environment points:
  - It needs the seeded categories (`prisma/seed.ts`); without them it crashes on `groceries!.id`.
  - It needs `OAUTH_ENCRYPTION_KEY`; without it it crashes at the ingestion section, after 2,225 checks.
- **`scripts/verify-no-double-counting.ts`:**
  - Exit 0 on nine of the ten scenario databases I ran it on, including every one that holds S1, S5, S6, S7 or S8. It has no check for an installment countdown, the carryover, or goal money outside a pairing.
  - Exit 1 on `spending`, pair 1. "getPeriodSummary(2026-10-B).spent does not decompose": the reader's 14,500 vs the audit's 15,000. This is the audit's false positive. It counts a 500 Netflix charge (on another account, Oct 24) that the settlement plan already pairs with the Oct 28 occurrence before posting records it. Budget spending correctly leaves that charge out.

## Checks that would pass on wrong code

- **`verify-domain.ts:8146` and `8531`**, "an out-of-range euro sell rate is rejected" / "... refused with ... out_of_range": they use a euro sell rate of 999. **`:8419`**, "the plausible band is the documented 55-75 DOP", pins the one band applied to both currencies. All three pass with S12; a euro sell of 75.40 would be refused.
- **`verify-domain.ts:5977`**, "a resumed installment plan keeps its countdown - the skipped payments were never charged": the fixture has no recorded "It's that payment" pairing, so it passes with S1.
- **The R8 carryover checks** (from `verify-domain.ts:15571`) always settle at a positive amount (35,000 → 20,000). None settles at 0, so they pass with S5.
- **The R1 adoption checks** (around `verify-domain.ts:15380`): no deposit or earmark changes between draft and confirm, and the earmark never changes after confirm. They pass with S2 and S7.
- **The backfill checks** (around `verify-domain.ts:13690`) run only with stored, fresh rates (61.2). They pass with S3.
- **`verify-no-double-counting.ts`** passes on every database holding S1, S5, S6, S7 or S8 (see above).

## Unproven (suspected, evidence still missing)

- **Staged approval acts on the match it recomputes, not the one the reviewer was shown** (`src/lib/data/staged-approval.ts` around 122-135). "It's that payment" or "It's the posted charge" could pair the wrong item when the reviewer's category changes which of two look-alike items is primary. Missing: a run with two same-amount items on one account.
- **`recordUpcomingPayment` (`src/lib/data/posted-duplicates.ts:727`) does not check that the key's date is on the item's schedule.** With the CSV lookup failing open, or an edit landing between the check and the write, a pairing could sit on a key the schedule no longer has. The real occurrence would then post too. Missing: a reproduction of either window.
- **The bank rate's 7-day window is counted in UTC days** (`bpd-rate-payload.ts`, `utcDaysBetween`). On day 7 it drops out at 20:00 Santo Domingo time. Missing: a timed run.
- **Posting's goal-reached check counts only contributions dated on or before today** (`recurring-posting.ts`). A recurring contribution may still post into a debt fully paid by a contribution dated a few days ahead, which the pace already treats as committed. Missing: a run.
- **History window, comment-level** (`src/lib/history-window.ts:38`): "at least 12 of its 13-16 days covered" is false for a February B period. Missing: a figure that moves materially.
- **History window, first-month rule** (`src/lib/data/monthly.ts:288`): the monthly first-month rule (day ≤ 7) differs from the period rule (day ≤ 4). Missing: a figure that moves materially.
- **`src/lib/data/extraordinary.ts:60-70`**: the one-off median reads contribution twins and settled charges that the suggestion average leaves out. It affects only the "possibly extraordinary" prompt. Not reproduced.
