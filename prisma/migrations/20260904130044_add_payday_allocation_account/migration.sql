-- AlterTable
ALTER TABLE "PaydayPlanAllocation" ADD COLUMN     "accountId" TEXT;

-- CreateIndex
CREATE INDEX "PaydayPlanAllocation_accountId_idx" ON "PaydayPlanAllocation"("accountId");

-- AddForeignKey
ALTER TABLE "PaydayPlanAllocation" ADD CONSTRAINT "PaydayPlanAllocation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
