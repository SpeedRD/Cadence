-- A one-off receipt the user marked on an income row (see
-- Transaction.isOneOffIncome in prisma/schema.prisma). Left out of Afford's
-- income history only; it still counts everywhere income is a fact. false -
-- what every existing row gets - changes nothing.
ALTER TABLE "Transaction" ADD COLUMN "isOneOffIncome" BOOLEAN NOT NULL DEFAULT false;
