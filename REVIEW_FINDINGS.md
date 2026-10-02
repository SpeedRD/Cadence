# Adversarial review of Cadence's money logic (2026-10-01)

## How this was done

- **Inputs.** Every module in scope was read before QUANTITIES_MAP.md, the
  Status lines of BUG_HUNT_FINDINGS.md and the K1+ sections of
  `scripts/verify-domain.ts`. Those were read only afterwards, to judge the
  checks.
- **Subagents.** Four read-only subagents proposed candidates. A candidate is
  listed here as a finding only after I reproduced it myself with my own
  script.
- **Throwaway databases** (fictional "Fict" rows only, never production):
  - `cadence_review_harness`: harness baseline.
  - `cadence_review_recompute`: the independent recomputation.
  - `cadence_review_repro`: reproductions.

  All three are created, migrated and seeded with the default categories.
- **Scripts.** All live in the session scratchpad:
  - `rc/`: the seed, the independent script, the app-side reader and the diff.
  - `rp/`: one script per reproduction, plus `lib.ts` and `run.sh`.
- **Rates.** Unless noted: USD 1 / DOP 60 / EUR 0.9, buffer 10% with a 2,000 DOP
  floor, network cut so no rate is fetched.
- **No source, test or config file was changed.**

**Severity.**
- **High:** wrong money written, or a wrong figure the user acts on, in an
  ordinary scenario.
- **Medium:** the same, in a narrower scenario.
- **Low:** a narrow trigger, a small amount, or understatement only.

**Confidence** is about whether the defect is real.

## Baseline runs

- **`scripts/verify-domain.ts`** on `cadence_review_harness`: 2,739 ok, 0 fail
  (34 s).
- **`scripts/verify-no-double-counting.ts`** on the recompute database
  (`AUDIT_TODAY=2026-10-01`): exit 0, all five pairs clean.
  - It also reports clean on a database holding two of the double counts below
    (R2 and R5). See "Checks that pass on wrong code".

## Independent recomputation

- **Seed.** `rc/seed.ts` writes through the app's own writers:
  - posting run day by day;
  - `logManualContribution`, `saveEarmarks` and `confirmPaydayCheckin`.
- **Scenarios:**
  - **Weekend payday:** Aug 15 2026 is a Saturday, so 08-B's check-in is on Fri Aug 14.
  - **Late check-in:** 09-B, confirmed Sep 25.
  - **Check-in on payday:** 10-A, Sep 30, with a provisional carryover.
  - **Foreign subscriptions:**
    - EUR 12.99 on the 5th, on a DOP account.
    - USD 9.99 on the 31st, on a DOP account, so it also clamps in 30-day months.
  - **A DOP gym fee logged by hand before its due date.**
  - **An installment plan:** 4 × 6,000 DOP, with a 3,000 DOP earmark on its Oct 10 occurrence.
  - **A goal with a monthly 100 USD recurring contribution,** plus a contribution dated ahead (Oct 20).
  - **A shared expense.**
  - **Interest on Sep 12 and a refund on Sep 27.**
- **Independent script.** `rc/independent.mjs` uses raw SQL through `pg` and
  imports nothing from `src/`. It has its own calendar and paydays, schedule
  walk, earmark bounding, income attribution, budget spending, goal pace and
  confirmed flexible room.
- **App side.** `rc/app.ts` calls `loadCommitments`, `loadPeriodIncome`,
  `loadBudgetSpent`, `loadGoalPeriodPlans` and `loadConfirmedRooms`.
- **What matched.** For 07-B through 10-B:
  - every commitment occurrence (key, status, amount);
  - income, both fact and estimate;
  - budget spending;
  - the confirmed rooms of 08-B, 09-B and 10-A.
- **Mismatch that was a script error.** My first run also differed on spending
  (09-A, 09-B), the 10-A carryover and one 10-B occurrence. node-pg parses
  `date` columns as local midnight; re-running with `TZ=UTC` removed every one
  of these.
- **Mismatches that are findings.** All come from one cause, **R4**:
  - "Fict Emergency" contributed: 09-B app 0 vs 83.33 USD; 10-A app 83.33 vs 0.
  - Its pace: 119.05 USD in the app vs 107.14 in my script, in 10-A and 10-B.

## Findings

### High

