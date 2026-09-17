-- Transaction.transferId is a bare, unconstrained column - consistency
-- between a transfer's two legs (both rows carrying the same transferId) has
-- always been maintained purely by application code (saveTransferAction
-- writes/updates both legs together, deleteTransactionAction deletes both
-- together). A plain CHECK constraint can't see sibling rows, so this uses a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger, which only evaluates
-- once at COMMIT - after every statement in the writing transaction has
-- already run - so the existing paired writes/deletes (each already done
-- within one Prisma $transaction, or as a single multi-row statement) never
-- see a false-positive mid-transaction violation.
--
-- A transferId is valid at commit time if it resolves to exactly 0 rows (no
-- transfer claims it - covers the ordinary case of an unrelated row, and the
-- moment after both legs of a transfer are deleted together) or exactly 2
-- (a complete pair). Any other count - most importantly 1, an orphaned lone
-- leg - is rejected. This deliberately does not compare the legs' amounts or
-- currencies: the cross-currency transfer override lets them differ.
CREATE FUNCTION transaction_transfer_leg_integrity() RETURNS TRIGGER AS $$
DECLARE
  checked_transfer_id TEXT;
  leg_count INTEGER;
BEGIN
  checked_transfer_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."transferId" ELSE NEW."transferId" END;

  IF checked_transfer_id IS NOT NULL THEN
    SELECT COUNT(*) INTO leg_count FROM "Transaction" WHERE "transferId" = checked_transfer_id;
    IF leg_count NOT IN (0, 2) THEN
      RAISE EXCEPTION 'Transfer integrity violation: transferId % has % legs, expected 2', checked_transfer_id, leg_count;
    END IF;
  END IF;

  -- An UPDATE that moves a row off its old transferId onto a new one (or to
  -- null) can orphan the sibling it left behind - that old id needs its own
  -- check, since the row that used to name it no longer does.
  IF TG_OP = 'UPDATE' AND OLD."transferId" IS NOT NULL AND OLD."transferId" IS DISTINCT FROM NEW."transferId" THEN
    SELECT COUNT(*) INTO leg_count FROM "Transaction" WHERE "transferId" = OLD."transferId";
    IF leg_count NOT IN (0, 2) THEN
      RAISE EXCEPTION 'Transfer integrity violation: transferId % has % legs, expected 2', OLD."transferId", leg_count;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER transaction_transfer_leg_integrity
  AFTER INSERT OR UPDATE OR DELETE ON "Transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION transaction_transfer_leg_integrity();
