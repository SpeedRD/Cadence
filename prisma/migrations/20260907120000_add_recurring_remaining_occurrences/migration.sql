-- Countdown for a finite recurring item - an installment plan recorded by the
-- Afford calculator. Null means unbounded, which is what every existing row
-- gets: nothing changes for them. postDueRecurringItems (see
-- src/lib/recurring-posting.ts) decrements it per posted occurrence and
-- deactivates the item in the same write once it reaches 0.
ALTER TABLE "RecurringItem" ADD COLUMN "remainingOccurrences" INTEGER;
