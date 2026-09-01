import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Prisma CLI (migrate/seed/studio) needs a session-capable connection for
    // DDL; the transaction-mode pooler on DATABASE_URL doesn't support that.
    // DIRECT_URL is only set in Supabase environments - local dev has just
    // DATABASE_URL and falls back to it.
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
});
