-- Twice-a-month recurring items: a second independent due day alongside
-- anchorDay, and the SEMI_MONTHLY frequency that uses it (see
-- RecurringFrequency and RecurringItem.secondAnchorDay in
-- prisma/schema.prisma, and advanceDate() in src/lib/recurring.ts). No data
-- migration needed - nothing existing uses either.
-- AlterEnum
ALTER TYPE "RecurringFrequency" ADD VALUE 'SEMI_MONTHLY';

-- AlterTable
ALTER TABLE "RecurringItem" ADD COLUMN "secondAnchorDay" INTEGER;
