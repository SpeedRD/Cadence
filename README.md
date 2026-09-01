# Cadence

A single-user personal finance app built around a twice-monthly pay rhythm. Every
month is two budgeting periods — **A: 1st–15th** and **B: 16th–end of month** — and
budgets, "safe to spend" and goal roadmaps are all computed per period rather than
per calendar month.

Next.js (App Router) · TypeScript strict · Tailwind + shadcn/ui · Prisma 7 + PostgreSQL.

## Setup

Requires Node 20.19+ and a PostgreSQL database (Supabase works — use the direct or
session-pooler connection string).

```bash
npm install                 # runs `prisma generate` afterwards
cp .env.example .env        # then fill in DATABASE_URL and SESSION_SECRET
npm run db:migrate          # applies prisma/migrations to the database
npm run db:seed             # inserts the default categories
npm run dev
```

Open http://localhost:3000, choose a 4–6 digit PIN on first run, and the app is
ready to use.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. Read by both Next.js and the Prisma CLI from `.env`. |
| `SESSION_SECRET` | yes in production | HMAC key for the session cookie. `openssl rand -hex 32`. Changing it signs everyone out. |
| `APP_TIMEZONE` | no | IANA timezone used to decide what "today" is when resolving pay periods. Defaults to `UTC`. |

Phase 2A (email ingestion) needs several more - see [PHASE2.md](./PHASE2.md).

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Seeds the default categories (idempotent) |
| `npm run db:studio` | Prisma Studio |

`scripts/verify-domain.ts` exercises the domain rules end to end (pay-period maths,
safe to spend, transfers, currency conversion, CSV parsing, goal caching, the budget
uniqueness rules). It writes and then deletes rows, so point it at a scratch database:

```bash
DATABASE_URL="postgres://…/scratch" npx tsx scripts/verify-domain.ts
```

## Deploying to Vercel

Import the repo, set `DATABASE_URL` and `SESSION_SECRET` in project settings, and
deploy — no custom server or build-command changes needed (`npm run build` already
runs `prisma generate`). Run `npm run db:migrate` against the production database
once before the first deploy.

## How it works

**Auth.** A `Settings` singleton stores a bcrypt hash of the PIN. Signing in sets an
httpOnly, signed session cookie. `src/proxy.ts` (Next 16's renamed middleware) blocks
every route except `/login`, and each protected page and server action calls
`requireAuth()` as well.

**Pay periods.** `src/lib/period.ts` maps any date to its period with that month's real
start and end dates (28/29/30/31), and provides days-remaining, period arithmetic and
period series used by budgets, goals and reports.

**Safe to spend.**

```
committedOutflows = active recurring items (subscriptions + contributions)
                    with nextDate between today and the end of the period
safeToSpend       = periodBudget − spentSoFar − committedOutflows
perDay            = max(0, safeToSpend / daysRemainingInPeriod)
```

`periodBudget` is the overall budget for the period, falling back to the sum of the
category budgets when no overall budget is set. `spentSoFar` counts expense rows only.
Once a recurring item's date passes it is rolled forward to its next occurrence (no
transaction is created), which is what stops a past due date from being counted as
still committed.

**Transfers** are two linked `Transaction` rows — a debit on the source account and a
credit on the destination — written in one database transaction and sharing a
`transferId`. They are excluded from income, expenses, budgets and safe-to-spend, and
only move account balances. Deleting either side removes both.

**Currency.** USD-based rates from `open.er-api.com` are cached in `ExchangeRate` for
24 hours. Cross rates are derived through USD (`amount / rate[from] * rate[to]`), so a
pair like EUR→DOP works without a stored EUR→DOP rate. If the rate service is
unreachable the last known rates are used and flagged as stale on the Settings page.

**Budgets** are keyed to `(year, month, period, categoryId)`, where a null `categoryId`
is the overall budget for that period.

**Goals.** `GoalContribution` rows are the source of truth; `Goal.savedAmount` is a
cached total rebuilt after every write and re-buildable at any time from
Settings → *Recalculate goal totals*.

**Email ingestion (Phase 2A).** Connected Gmail/Outlook mailboxes are polled for
transactional emails, parsed by Claude into `StagedTransaction` rows, and reviewed
on `/review` before becoming real transactions. Full setup and details in
[PHASE2.md](./PHASE2.md).

## Layout

```
prisma/          schema, migrations, seed
src/app/         routes: dashboard, transactions (+ CSV import), review,
                 accounts, budgets, recurring, goals, reports,
                 settings (+ connections), login
                 api/auth/{gmail,outlook}/  OAuth start + callback routes
                 api/cron/ingest/           email ingestion trigger
src/components/  UI: shadcn primitives in ui/, feature components alongside
src/lib/         domain logic (period, currency, rates, csv, auth), plus
                 data/ for read queries, email/ + oauth/ + llm/ for ingestion
src/server/      server actions (all writes)
src/proxy.ts     route protection
vercel.json      Vercel Cron schedule for /api/cron/ingest
```

## Phase 2B and beyond

PayPal API ingestion (using the same `StagedTransaction` review queue and
`(source, externalId)` dedup Phase 2A already exercises), email notifications,
multi-user support, and recurring-item auto-detection from transaction history
(`RecurringItem.detectedFrom`) are not built yet.
