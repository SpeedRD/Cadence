-- Which deposits a confirmed check-in's paycheck adopted (the Transaction ids
-- behind PaydayAccountSnapshot.adoptedIncome), so the confirmed plan's income
-- follows those deposits as they are now rather than the figure frozen at
-- confirm. Null on snapshots written before this, read as empty: they keep
-- the paycheck as confirmed. Additive and nullable; no foreign key, since a
-- deleted deposit simply counts 0.
ALTER TABLE "PaydayAccountSnapshot" ADD COLUMN "adoptedTransactionIds" TEXT[];
