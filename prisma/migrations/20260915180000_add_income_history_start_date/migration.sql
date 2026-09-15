-- "Count income history from": a civil date below which no comparable pay
-- period is counted by Afford's income projection or the payday planner's
-- category-spending averages (see Settings.incomeHistoryStartDate in
-- prisma/schema.prisma). Null - what every existing row gets - is no boundary,
-- so nothing changes for anyone until the date is set on the Settings page.
ALTER TABLE "Settings" ADD COLUMN "incomeHistoryStartDate" DATE;
