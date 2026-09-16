-- Distinguishes the open.er-api.com rate table (unaffected: source defaults
-- to "open-er-api" so every existing row keeps its meaning) from Banco
-- Popular Dominicano's published DOP/EUR rate ("bpd"), which is fresh for a
-- calendar day (asOf) rather than a rolling TTL from fetchedAt - see
-- src/lib/bpd-rates.ts. asOf is null for open.er-api.com rows.
-- AlterTable
ALTER TABLE "ExchangeRate" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'open-er-api',
ADD COLUMN     "asOf" TIMESTAMP(3);

-- DropIndex
DROP INDEX "ExchangeRate_baseCurrency_targetCurrency_key";

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_baseCurrency_targetCurrency_source_key" ON "ExchangeRate"("baseCurrency", "targetCurrency", "source");
