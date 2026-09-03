-- AlterEnum
ALTER TYPE "TransactionSource" ADD VALUE 'RECURRING';

-- AlterTable
ALTER TABLE "RecurringItem" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "goalId" TEXT;

-- CreateIndex
CREATE INDEX "RecurringItem_accountId_idx" ON "RecurringItem"("accountId");

-- CreateIndex
CREATE INDEX "RecurringItem_goalId_idx" ON "RecurringItem"("goalId");

-- AddForeignKey
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringItem" ADD CONSTRAINT "RecurringItem_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
