-- An account may hold at most one OPENING_BALANCE transaction. A plain
-- composite UNIQUE cannot express that (every other type may repeat on an
-- account), so a partial index does the job - the same shape as
-- "Budget_overall_period_key" in the initial migration.

-- Collapse any duplicates the unguarded find-then-create in setOpeningBalance
-- could already have written, keeping the most recent row per account (the
-- same "last write wins" the replace path has always had).
DELETE FROM "Transaction" older
USING "Transaction" newer
WHERE older."type" = 'OPENING_BALANCE'
  AND newer."type" = 'OPENING_BALANCE'
  AND newer."accountId" = older."accountId"
  AND (newer."createdAt", newer."id") > (older."createdAt", older."id");

CREATE UNIQUE INDEX "Transaction_account_opening_balance_key"
  ON "Transaction"("accountId") WHERE "type" = 'OPENING_BALANCE';