**R1. A check-in for pay already in the ledger records it a second time** (high confidence)
- **Where:** `src/lib/data/payday.ts:1541-1565` (confirm always creates a
  `PAYDAY_CHECKIN` INCOME row), `:914-931` (the draft prefills Step 2 with 0 and
  shows no existing deposit), `src/lib/data/period-income.ts:102-128` (counts
  both).
- **Repro (`rp/r_paycheck.ts`):**
  1. The 10-A salary of 60,000 DOP is imported by CSV on Sep 30.
  2. The Sep 30 check-in's Step 2 shows 0.
  3. The user enters 60,000 and confirms.
- **Result:**
  - The ledger has two 60,000 INCOME rows.
  - The account balance is 120,000.
  - 10-A income is 120,000 as fact and 120,000 as estimate. The estimate is
    what Afford, the room check and the goal forecast average.
- **Who and direction:** anyone who imports the bank statement before checking
  in. The balance and income history are overstated by one paycheck. A later
  Afford verdict is inflated by that period's share.
- The duplicate check exists only for a deposit brought in *after* the check-in.

**R2. A charge whose bank date is 1-4 days after an end-of-period due date is never matched, so it is counted twice without asking** (high confidence)
- **Where:** `src/lib/recurring-settlement.ts:167-170`. The settlement window
  ends at the due date's period end, and `planPostedDuplicates` uses the same
  window.
- **Repro (`rp/r_window.ts`):** Internet bill of 2,800 DOP due Oct 15, posted.
  The bank row arrives dated Oct 16.
  - `findPostedDuplicates` → **not asked**.
  - The same row dated Oct 14 → asked.
  - `rp/r_auditstate.ts` imports it: the ledger then holds the RECURRING 2,800
    and the CSV 2,800.
- **Who and direction:** items due on the 13th-15th or the 28th-31st whose
  card posts later, which the code's own `PROXIMITY_DAYS` comment says is
  normal. Spending and the balance are overstated by the charge.

**R3. A recurring contribution due on a payday is "scheduled" in one period and "contributed" in the next, which raises a false follow-through shortfall** (high confidence)
- **Where:**
  - `src/lib/data/goal-plan.ts:172-179`: contributed is counted by funding
    window, payday to payday.
  - `src/lib/period-commitments.ts:227,280`: scheduled is counted by the due
    date's calendar period.
  - `src/lib/data/payday.ts:524-553`: the "earlier" periods are judged here.
- **Repro (`rp/r_goal15.ts`, `r_goal15b.ts`):** goal "Fict House" with 5,000 DOP
  monthly on the 15th; 10-A confirmed with 0 by hand; posted Oct 15. The goal
  plans then read:

  | Period | scheduled | outstanding | contributed | planned | follow-through shortfall |
  |---|---|---|---|---|---|
  | 10-A | 5,000 | 0 | 0 | 0 | **5,000** |
  | 10-B | 0 | — | 5,000 | — | 0 |

  `getGoalRoadmapStatuses` on Oct 20 returns 10-A with follow-through shortfall
  5,000.
- **Who and direction:** contributions anchored to the 15th or to an
  end-of-month payday, which is common.
  - The earlier period shows a false "not contributed" note, inviting a second
    5,000.
  - The next period's contributed is inflated by 5,000, which can hide a real
    shortfall.

### Medium

**R4. Any ordinary deposit 1-5 days before a payday opens the next period's goal window early** (high confidence)
- **Where:** `src/lib/data/period-income.ts:182-192` (`loadPayLanded` accepts
  any non-one-off INCOME row), `src/lib/period.ts:178-183`, read by
  `src/lib/data/goal-plan.ts:151-179` and by `reconciliationLedger`
  (`src/lib/data/payday.ts:596-605`).
- **Repro (independent recomputation):**
  1. 10-A's pay lands Wed Sep 30.
  2. A 25 USD refund arrives Sep 27.
  3. On Sep 28 the user moves 5,000 DOP of September money to "Fict Emergency"
     (50,000 by 2026-12-31).
- **Result:**
  - The 5,000 counts as 10-A's.
  - 09-B shows 0 contributed.
  - The pace is 119.05 USD (7,142.86 DOP, i.e. 50,000 / 7). It should be
    107.14 USD (45,000 / 7).
- **Who and direction:** anyone with interest, a refund or a transfer in the
  lead days. The goal pace and the check-in recommendation are overstated. The
  previous period's follow-through is understated.
- **Traced in code only, not run:** the same row also moves Step 1's
  reconciliation date earlier.

