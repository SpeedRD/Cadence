-- The day of the month a recurring item is really due on, so that clamping an
-- occurrence into a short month never compounds into every later occurrence
-- (see advanceDate in src/lib/recurring.ts).
ALTER TABLE "RecurringItem" ADD COLUMN "anchorDay" INTEGER;

-- Backfill from each row's current nextDate. An item that has already drifted
-- into a short month keeps the day it sits on today - its original day is not
-- recoverable from the data - but it can never drift any further from here.
UPDATE "RecurringItem" SET "anchorDay" = EXTRACT(DAY FROM "nextDate")::integer;
