-- Marks a recurring item the Afford calculator recorded ("I bought this"), so
-- the Recurring page can list it apart from hand-entered subscriptions and
-- re-check it against current projections. Every existing row gets false:
-- nothing that exists today was written by Afford in a way this can tell
-- apart from a hand-entered plan, and the recurring form never sets it.
ALTER TABLE "RecurringItem" ADD COLUMN "fromAfford" BOOLEAN NOT NULL DEFAULT false;
