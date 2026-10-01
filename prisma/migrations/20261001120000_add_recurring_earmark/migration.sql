-- Recurring earmarks (see RecurringEarmark in prisma/schema.prisma and
-- src/lib/earmarks.ts): part of a deposit - an INCOME row or an incoming
-- external transfer - the user set aside for one occurrence of a recurring
-- item, so that occurrence asks that much less of the plan.
--
-- Additive: a new, empty table. No existing row is read or rewritten.
-- Deleting the deposit removes its earmarks (CASCADE); deleting the recurring
-- item keeps them, with the occurrence key naming it. A deposit holds at most
-- one earmark per occurrence; the bounds across rows (never more than the
-- deposit or the occurrence holds) are the writer's, checked again on read.
-- CreateTable
CREATE TABLE "RecurringEarmark" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "recurringItemId" TEXT,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringEarmark_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecurringEarmark_amount_positive" CHECK ("amount" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringEarmark_transactionId_occurrenceKey_key" ON "RecurringEarmark"("transactionId", "occurrenceKey");

-- CreateIndex
CREATE INDEX "RecurringEarmark_occurrenceKey_idx" ON "RecurringEarmark"("occurrenceKey");

-- CreateIndex
CREATE INDEX "RecurringEarmark_recurringItemId_idx" ON "RecurringEarmark"("recurringItemId");

-- CreateIndex
CREATE INDEX "RecurringEarmark_dueDate_idx" ON "RecurringEarmark"("dueDate");

-- AddForeignKey
ALTER TABLE "RecurringEarmark" ADD CONSTRAINT "RecurringEarmark_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringEarmark" ADD CONSTRAINT "RecurringEarmark_recurringItemId_fkey" FOREIGN KEY ("recurringItemId") REFERENCES "RecurringItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