**R5. An "It's that payment" pairing is orphaned when the item's schedule is edited, so the new occurrence posts too** (high confidence)
- **Where:**
  - `src/lib/data/recurring.ts:366-418`: edits never re-key or remove
    `RecurringSettlement`.
  - `src/lib/data/recurring-settlement.ts:91-121,158`: the old key is never
    walked, and the charge is no longer a candidate.
  - `src/lib/data/period-commitments.ts:81-130`: the orphan still counts.
- **Repro (`rp/r_orphan.ts`):**
  1. A 10 EUR item due Oct 5.
  2. A 667 DOP charge on Oct 3 is recorded as that payment.
  3. The due date is edited to Oct 6, then posting runs.
- **Result:**
  - A RECURRING row of 666.67 DOP is written.
  - 10-A commitments list `10-05 settled 667` **and** `10-06 posted 666.67`.
- **Direction:** the ledger and commitments are overstated by one occurrence.

**R6. A charge paired with an upcoming occurrence counts as budget spending and as a settled commitment until posting runs** (high confidence)
- **Where:**
  - `src/lib/period-commitments.ts:269-276`: uses the planned settlement.
  - `src/lib/budget-spending.ts:68-71` and `src/lib/data/budget-spending.ts:32,53`:
    excluded only once a `RecurringSettlement` row exists.
- **Repro (`rp/r_edit.ts`):** gym 2,500 DOP due Oct 10, paid and logged Oct 2,
  read on Oct 3.
  - 10-A commitments: `settled 2500`.
  - 10-A budget spending: 2,500.
  - Settlement rows: 0.
- **Direction:** spent is overstated and safe-to-spend understated until the
  due date.
- **Traced in code only, not run:** if a carryover settles in between (R8), the
  error is kept permanently.

**R7. Carryover counts unspent *budget* as money when budgets exceed the plan** (high confidence)
- **Where:** `src/lib/flexible-room.ts:144-151` takes
  `max(periodBudget, essential + available) - spent`.
- **Repro (`rp/r_est.ts`):**
  1. 09-B confirmed: income 50,000 DOP, buffer 5,000, so the plan leaves 45,000.
  2. The user raises Groceries to 60,000 on the Budgets page and spends 10,000.
- **Result:** the carryover offered to 10-A is **50,000**. Income less spending
  is only 40,000.
- **Direction:** the next period's flexible room is overstated by the
  over-budget (15,000 here).

**R8. A provisional carryover settles once, on the first read after its period ends; later rows dated in that period never reach it** (high confidence; decision 3 allows this, but the money is overstated)
- **Where:** `src/lib/data/flexible-room.ts:156-170,190-198`.
- **Repro (`rp/r_carry.ts`):**
  1. 09-B leftover 35,000, taken provisionally on Sep 30.
  2. On Oct 1 it settles at 35,000.
  3. On Oct 3 a CSV brings a 15,000 DOP expense dated Sep 29.
- **Result:**
  - 10-A carryover stays 35,000 and available stays 80,000.
  - 09-B's live leftover is now 20,000.
- **Who and direction:** anyone whose statement arrives after month end, which
  is ordinary. The overstatement flows into 10-A's leftover and on.

**R9. A posted RECURRING row whose date is edited across a period boundary is counted in no period** (high confidence)
- **Where:** `src/lib/data/period-commitments.ts:77-80,103` selects rows by
  stored date; `src/lib/period-commitments.ts:227-228` files them by the key's
  due date. Budget spending excludes RECURRING rows. Date edits are allowed
  (`transactionEditBlock`, `src/lib/transactions.ts:101-112`).
- **Repro (`rp/r_edit.ts`):** rent 25,000 DOP posted Sep 30; the row's date is
  corrected to Oct 1. Then:
  - `loadCommitments([09-B])` returns nothing, and so does `([10-A])`.
  - `([09-B, 10-A])` gives 09-B `posted 25000`.
  - Budget spending is 0 in both periods.
- **Direction:** single-period readers (period summary, check-in, confirmed
  card, carryover) drop the rent. Multi-period Afford keeps it, so the screens
  disagree.

**R10. An item posting will skip still takes a charge in the settlement plan, so its look-alike posts a duplicate** (high confidence)
- **Where:**
  - `src/lib/data/recurring-settlement.ts:59-60`: due items are not filtered by
    `skipReasonFor`.
  - `src/lib/recurring-settlement.ts:210-212`: ties go to the lower id. cuids
    are time-ordered, so the older item wins.
