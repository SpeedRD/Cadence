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
- `SESSION_SECRET`, `OAUTH_ENCRYPTION_KEY`, `CRON_SECRET` — existing values, or generate new ones (see [PHASE2.md](./PHASE2.md))
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
