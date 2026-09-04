-- Pairs an auto-posted GoalContribution with the Transaction posted alongside
-- it, by the same "<itemId>:<YYYY-MM-DD>" key Transaction.externalId uses.
--
-- recurringItemId cannot do this job: its foreign key is ON DELETE SET NULL, so
-- deleting a RecurringItem silently turns every contribution it posted into a
-- "manually logged" one, which then gets counted a second time alongside the
-- Transaction that is still in the ledger. A plain string column survives the
-- delete, so the pairing survives with it.
ALTER TABLE "GoalContribution" ADD COLUMN "recurringExternalId" TEXT;

-- Backfill the rows whose link is still intact. Rows already orphaned by a
-- deleted item cannot be recovered - there is nothing left to point at.
UPDATE "GoalContribution"
SET "recurringExternalId" = "recurringItemId" || ':' || to_char("date", 'YYYY-MM-DD')
WHERE "recurringItemId" IS NOT NULL;

CREATE INDEX "GoalContribution_recurringExternalId_idx"
  ON "GoalContribution"("recurringExternalId");
