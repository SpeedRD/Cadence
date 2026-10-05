# Overnight progress

Checklist for the unattended job on branch fix/round2-conversion. One line per
item: pending / done / skipped, plus one sentence. No real figures here.

- 1. Form errors visible on phones: done - FormDialog scrolls its error line above the sticky footer below sm (pure revealScrollDelta, harness checks; Chromium 375/430 en/es, iPhone Simulator real taps, desktop and iPad unchanged).
- 2a. S9 yearly item counted twice in the monthly pace: done - a completed month reads an active yearly item at amount/12 every month, never the charge.
- 2b. S10 occurrence paid by a charge in the previous month counted twice: done - posted or settled occurrences count in their due-date month (completed and current month).
- 2c. S11 back-posted RECURRING rows setting first activity: done - a RECURRING row created more than 7 days after its date no longer opens the history.
- 3a. Delete QUANTITIES_MAP.md and its doc references: done - file removed, AGENTS.md references dropped (README and DEPLOY had none); source comments left as asked.
- 3b. README rewrite (USD, fictional) and desktop screenshots: pending
- 3c. Stale-rates banner only when the table is unfit: done - shown only when the refresh failed and the table is unfit for the currencies in use (ratesOutOfDateFor); harness, Chromium 375/1280 en/es, Simulator.
- 3d. Stale documentation (AGENTS.md audit line, RecurringSettlement comment, others): pending
- 4. Scrub real figures from tracked files: pending
- 5a. Unproven items of REVIEW_FINDINGS_2.md: pending
- 5b. "May repeat" hint in the Inbox suggestion: pending
- 6a. Read-only production connection: pending
- 6b. Local throwaway copy: pending
- 6c. Checks on the copy (audit, recomputation, anchors, posting rehearsal, check-in rehearsal, data counts): pending
- 6d. Report outside the repo: pending
- 6e. Cleanup and final search of changed files: pending
