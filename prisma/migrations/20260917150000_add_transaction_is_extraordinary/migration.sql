-- A one-off expense the user confirmed as extraordinary (see
-- Transaction.isExtraordinary in prisma/schema.prisma). Excluded from the
-- payday planner's category-spending averages and Reports' monthly average;
-- false - what every existing row gets - changes nothing.
ALTER TABLE "Transaction" ADD COLUMN "isExtraordinary" BOOLEAN NOT NULL DEFAULT false;
