-- A manually logged GoalContribution now moves real money: it is written
-- alongside an EXPENSE Transaction from a chosen account (see
-- logManualContribution in src/lib/goals.ts), and this column records which.
--
-- Nullable, and deliberately not backfilled: rows logged before this change
-- never had a source account, so there is nothing true to write into them.
-- Auto-posted rows also stay null - their account is the RecurringItem's.
-- AlterTable
ALTER TABLE "GoalContribution" ADD COLUMN     "accountId" TEXT;

-- CreateIndex
CREATE INDEX "GoalContribution_accountId_idx" ON "GoalContribution"("accountId");

-- AddForeignKey
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
