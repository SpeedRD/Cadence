# Cadence

Cadence is a single-user personal finance dashboard built around a twice-monthly pay
cycle instead of the generic calendar month. Budgets, safe-to-spend, and goal
roadmaps are all computed per pay period — **Period A: 1st–15th** and **Period B:
16th–end of month** — so the numbers match how you actually get paid.

## Preview

![Cadence dashboard showing the payday check-in banner, current pay period safe-to-spend, and goals summary](screenshots/Screenshot%202026-09-02%20at%2010.00.52%E2%80%AFAM.png)

## Why Cadence

Most budgeting apps assume one paycheck a month. Cadence assumes two, and builds
everything else around that:

- Twice-monthly budgeting, split cleanly at the 1st–15th and 16th–end boundaries
- A guided payday check-in that plans each period's protected buffer and
  category allocations from income, balances, and commitments
- A safe-to-spend-per-day figure that accounts for budget, spending so far, and
  upcoming committed outflows
- Savings goals with a per-pay-period contribution roadmap, not just a single target
- Multi-currency support (DOP, USD, and EUR as first-class currencies) with cached
  USD-based exchange rates — changing your display currency only changes how
  figures are presented, never the currency a transaction was recorded in
- Manual entry and CSV import as the baseline, with optional Gmail/Outlook
  review-based automation on top
- English and Spanish interface localization
- A single-user, privacy-conscious design — no multi-tenant accounts, no
  auto-posting of anything without review

## Features

**Payday check-in** — A guided, step-by-step planner (income → account balances →
committed outflows → flexible categories → confirm) that runs each payday. It
computes a protected buffer (a configurable percentage of income or a fixed
minimum, whichever is larger), then shows what's left for flexible categories
after subscriptions, recurring contributions, goal contributions, and essential
fixed categories are set aside.

**Pay-period budgeting and safe-to-spend** — Set an overall budget per period, or
let it fall back to the sum of category budgets. Safe-to-spend subtracts what's
already spent and what's still committed (recurring items due before period end),
then divides by days remaining.

**Transactions, transfers, and CSV import** — Manual entry, plus CSV import with
date-format selection for bank exports that don't use ISO dates. Transfers are
linked debit/credit rows that move balances between accounts without counting as
income or expense.

**Accounts and opening balances** — Track balances across checking, savings, cash,
and other account types, each with its own native currency. An opening balance can
be set per account to seed its starting balance before tracked transactions begin.

**Recurring subscriptions and investment contributions** — Track bills and
recurring savings/investment contributions separately; both factor into
safe-to-spend and the payday check-in for the period they fall in.

**Savings goals** — Target amount, optional target date, and a roadmap of what each
pay period needs to carry to hit it.

**Multi-currency** — Every account and transaction is recorded in DOP, USD, or EUR.
Changing the display currency in Settings only changes how figures are presented
everywhere in the app (dashboard, budgets, goals, payday planning); it never
converts or mutates the currency a transaction, account, or goal was recorded in.
Conversions use cached, periodically refreshed USD-based exchange rates.

**Email review queue** — Connect Gmail and/or Outlook to have transactional emails
parsed into a staged queue. Nothing becomes a real transaction until you approve it.

**Reports** — Current-period spending by category, and a six-pay-period trend view.

**Localization** — English and Spanish interface translations, switchable from the
top navigation bar.

**Security / PIN gate** — Single PIN-protected session; every route except login is
protected server-side.

## Screenshots

<!-- Screenshots live in screenshots/ and should be refreshed after meaningful UI changes. -->

### Dashboard, payday check-in, and budgeting

![Cadence dashboard showing the payday check-in banner, current pay period safe-to-spend, monthly spending pace, and a goals summary](screenshots/Screenshot%202026-09-02%20at%2010.00.52%E2%80%AFAM.png)

![Budgets page with an overall budget field, committed/safe-to-spend totals, and a per-category budget table](screenshots/Screenshot%202026-09-02%20at%2010.01.29%E2%80%AFAM.png)

The overall budget drives safe-to-spend; category budgets are tracked independently
and used as a fallback when no overall budget is set. The payday check-in banner
launches the guided planning flow for the current period.

### Transactions and review queue

![Transactions page with search, account/category/type/source filters, Import CSV, Transfer, and New actions](screenshots/Screenshot%202026-09-02%20at%2010.01.03%E2%80%AFAM.png)

![Review queue with no pending items, and a Manage connections action for Gmail/Outlook](screenshots/Screenshot%202026-09-02%20at%2010.01.13%E2%80%AFAM.png)

Staged email items sit in the review queue until you approve, edit, or reject them.

### Accounts, recurring items, and goals

![Accounts page listing checking and savings accounts with their native-currency and display-currency balances](screenshots/Screenshot%202026-09-02%20at%2010.01.21%E2%80%AFAM.png)

![Recurring page showing separate panels for subscriptions and recurring contributions](screenshots/Screenshot%202026-09-02%20at%2010.01.39%E2%80%AFAM.png)

