# Overnight progress

Checklist for the unattended job on branch fix/round2-conversion. One line per
item: pending / done / skipped, plus one sentence. No real figures here.

- 1. Form errors visible on phones: done - FormDialog scrolls its error line above the sticky footer below sm (pure revealScrollDelta, harness checks; Chromium 375/430 en/es, iPhone Simulator real taps, desktop and iPad unchanged).
- 2a. S9 yearly item counted twice in the monthly pace: done - a completed month reads an active yearly item at amount/12 every month, never the charge.
- 2b. S10 occurrence paid by a charge in the previous month counted twice: done - posted or settled occurrences count in their due-date month (completed and current month).
- 2c. S11 back-posted RECURRING rows setting first activity: done - a RECURRING row created more than 7 days after its date no longer opens the history.
- 3a. Delete QUANTITIES_MAP.md and its doc references: done - file removed, AGENTS.md references dropped (README and DEPLOY had none); source comments left as asked.
- 3b. README rewrite (USD, fictional) and desktop screenshots: done - README rewritten for the current app in USD; all 27 desktop screenshots recaptured from a throwaway fictional seed at 1440 wide, dark, English, quantized.
- 3c. Stale-rates banner only when the table is unfit: done - shown only when the refresh failed and the table is unfit for the currencies in use (ratesOutOfDateFor); harness, Chromium 375/1280 en/es, Simulator.
- 3d. Stale documentation (AGENTS.md audit line, RecurringSettlement comment, others): done - audit line, RecurringSettlement and claimedByPostingAt comments, remainingOccurrences comment, AGENTS.md settlement writers corrected; README lines handled in 3b.
- 4. Scrub real figures from tracked files: done - listed figures, the goal name and the Part 6 anchor amounts replaced with a consistent fictional mapping in the findings docs and the harness (same check count before and after); none left in the tree.
- 5a. Unproven items of REVIEW_FINDINGS_2.md: done - four reproduced and fixed (staged approval, off-schedule pairing, bank-rate window, one-off median), one comment corrected, one measured as by design, one reproduced but left as the cleanup list decided; status lines added.
- 5b. "May repeat" hint in the Inbox suggestion: done - the Inbox row carries the card's hint (en/es, hint style), checked in Chromium, on the iPhone and iPad Simulators; the review page now judges each account separately (found while checking U1).
- 6a. Read-only production connection: done - session pooler with the pinned root CA, SET plus BEGIN READ ONLY confirmed and a test write refused.
- 6b. Local throwaway copy: done - pg_dump 16 refuses the 17 server, so every table was read with COPY TO inside the read-only session and loaded into cadence_prod_copy.
- 6c. Checks on the copy (audit, recomputation, anchors, posting rehearsal, check-in rehearsal, data counts): done - audit clean, readers match the independent recomputation, every anchor matches.
- 6d. Report outside the repo: done - written to the home directory, not in git.
- 6e. Cleanup and final search of changed files: done - copies dropped, exported files deleted, one comment amount replaced.
