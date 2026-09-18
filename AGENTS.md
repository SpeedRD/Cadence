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
- Integrity audit: `DATABASE_URL="postgres://.../any_db" npx tsx scripts/verify-no-double-counting.ts`
  checks real data for the three pairs of mechanisms that could count one
  commitment twice or drop it (goal-contribution twins, SEMI_MONTHLY anchors,
  Afford's goal estimate vs confirmed GOAL rows). Read-only at the database
  level (`default_transaction_read_only=on` on its connection), so it is safe
  against real data. Exit 1 is a finding to investigate, never something to
  fix inside the script; it verifies the mechanisms and must not re-implement
  them.
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
- Banco Popular (`source: "bpd"`) ExchangeRate rows are validated and written
  in exactly one place, `storeBpdRates()` in `src/lib/bpd-rates.ts`, used by
  both the on-demand fetch and the scraper's `/api/cron/bpd-rate/ingest`
  route. The bank's feed blocks every server-side client (Incapsula), so
  the rows in practice come from `scripts/scrape-bpd-rate.ts` run by
  `.github/workflows/scrape-bpd-rate.yml` in a real headed browser; never
  add headers, proxies or fingerprint tweaks to that script - if a genuine
  browser is refused, report it. The pure bounds/parsing live in
  `src/lib/bpd-rate-payload.ts` (database-free, so the script can import
  it).
- Standing signals ("insights") go through one registry,
  `INSIGHT_DETECTORS` in `src/lib/insights.ts`: a detector is a pure
  `(InsightContext) => Insight[]` that re-presents a result the app already
  computes, never a second copy of its detection logic. The Inbox page and
  the nav badge both read the request-cached `getInsights()` in
  `src/lib/data/insights.ts`; dismissals live in `InsightDismissal`
  (source + key), not in per-source tables.
- Screenshots in `screenshots/` are captured from a throwaway database seeded
  with fictional data. Never commit a screenshot taken against real data.
