-- The one-off part of a check-in paycheck (see
-- PaydayAccountSnapshot.oneOffIncome in prisma/schema.prisma): the period's
-- income, left out of the income estimate. Nullable, no default: every
-- existing snapshot reads as no one-off part, so nothing changes for them.
ALTER TABLE "PaydayAccountSnapshot" ADD COLUMN "oneOffIncome" DECIMAL(14,2);