- **Repro (`rp/r_steal.ts`):** "Fict Music", 350 DOP, exists twice: the old item
  on an archived card and the new item on the new card. A CSV charge of 350
  arrives Oct 4.
  - The plan settles `a-old-item:2026-10-05`.
  - Posting skips the old item (`account_archived`) and **posts** the new one:
    the ledger holds CSV 350 plus RECURRING 350.
- **Direction:** the ledger is double-counted by the charge.

**R11. Settlement works across accounts, but the after-posting duplicate check does not** (high confidence)
- **Where:**
  - `src/lib/recurring-settlement.ts:220-227` takes a charge on any account.
  - `:424` requires `posted.accountId === entry.accountId`.
- **Repro (`rp/r_window.ts`):** gym 2,500 DOP on account A, posted Oct 10. The
  charge is imported on card B dated Oct 11 → **not asked**.
- **Direction:** a charge entered after the due date from another card is
  double-counted. The same charge entered before posting would have settled it.

**R12. Moving `nextDate` back onto an occurrence a charge already settled settles it again** (high confidence)
- **Where:** `src/lib/recurring-posting.ts:208-220,266-283`. The "already
  posted" guard only looks for a RECURRING row, and a recorded settlement is
  accepted again.
- **Repro (`rp/r_resettle.ts`):**
  1. CONTRIBUTION item of 5,000 DOP, `remainingOccurrences` 3, settled by a
     CSV charge on Oct 4.
  2. The item's date is set back to Oct 5, and posting runs again.
- **Result:**
  - Goal saved goes from 5,000 to **10,000**.
  - Remaining goes from 2 to 1.
  - Two GoalContributions carry the same key, against one ledger row.
- **Direction:** the goal is overstated, and the installment plan ends one
  payment early.

**R13. Editing a deposit deletes its earmark on any occurrence before the current period** (high confidence)
- **Where:**
  - `src/lib/data/earmark-targets.ts:51-58`: the options start at the current
    period.
  - `src/components/transactions/transaction-dialog.tsx:191-199,572`:
    `shownLines` drops lines that are not options, but `earmarkOffered=true` is
    still sent.
  - `src/server/actions/transactions.ts:175-177` → `saveEarmarks(…, [])` →
    `deleteMany`.
- **Repro (`rp/r_earmark.ts`):** a 3,000 DOP deposit (Sep 20) earmarked for the
  phone installment due Sep 25.
  - On Oct 2 the options do not include it.
  - Re-sending the line is refused (`issue: "target"`).
  - The dialog's save (no lines) succeeds and leaves 0 earmark rows.
  - 09-B's phone cost goes from 6,000 − 3,000 back to 6,000.
- **Direction:**
  - Any edit, even of the note, raises the past period's cost and lowers its
    leftover, and the carryover if it is not settled yet.
  - The deposit returns to the income estimate.

**R14. A recurring suggestion duplicates an item paid from another account** (high confidence)
- **Where:**
  - `src/lib/recurring-detection.ts:593-613`: `isTracked`'s amount and category
    match needs the same account.
  - `src/lib/data/recurring-suggestions.ts:49-71`: settled charges are not
    excluded.
- **Repro (`rp/p_currency.ts`):** "Fict Rent", 25,000 DOP, on account A, paid
  Jul 1, Aug 1 and Sep 1 from account B with the note "Transferencia Fict
  Landlord".
  - `planSettlements` pairs all three with Rent.
  - Detection still offers "Transferencia Fict Landlord 25000 MONTHLY account B".
- **Direction:** accepting it commits rent twice. Thereafter one charge settles
  one item and posting writes the other.

**R15. U3 proven: the subscription room check for an edited item disagrees with the same check once the item is gone** (high confidence)
- **Where:** `src/lib/data/subscription-room.ts:106-120`. The own commitment is
  taken only from `committed`; the goal estimate was computed with the item in
  place.
- **Repro (`rp/u3.ts`):**
  - Salary history of 60,000 DOP.
  - A dated goal whose pace exceeds the room.
  - Insurance of 20,000 DOP due Oct 25.
- **Result:**

  | Check | headroomAfter | passes |
  |---|---|---|
  | Editing the item (`excludeItemId`) | 0 | yes |
  | The same subscription after deleting the item | **−20,000** | **no** |

- **Direction:** the room is overstated when goal funding is capped by headroom.

