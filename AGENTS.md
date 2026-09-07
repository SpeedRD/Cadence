<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Cadence project notes

- Living docs: `README.md` (features and setup), `DEPLOY.md` (Supabase/Vercel,
  applying migrations through the *session* pooler - the transaction pooler
  hangs on DDL), `PHASE2.md` (email ingestion).
  `docs/superpowers/` is a historical record of past plans and specs, not
  living documentation - do not update it to match the code.
- Tests: `DATABASE_URL="postgres://.../scratch_db" npx tsx scripts/verify-domain.ts`
  is the only test harness. It writes rows and deletes them at the end, so
  point it at a scratch database, never one holding real data. Add checks as
  `check`/`eq` blocks; there is no Jest/Vitest.
- Migrations: `npm run db:migrate` (`prisma migrate deploy`) connects through
  `DIRECT_URL` (`prisma7.config.ts`), which must be session-capable. Local dev
  has only `DATABASE_URL` and falls back to it.
- Recurring items post through exactly one code path,
  `postDueRecurringItems()` in `src/lib/recurring-posting.ts`, called by
  `/api/cron/recurring` and by `getAppContext()` on every request. Do not add
  a second one.
- New `/api/cron/*` routes must be added to `BEARER_AUTH_PATHS` in
  `src/proxy.ts`, or the proxy redirects them to `/login` before the
  handler's bearer check ever runs.
- Screenshots in `screenshots/` are captured from a throwaway database seeded
  with fictional data. Never commit a screenshot taken against real data.
