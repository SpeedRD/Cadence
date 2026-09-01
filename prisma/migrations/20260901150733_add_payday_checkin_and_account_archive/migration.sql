-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PaydayCheckinStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "PaydayAllocationType" AS ENUM ('SUBSCRIPTION', 'RECURRING_CONTRIBUTION', 'GOAL', 'ESSENTIAL_CATEGORY', 'FLEXIBLE_CATEGORY', 'BUFFER', 'CARRYOVER');

-- AlterEnum
ALTER TYPE "TransactionSource" ADD VALUE 'PAYDAY_CHECKIN';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "isEssentialFixed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "bufferFloorAmount" DECIMAL(14,2) NOT NULL DEFAULT 2000,
ADD COLUMN     "bufferFloorCurrency" TEXT NOT NULL DEFAULT 'DOP',
ADD COLUMN     "bufferPercent" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "carryoverIncludedByDefault" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "checkinPromptDismissedOn" DATE;

-- CreateTable
CREATE TABLE "PaydayCheckin" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "period" "PayPeriod" NOT NULL,
    "checkinDate" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "totalIncome" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "includedCarryover" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "protectedBuffer" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "PaydayCheckinStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaydayCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaydayAccountSnapshot" (
    "id" TEXT NOT NULL,
    "paydayCheckinId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "expectedLedgerBalance" DECIMAL(14,2) NOT NULL,
    "reportedBalance" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,
    "incomeEntered" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "incomeNote" TEXT,
    "incomeTransactionId" TEXT,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaydayAccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaydayPlanAllocation" (
    "id" TEXT NOT NULL,
    "paydayCheckinId" TEXT NOT NULL,
    "type" "PaydayAllocationType" NOT NULL,
    "categoryId" TEXT,
    "goalId" TEXT,
    "recurringItemId" TEXT,
    "recommendedAmount" DECIMAL(14,2) NOT NULL,
    "plannedAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "basis" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaydayPlanAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaydayCheckin_status_idx" ON "PaydayCheckin"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaydayCheckin_year_month_period_key" ON "PaydayCheckin"("year", "month", "period");

-- CreateIndex
CREATE UNIQUE INDEX "PaydayAccountSnapshot_incomeTransactionId_key" ON "PaydayAccountSnapshot"("incomeTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaydayAccountSnapshot_paydayCheckinId_accountId_key" ON "PaydayAccountSnapshot"("paydayCheckinId", "accountId");

-- CreateIndex
CREATE INDEX "PaydayPlanAllocation_paydayCheckinId_type_idx" ON "PaydayPlanAllocation"("paydayCheckinId", "type");

-- CreateIndex
CREATE INDEX "Account_status_name_idx" ON "Account"("status", "name");

-- AddForeignKey
ALTER TABLE "PaydayAccountSnapshot" ADD CONSTRAINT "PaydayAccountSnapshot_paydayCheckinId_fkey" FOREIGN KEY ("paydayCheckinId") REFERENCES "PaydayCheckin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaydayAccountSnapshot" ADD CONSTRAINT "PaydayAccountSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaydayPlanAllocation" ADD CONSTRAINT "PaydayPlanAllocation_paydayCheckinId_fkey" FOREIGN KEY ("paydayCheckinId") REFERENCES "PaydayCheckin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaydayPlanAllocation" ADD CONSTRAINT "PaydayPlanAllocation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaydayPlanAllocation" ADD CONSTRAINT "PaydayPlanAllocation_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaydayPlanAllocation" ADD CONSTRAINT "PaydayPlanAllocation_recurringItemId_fkey" FOREIGN KEY ("recurringItemId") REFERENCES "RecurringItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
