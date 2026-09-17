-- A recurring-pattern suggestion the user dismissed on the Recurring page
-- (see RecurringSuggestionDismissal in prisma/schema.prisma): the merchant
-- key + account pair is never suggested again. Nothing else changes; the
-- table starts empty.
-- CreateTable
CREATE TABLE "RecurringSuggestionDismissal" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringSuggestionDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringSuggestionDismissal_accountId_merchantKey_key" ON "RecurringSuggestionDismissal"("accountId", "merchantKey");

-- AddForeignKey
ALTER TABLE "RecurringSuggestionDismissal" ADD CONSTRAINT "RecurringSuggestionDismissal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
