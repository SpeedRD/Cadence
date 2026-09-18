-- Shared expenses (see Transaction.yourShare / .reimbursesTransactionId in
-- prisma/schema.prisma and src/lib/shared-expense.ts).
--
-- yourShare: on an EXPENSE, the part of the amount that was the user's own
-- cost when the purchase covered other people. Null - what every existing row
-- gets - means the whole amount is the user's, which changes nothing.
--
-- reimbursesTransactionId: on an INCOME row, the shared expense the deposit
-- pays back. One expense may be reimbursed by many deposits over time, so this
-- is a plain many-to-one self-reference, not a paired link like transferId.
-- ON DELETE SET NULL: deleting the expense leaves its deposits as ordinary
-- income rather than removing real ledger rows.
ALTER TABLE "Transaction" ADD COLUMN     "reimbursesTransactionId" TEXT,
ADD COLUMN     "yourShare" DECIMAL(14,2);

CREATE INDEX "Transaction_reimbursesTransactionId_idx" ON "Transaction"("reimbursesTransactionId");

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_reimbursesTransactionId_fkey" FOREIGN KEY ("reimbursesTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
