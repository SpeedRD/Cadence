-- AlterTable
ALTER TABLE "GoalContribution" ADD COLUMN     "recurringItemId" TEXT;

-- CreateIndex
CREATE INDEX "GoalContribution_recurringItemId_idx" ON "GoalContribution"("recurringItemId");

-- AddForeignKey
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_recurringItemId_fkey" FOREIGN KEY ("recurringItemId") REFERENCES "RecurringItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