![Goals page showing a savings goal with its progress, target date, and per-pay-period contribution amount](screenshots/Screenshot%202026-09-02%20at%2010.01.47%E2%80%AFAM.png)

### Reports and settings

![Reports page showing spending by category for the current period and a six-pay-period trend chart](screenshots/Screenshot%202026-09-02%20at%2010.01.55%E2%80%AFAM.png)

![Settings page showing display currency, cached exchange rates, payday planning preferences, essential fixed categories, and email connections](screenshots/Screenshot%202026-09-02%20at%2010.02.20%E2%80%AFAM.png)

## How it works

1. Create the accounts you actually use (checking, savings, cash, etc.), with an
   opening balance if you're not starting from zero.
2. Enter transactions manually, import a CSV, or connect Gmail/Outlook for
   automated candidate detection.
3. Review any email-derived items on `/review` — approve, edit, or reject each one.
4. Set a budget (overall and/or per category) for the current pay period, or use
   the payday check-in flow to plan the period from income, balances, and
   commitments.
5. Add recurring subscriptions and recurring investment/savings contributions.
6. Create savings goals and follow their per-pay-period roadmap.

Email-extracted items are never written as transactions automatically — every one
passes through the review queue first.

## Tech stack

| Area | Technology |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS, shadcn/ui |
| Database | PostgreSQL / Supabase |
| ORM | Prisma 7 |
| Email ingestion | Gmail API, Microsoft Graph, Claude structured extraction |
| Deployment | Vercel |
| Scheduling | Vercel Cron |

## Getting started

Requires Node 20.19+ and a PostgreSQL database (Supabase works — use the direct or
session-pooler connection string).

```bash
git clone <this-repository>
cd FinanceApp
npm install                 # runs `prisma generate` afterwards
cp .env.example .env.local   # then fill in DATABASE_URL and SESSION_SECRET
npm run db:migrate          # applies prisma/migrations to the database
npm run db:seed             # inserts the default categories
npm run dev
```

Open `http://localhost:3000`, choose a 4–6 digit PIN on first run, and the app is
ready to use. Email automation (Gmail/Outlook) is optional — see
[PHASE2.md](./PHASE2.md) for that setup.

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

## Environment variables

Values must never be committed — `.env*` is gitignored except `.env.example`.
`APP_TIMEZONE` should be set to `America/Santo_Domingo` (its default), since that's
the authoritative source for "today" and pay-period boundaries.

| Variable | Required for | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Core app | Runtime PostgreSQL connection string |
| `DIRECT_URL` | Core app (CLI) | Session-capable connection used by the Prisma CLI for migrations/seeding |
| `SESSION_SECRET` | Core app | Signs the session cookie |
| `APP_TIMEZONE` | Core app | IANA timezone for resolving pay periods; defaults to `America/Santo_Domingo` |
| `OAUTH_ENCRYPTION_KEY` | Email automation | Encrypts stored OAuth tokens at rest |
| `CRON_SECRET` | Email automation | Bearer token required by the ingestion cron route |
| `APP_URL` | Email automation (production) | Canonical production origin used to build the stable Gmail OAuth redirect URI |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Email automation | Gmail OAuth |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Email automation | Outlook OAuth |
| `ANTHROPIC_API_KEY` | Email automation | Parses transactional emails into structured data |

Full setup for the email-automation variables (Google Cloud Console and Azure app
registration steps) is in [PHASE2.md](./PHASE2.md).

## Deployment

Production runs on Vercel with a Supabase PostgreSQL database. The app connects at
runtime through the pooled (transaction-mode) connection string, while Prisma
migrations use the documented direct/session connection. Environment-variable
changes in Vercel only take effect on the next deploy — redeploy after updating
them. See [DEPLOY.md](./DEPLOY.md) for the full Supabase migration walkthrough.

## Current limitations

- Email ingestion supports Gmail and Outlook only; PayPal ingestion is intentionally
  not included.
- Email-derived transactions are staged for review and never become real
  transactions automatically.
- A mailbox's first sync may need several runs to catch up, since ingestion caps
  each run at a limited batch per mailbox.
- No direct bank synchronization.
- No native mobile app; the responsive web app works from mobile browsers.
- The bundled Vercel Cron schedule runs the ingestion route once daily; the
  in-app "Sync now" button can be used any time in between.

## Project status

Cadence is an actively used personal project and version-one foundation. Manual
tracking, CSV import, budgets, goals, and reviewed Gmail/Outlook ingestion are all
implemented. It is not a public or commercial service — see
[PHASE2.md](./PHASE2.md) for what's built on top of the base app, and the note at
the bottom of that file for what's intentionally not built yet.

## Security notes

- Access is gated behind a single PIN; every route except `/login` requires an
  authenticated session.
- Gmail and Outlook connections request read-only scopes.
- Emails are parsed into a staged review queue — nothing is written as a real
  transaction without explicit approval.
- Never commit `.env*` files; `.env.example` is the only one tracked in git.
- Cadence is a personal tracking tool, not professional financial advice or a
  bank-grade financial institution.

## License

Private personal project — no license has been specified yet.
