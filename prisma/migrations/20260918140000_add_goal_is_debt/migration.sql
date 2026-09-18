-- Goals the user has marked as debts, for the Goals page's debt payoff
-- comparator (see Goal.isDebt in prisma/schema.prisma and
-- src/lib/debt-payoff.ts). An explicit marking on the goal form, never
-- inferred, so every existing goal starts unmarked.
-- AlterTable
ALTER TABLE "Goal" ADD COLUMN "isDebt" BOOLEAN NOT NULL DEFAULT false;
