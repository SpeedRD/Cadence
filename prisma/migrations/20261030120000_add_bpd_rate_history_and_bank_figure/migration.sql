-- Banco Popular's publications, one row per BuySellRatesAsOf, with buy and
-- sell rates for the dollar and the euro in DOP (buy nullable: the backfill
-- from the scraper's logs has the sell rates only). A new table; nothing
-- reads it yet.
CREATE TABLE "BpdRatePublication" (
    "id" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "dollarBuyRate" DECIMAL(20,10),
    "dollarSellRate" DECIMAL(20,10) NOT NULL,
    "euroBuyRate" DECIMAL(20,10),
    "euroSellRate" DECIMAL(20,10) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BpdRatePublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BpdRatePublication_asOf_key" ON "BpdRatePublication"("asOf");

-- Whether a Transaction's amount is the bank's own figure in the account's
-- currency. Additive, with a default, so the code before this deploy keeps
-- writing rows as it does. Every row stored so far with an original amount
-- holds the bank's figure (confirmed by the owner, 2026-10-30), so those are
-- marked; rows written by the old code between this migration and the deploy
-- keep the default.
ALTER TABLE "Transaction" ADD COLUMN "isBankFigure" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Transaction" SET "isBankFigure" = true WHERE "originalAmount" IS NOT NULL;
