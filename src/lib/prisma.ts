import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

// The connection string is resolved lazily by node-postgres, so an unset
// DATABASE_URL fails on first query rather than at import time (which would
// break `next build` in environments without database access).
const connectionString = process.env.DATABASE_URL ?? "";

function createPrismaClient() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
