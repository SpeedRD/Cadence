# Deploying production to Supabase

Cadence was built against a local Postgres instance at `127.0.0.1:5432`. This
covers moving the **production** database to an existing Supabase project.
Local development is unaffected — keep using your local `DATABASE_URL` in
`.env`.

Supabase gives you two connection strings (Project Settings → Database →
Connection string):

- **Transaction pooler** (port `6543`, `?pgbouncer=true`) → `DATABASE_URL`,
  used by the deployed app at runtime.
- **Session pooler** (port `5432`) → `DIRECT_URL`, used by the Prisma CLI for
  migrations/seeding, which need a session-capable connection the transaction
  pooler doesn't support for DDL.

**Migrations must go through the session pooler, never the transaction
pooler.** `prisma migrate deploy` takes a session-level advisory lock and runs
DDL; against the transaction-mode pooler (port `6543`, `?pgbouncer=true`) it
does not fail cleanly, it hangs. If a migration run sits there doing nothing,
check that `DIRECT_URL` is the port `5432` string before anything else.

## 1. Create a local, private `.env.supabase`

This file is for running migrations against Supabase from your machine. It's
covered by `.env*` in `.gitignore`, so it will not be committed.

```bash
cat > .env.supabase <<'EOF'
DATABASE_URL="postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres"
EOF
```

Replace both placeholder values with the real connection strings from your
Supabase project. Never commit this file or paste its contents anywhere.

## 2. Load it into your shell

```bash
set -a
source .env.supabase
set +a
```

`set -a` exports every variable `source` sets, so the commands below (and the
Prisma CLI, via `prisma7.config.ts`) can see `DATABASE_URL`/`DIRECT_URL`
without editing any file.

## 3. Apply existing migrations to Supabase

```bash
npm run db:migrate
```

This runs `prisma migrate deploy`, which — via `prisma7.config.ts` — connects
using `DIRECT_URL` (falling back to `DATABASE_URL` only if `DIRECT_URL` is
unset). It applies the migrations already in `prisma/migrations/` as-is; it
does not generate new ones.

## 4. Seed the fresh database

```bash
npm run db:seed
```

Runs `prisma/seed.ts` (also via `DIRECT_URL`) to insert the default categories
and the `Settings` singleton. Idempotent — safe to re-run.

## 5. Confirm the database is reachable

```bash
npx prisma migrate status
```

This connects with the same CLI datasource (`DIRECT_URL`) and reports applied
migrations without changing anything — a quick way to confirm Supabase is
reachable and up to date before moving on.

When you're done, unset the loaded variables so your shell falls back to your
local `.env` for `npm run dev`:

```bash
unset DATABASE_URL DIRECT_URL
```

## 6. Configure Vercel production variables

In the Vercel project → Settings → Environment Variables (Production), set:

- `DATABASE_URL` — the Supabase transaction pooler string (port `6543`, `?pgbouncer=true`)
- `DIRECT_URL` — the Supabase session pooler string (port `5432`)
- `APP_TIMEZONE` — `America/Santo_Domingo`
- `RECOVERY_SECRET` — optional; enables "Forgot your PIN?" on the unlock screen (`openssl rand -hex 32`, kept in a password manager). Without it a forgotten PIN can only be reset by nulling `Settings.pinHash` in the database.
- `SESSION_SECRET`, `OAUTH_ENCRYPTION_KEY`, `CRON_SECRET` — existing values, or generate new ones (see [PHASE2.md](./PHASE2.md)). `CRON_SECRET` gates both cron routes in `vercel.json`: `/api/cron/ingest` (email sync, daily 04:00 UTC) and `/api/cron/recurring` (posts due recurring items, daily 04:15 UTC). Without it neither cron does anything.
- `APP_URL` — the canonical production origin, e.g. `https://cadence.vercel.app` or your custom domain (no trailing slash). Required for Gmail OAuth to work in production — see [PHASE2.md](./PHASE2.md).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `ANTHROPIC_API_KEY`

None of these should carry a `NEXT_PUBLIC_` prefix — they're all server-only.

## 7. Redeploy

Changing environment variables in Vercel does not affect a deployment already
running — it only takes effect on the next build. Trigger one:

```bash
vercel --prod
```

or push a commit, or use **Deployments → Redeploy** in the dashboard.

## 8. Verify

Open the production URL's `/login` page and confirm it loads (no more Prisma
`P1001`), then sign in / set a PIN to confirm reads and writes both work
against Supabase.

## Applying a new migration later

The Vercel build runs `prisma generate && next build` only — it never applies
migrations. Every time `prisma/migrations/` gains a folder, apply it to
Supabase yourself **before** the code that depends on it goes live, using the
same session-pooler connection as step 3:

```bash
set -a; source .env.supabase; set +a
npx prisma migrate status      # shows the pending migration(s)
npm run db:migrate             # prisma migrate deploy via DIRECT_URL
npx prisma migrate status      # should now report "Database schema is up to date"
unset DATABASE_URL DIRECT_URL
```

Then deploy (push, or `vercel --prod`). If `db:migrate` hangs instead of
finishing in a few seconds, `DIRECT_URL` is pointing at the transaction pooler
- see the note at the top of this file.

Order matters in the other direction too: deploying code that reads a column
its migration has not created yet takes the whole app down with a Prisma
error, so migrate first, deploy second.
