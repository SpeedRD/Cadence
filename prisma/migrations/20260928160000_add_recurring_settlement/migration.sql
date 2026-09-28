-- Recurring settlements (see RecurringSettlement in prisma/schema.prisma and
-- src/lib/recurring-settlement.ts): one row per charge the user entered
-- (manual, CSV, approved receipt) that recurring posting took as one
-- occurrence already paid, instead of writing a RECURRING row for it.
-- Before this table the pairing lived for one posting run only, so the same
-- charge could settle several occurrences (and several look-alike items).
--
-- Additive: a new, empty table. No existing row is read or rewritten; the
-- pairing applies to occurrences claimed from now on. Both unique keys are
-- the rule itself - a charge settles at most one occurrence, an occurrence is
-- settled at most once. Deleting the charge removes its row (CASCADE);
-- deleting the recurring item keeps it, with the occurrence key naming it.
-- CreateTable
CREATE TABLE "RecurringSettlement" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "recurringItemId" TEXT,
    "kind" "RecurringKind" NOT NULL,
    "dueDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurringSettlement_transactionId_key" ON "RecurringSettlement"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringSettlement_occurrenceKey_key" ON "RecurringSettlement"("occurrenceKey");

-- CreateIndex
CREATE INDEX "RecurringSettlement_recurringItemId_idx" ON "RecurringSettlement"("recurringItemId");

-- AddForeignKey
ALTER TABLE "RecurringSettlement" ADD CONSTRAINT "RecurringSettlement_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringSettlement" ADD CONSTRAINT "RecurringSettlement_recurringItemId_fkey" FOREIGN KEY ("recurringItemId") REFERENCES "RecurringItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