**R16. A future-dated contribution that completes a goal is ignored by the pace, so the check-in keeps asking** (high confidence)
- **Where:** `src/lib/data/goal-plan.ts:156-163,183-187`. `savedBefore` drops
  every row from the pace day on, including later periods.
- **Repro (`rp/r_goals2.ts`):** target 10,000 DOP by Dec 31; 5,000 dated Sep 1
  and 5,000 dated Nov 20 (saved 10,000).
  - On Oct 1: pace = byHand = **714.29** for 7 periods, and `open: true`.
- **Direction:** the check-in recommends about 5,000 more than the goal needs.

**R17. Period commitments reserve every scheduled contribution even when the goal fills part-way through the period** (high confidence)
- **Where:** `src/lib/period-commitments.ts:258-276`. The skip rule reads only
  `achievedAt` (`src/lib/recurring.ts:377`); posting stops at the target
  (`src/lib/recurring-posting.ts:221-229`).
- **Repro (`rp/r_goals2.ts`):** goal 9,000 of 10,000 saved, 1,000 weekly.
  - 10-B commitments: Oct 16, 23 and 30, total **3,000**.
  - Posting through Oct 31 posts 1, then skips Oct 23 `goal_achieved`.
- **Direction:** the room is understated by 2,000.

**R18. An expense filed under Subscriptions or Savings with no recurring item behind it is in no figure** (high confidence)
- **Where:** `src/lib/budget-spending.ts:79-90`.
- **Repro (`rp/p_currency.ts`):** `budgetSpentFrom` of
  [3,000 Groceries, 1,200 Subscriptions, CSV, not settled] = **3,000**. The row
  is not in commitments either.
- **Direction:** safe-to-spend and leftover are overstated by such charges,
  e.g. a subscription the categorizer files but no item tracks.

**R19. An account's currency can be changed after it has rows; every row then floats with today's rate, and the backfill discards the typed amount** (high confidence on the mechanism)
- **Where:** `src/server/actions/accounts.ts:28-30`, `src/lib/validation.ts`
  (`accountSchema`), `src/lib/account-money.ts:214-216` (`accountAmount`) and
  `:392-394` (`planBackfill`).
- **Repro (`rp/p_currency.ts`):**
  1. A 1,000 DOP expense is stored on a USD account as
     `16.67 USD (orig 1000 DOP @0.0166666667)`.
  2. The account is switched to DOP.
- **Result:**
  - `accountAmount` gives 1,000.20 at a rate of 60 and 1,050.21 at 63, while
    `exactAmountIn` says 1,000.
  - `planBackfill` writes `1050.21 DOP` and nulls the original.
- **Direction:** balances and history drift daily, and the typed figure is lost.

### Low

**R20. U8 proven: with no stored rates and the service down, posting and contributions freeze the hard-coded fallback** (high confidence; rare trigger)
- **Where:** `src/lib/rates.ts:177-185`. No writer reads `stale`.
- **Repro (`rp/u78.ts`):** the table is `{DOP 60, EUR 0.92, stale: true}`.
  - EUR 12.99 posts as **847.17 DOP @65.217**.
  - A 100 USD contribution twin is written as **6,000 DOP @60**.

**R21. U7 proven: an older Banco Popular rate overwrites a newer one** (high confidence)
- **Where:** `src/lib/bpd-rates.ts:95-130`. `asOf` is not compared.
- **Repro (`rp/u78.ts`):** store asOf Oct 1 at 63.20, then a re-run with asOf
  Sep 30 at 62.40. Both return `ok`, and the stored row is 62.40 asOf Sep 30.

**R22. Re-confirming after an income account was archived drops its buffer and gap, so the deficit check is skipped** (high confidence; narrow)
- **Where:** `src/lib/data/payday.ts:1249,1255,1294`. `accountInputs` excludes
  the archived account; `archivedIncome` keeps its income.
- **Repro (`rp/r_archive.ts`):** account A has 40,000 of income; account B has
  20,000 with a reported balance of −8,000.
  - Before archiving, a flexible plan of 50,000 is refused with
    `deficit_not_acknowledged` (available 46,000).
  - After archiving B, it is accepted. Room becomes 48,000 (buffer 4,000) and
    the Groceries budget is 50,000.

**R23. The income estimate drops the whole earmarked amount even when the occurrence shrank or disappeared** (high confidence; understates)
- **Where:** `src/lib/data/period-income.ts:106-109`.
- **Repro (`rp/r_est.ts`):** 10,000 earmarked for an installment that is then
  lowered to 4,000, then paused. The 10-A estimate stays **0** throughout.

