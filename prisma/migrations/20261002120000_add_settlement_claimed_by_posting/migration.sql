-- When posting claimed the occurrence a RecurringSettlement pairs (rolled
-- the item past it and counted it against an installment plan). Null for a
-- pairing the user recorded ahead ("It's that payment") that posting has not
-- claimed yet. Additive and nullable.
ALTER TABLE "RecurringSettlement" ADD COLUMN "claimedByPostingAt" TIMESTAMP(3);

-- Existing rows: a row created on or after its due date was written by
-- posting's claim (posting never writes one before the occurrence falls due).
UPDATE "RecurringSettlement" SET "claimedByPostingAt" = "createdAt" WHERE "createdAt" >= "dueDate";
