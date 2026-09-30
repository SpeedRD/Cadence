-- Amounts stored in the account's currency (QUANTITIES_MAP.md K7): a row
-- entered in another currency keeps what was entered and the rate it was
-- converted at. Additive and nullable: every existing row reads as entered in
-- its own currency, and nothing existing is rewritten here - rows whose
-- currency differs from their account's are converted, if the user chooses,
-- by scripts/backfill-account-currency.ts.
ALTER TABLE "Transaction"
  ADD COLUMN "originalAmount" DECIMAL(14,2),
  ADD COLUMN "originalCurrency" TEXT,
  ADD COLUMN "rate" DECIMAL(20,10);

-- The three describe one conversion: all set or all null.
ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_original_complete"
  CHECK (
    ("originalAmount" IS NULL) = ("originalCurrency" IS NULL)
    AND ("originalCurrency" IS NULL) = ("rate" IS NULL)
  );