**R24. A hand-logged contribution of the same amount silently settles the automatic one** (certain; arguably by design, B16)
- **Where:** `src/lib/recurring-settlement.ts:223-225` and
  `src/lib/recurring-posting.ts:220,283`.
- **Repro (`rp/r_goals2.ts`):** 5,000 logged Nov 17 as "birthday money"; the
  auto 5,000 is due Nov 20.
  - Posting gives `alreadyLogged: 1`, `posted: 0`, and the goal holds 5,000.
- If the standing order also ran, the goal is understated and the balance
  overstated by 5,000. The user is never asked.

**R25. Re-saving an automatic contribution re-converts its ledger row at today's rate when item, account and goal currencies all differ** (high confidence; rare configuration)
- **Where:** `src/lib/goals.ts:148-157,176-205`.
- **Repro (`rp/r_c5.ts`):** item 100 USD, account DOP, goal EUR. It posts as
  `6000 DOP (orig 100 USD @60)`. Re-saving the same 90 EUR at rates 63 / 0.86
  gives **6,593.02 DOP**.

**R26. Semi-monthly detection misreads weekend-shifted anchors** (high confidence; it is a suggestion the user reviews)
- **Where:** `src/lib/recurring-detection.ts`, the anchor scoring.
- **Repro (`rp/p_currency.ts`):** charges on Fri Jul 31, Fri Aug 14 and Tue
  Sep 1 (true anchors 1 and 16) are read as `SEMI_MONTHLY [1, 14]`.
- The item then posts on the 14th: the wrong half of the month, and outside
  the 16th's settlement window, so R2 applies.

**R27. The spending history boundary counts income as first activity** (high confidence)
- **Where:** `src/lib/data/history-window.ts:20-31` and
  `src/lib/history-window.ts:71-77`.
- **Repro (`rp/p_d5.ts`):** the first row is a Jul 1 paycheck typed for Afford;
  spending is logged only from September.
- Reports averages six periods: 10,333 per period instead of 31,000.

**R28. The one-cent tolerance depends on float noise** (high confidence)
- **Where:** `src/lib/account-money.ts:235-245` and
  `src/lib/recurring-settlement.ts:135-138`.
- **Repro:** `sameMoneyExactly` with amounts one cent apart:

  | Pair | Match |
  |---|---|
  | 0.03 / 0.04 | false |
  | 0.09 / 0.10 | false |
  | 0.12 / 0.13 | false |
  | 10.07 / 10.08 | true |
  | 599.39 / 599.40 | true |

**R29. A small foreign entry is stored as 0.00** (high confidence)
- **Where:** `src/lib/account-money.ts:92-102`.
- **Repro:** `inAccountCurrency(0.25 DOP → USD @60)` gives `amount: 0`.

**R30. U6, proven at the server: the money writers have no idempotency** (high confidence)
- **Where:** `src/lib/data/manual-transaction.ts:101`.
- **Repro (`rp/u56.ts`):** two concurrent `createManualTransaction` calls with
  identical values write two rows.
- **Not shown:** that a browser sends the second request. `SubmitButton`
  disables while pending; two tabs or a retried request would do it.

## U1-U9 outcomes

- **U1 Unproven.**
  - **Code still shows the risk:** the prompt still sends `Received: <UTC ISO>`
    with no timezone, at `src/lib/llm/parse-transaction-email.ts:88`.
  - **Missing:** a model run. The local `ANTHROPIC_API_KEY` in `.env` is empty,
    so the parser returned `failed` (auth). The fictional test emails are in
    `rp/u12.ts`.
- **U2 Unproven,** for the same reason.
  - "payment received" is still a filter keyword (`src/lib/email/filters.ts`).
  - Approval still hard-codes `type: "EXPENSE"`
    (`src/lib/data/staged-approval.ts:65,147`).
- **U3 Proven:** R15.
- **U4 Refuted.** Afford's history reads `loadPeriodIncome(…, "estimate")`
  (`src/lib/data/afford.ts:224`), which counts ledger deposits as well as
  snapshots. In the recompute database, 09-A has no check-in and a hand-typed
  60,000 DOP salary; its estimate is 1,500 USD (60,000 DOP + 500 USD), which my
  independent script matches. A skipped period whose pay is not in the ledger
  reads 0, which is true to the data.
