-- The part of a check-in paycheck (incomeEntered) the ledger already held
-- when it was confirmed: deposits on the account in the period's income
-- window (a CSV import, an approved receipt, a manual entry). The check-in
-- adopts them as they are and records only the rest as its own INCOME row.
-- Null on snapshots written before this, read as 0. Additive and nullable.
ALTER TABLE "PaydayAccountSnapshot" ADD COLUMN "adoptedIncome" DECIMAL(14,2);