- **U5 Refuted.** A biweekly series always falls on the same weekday, so a
  weekend shift moves every charge alike. Fridays Aug 21, Sep 4 and Sep 18 are
  detected as BIWEEKLY and post on Fridays Oct 2, 16, 30 and Nov 13
  (`rp/u56.ts`).
- **U6 Proven at the server layer:** R30.
- **U7 Proven:** R21.
- **U8 Proven:** R20.
- **U9,** traced from render to computation:

  | Item | Verdict | Where / why |
  |---|---|---|
  | `basisLastBudget` | **true** | It labels the *scaled* suggestion (`step-flexible.tsx:27-30,60`) |
  | `accountBelowBuffer` | **true** | "Would fall short by X" is measured against the buffer, not zero (`payday.ts:480-487`) |
  | `goalFundingShortfall` | **true** | "Only X to spare across your accounts" is what is left after earlier goals (`planGoalFunding`) |
  | `step1BalanceMeaning` with CSV pay | **accurate** | The ledger date is the day before the CSV pay landed. But see R1: Step 2 then double-records it |
  | "before next payday" lists | **true** | They are the whole plan period's occurrences (`committedDrafts`), including items due on or after the payday |
  | `confirmBudgetsNote` | **true** | It counts every essential and flexible category row, touched or not (`payday-checkin-dialog.tsx:244`) |
  | `itemsDueBefore` / `recurringStillToCome` | **true** | Both count `byItem` groups, so a weekly item with three charges counts once (`period-summary.ts:256`) |
  | `fromAffordDescription` | **partly true** | It counts active plans whatever their account's status (`recurring/page.tsx:65`). Whether archived-account plans are re-checked was not traced |
  | `monthlySavingsHint` | **true** | Active CONTRIBUTION items that did not post add their scheduled amount with no skip check (`monthly.ts:231-245,700-706`), so goal-achieved or archived-account items are counted |
  | "Total cash outflow" under "Based on the last N months" | **partly true** | It averages the same months, but includes those scheduled (not actual) amounts |

## Checks that pass on wrong code

1. **`scripts/verify-domain.ts:12648-12657`, "moved Mon Sep 28, the day a salary landed before the payday".**
   - The fixture is a CSV INCOME row with the note "PAYROLL".
   - `loadPayLanded` never reads the note or the amount. A 25 USD refund passes
     exactly the same way, which is what R4 exploits.
   - No check uses a non-salary deposit in the lead window.
2. **`scripts/verify-no-double-counting.ts` pair 4.**
   - It runs the app's own `findPostedDuplicates`, deliberately not
     re-implementing it, so it inherits that function's same-account and
     period-end window limits.
   - "Settled and posted" compares the same occurrence key only.
   - On `cadence_review_repro` holding R5's orphan (settled 10-05 plus posted
     10-06) and R2's Oct 16 duplicate, it printed "clean: no double-counted or
     dropped commitment found" and exited 0 (`rp/r_auditstate.ts`).
3. **Coverage gap rather than a passing check:**
   - The harness tests a deposit arriving *after* a check-in (lines 5412-5417)
     but never a check-in after the deposit (R1).
   - No check edits a posted row's date (R9), moves a schedule after "It's
     that payment" (R5), or edits a deposit with a past earmark (R13).

## Unproven

- **U1, U2:** need a model run with an API key; see above.
- **Deleting a charge that settled a claimed occurrence drops that occurrence
  for good.** The settlement cascades and `nextDate` has already moved past it.
  This may be intended ("deleting it means it did not happen"), and I did not
  establish what the user expects.
- **Posting racing an "It's that payment" answer on the due date.**
  `recordUpcomingPayment` takes no lock on the item. This needs two concurrent
  requests.
- **A second tab confirming a check-in overwrites the first.** The lock only
  compares `updatedAt` read within one request. Not run.
- **Concurrent `saveEarmarks` for two deposits can each cover an occurrence in
  full.** Reads are bounded, so only R23 grows. Not run.
- **A goal whose currency changed can be skipped by posting's live check while
  `markGoalsReachedByDate` (cached total) never marks it.** This needs a rate
  move. Not run.
- **Afford treats an open period with a confirmed check-in as complete
  income,** missing a later regular deposit. Not run.
- **Not money:** `markGoalsReachedByDate` rebuilds, with a lock and a write,
  every goal held at its target only by future-dated rows, on every request.
