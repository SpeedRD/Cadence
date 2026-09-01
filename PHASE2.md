# Phase 2A - Email ingestion

Connects Gmail and Outlook, pulls transactional emails, parses them with Claude
into `StagedTransaction` rows, and lets you approve, edit, or reject each one
on `/review` before it becomes a real `Transaction`. Manual entry and CSV
import (Phase 1) are unchanged.

## Setup

1. Run the migration and fill in the new environment variables below.
2. Generate the two secrets Cadence needs regardless of provider:

   ```bash
   openssl rand -hex 32   # OAUTH_ENCRYPTION_KEY
   openssl rand -hex 24   # CRON_SECRET
   ```
3. Set up Google and/or Microsoft OAuth (below) and get an Anthropic API key
   from https://console.anthropic.com.
4. `npm run db:migrate`, then `npm run dev`, sign in, and go to
   **Settings → Manage connections** (`/settings/connections`).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `OAUTH_ENCRYPTION_KEY` | AES-256-GCM key that encrypts stored OAuth tokens at rest. Any string works (it's hashed to 32 bytes) - `openssl rand -hex 32` is the simplest. |
| `CRON_SECRET` | Bearer token the `/api/cron/ingest` route requires. Vercel sets the `Authorization` header to this automatically for its own Cron invocations. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From Google Cloud Console (below). |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | From the Azure portal (below). |
| `MICROSOFT_TENANT_ID` | Optional, defaults to `common` (personal + work/school accounts). Set to a specific tenant ID to restrict sign-in to one organization. |
| `ANTHROPIC_API_KEY` | Used for the email-parsing call (`claude-opus-5`). |

## Google Cloud Console setup

1. Create or open a project at https://console.cloud.google.com.
2. **APIs & Services → Library** - enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** - set it up for **External** users
   (or **Internal** if you're on a Workspace domain and want to keep this
   private to it). Add your own Google account as a test user if the app
   stays in "Testing" publishing status - that's fine for personal use and
   avoids Google's app-verification review.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   type **Web application**.
5. Under **Authorized redirect URIs**, add one entry per place you'll run the
   app from, e.g.:
   - `http://localhost:3000/api/auth/gmail/callback` (local dev)
   - `https://your-app.vercel.app/api/auth/gmail/callback` (production)
   - any custom domain, the same way

   Cadence builds the redirect URI from the request's own origin at connect
   time, so it works unmodified on `*.vercel.app` and a custom domain - you
   just need each origin you'll actually use registered here, since Google
   rejects a callback to a redirect URI it doesn't recognize.
6. Copy the generated **Client ID** and **Client secret** into
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Scopes requested: `gmail.readonly` and `userinfo.email` (to show which
address is connected). Cadence asks for `access_type=offline` and
`prompt=consent` so Google always returns a refresh token, including on a
reconnect.

## Microsoft Graph (Azure) setup

1. https://portal.azure.com → **Microsoft Entra ID → App registrations → New
   registration**.
2. **Supported account types**: "Accounts in any organizational directory and
   personal Microsoft accounts" matches Cadence's default `common` tenant. Pick
   a single-tenant option instead if you set `MICROSOFT_TENANT_ID`.
3. **Redirect URI**: platform **Web**, and add the same set of URLs as Google,
   swapping the path:
   - `http://localhost:3000/api/auth/outlook/callback`
   - `https://your-app.vercel.app/api/auth/outlook/callback`
4. **Certificates & secrets → New client secret** - copy the **value**
   immediately (Azure only shows it once) into `MICROSOFT_CLIENT_SECRET`.
5. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions** - add `Mail.Read`, `User.Read`, and `offline_access` (the
   last two are usually pre-granted by default).
6. Copy the **Application (client) ID** into `MICROSOFT_CLIENT_ID`.

Disconnecting an Outlook account deletes the stored tokens from Cadence, but
Microsoft has no simple server-side revocation endpoint - the grant itself
stays listed under the user's Microsoft account permissions until they remove
it there too.

## Triggering the ingestion pipeline

Two ways, both running the same code (`src/lib/ingestion.ts`):

- **UI**: the **Sync now** button on `/settings/connections`.
- **HTTP**, for Vercel Cron or manual testing:

  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/ingest
  ```

`vercel.json` schedules this route every 30 minutes via Vercel Cron once
deployed (requires `CRON_SECRET` set in the project's environment variables -
Vercel adds the matching `Authorization` header to its own invocations
automatically). Adjust the cron expression there if you want a different
cadence.

## How it works

1. For each connected mailbox, fetch messages since `lastSyncedAt` (or the
   last 30 days on a mailbox's first sync).
2. Keep only messages whose subject contains a transactional keyword
   ("receipt", "invoice", "payment confirmation", "subscription", "order
   confirmed", …) or whose sender domain is one of `paypal.com`,
   `amazon.com`, `netflix.com`, `spotify.com`, `apple.com`.
3. Send each candidate's subject/sender/date/body to Claude
   (`src/lib/llm/parse-transaction-email.ts`), which returns structured
   fields or "not a transaction" - the prompt instructs it to skip anything
   ambiguous rather than guess.
4. Write a `StagedTransaction` row (`status = PENDING`, `source` = `gmail` or
   `outlook`, `externalId` = the email's Message-ID / internetMessageId).
   Re-fetching the same email on a later sync is a no-op - the
   `(source, externalId)` unique index makes the insert a silent skip.
5. Update the mailbox's `lastSyncedAt`.

Review each item on `/review`: pick an account (required), optionally adjust
the category, then **Approve** (creates the real `Transaction`, carrying the
same `source`/`externalId`) or **Reject** (soft-deletes it - `status =
REJECTED`, kept for audit, never becomes a transaction). **Edit** opens a
dialog for the date/amount/currency/description before you approve. "Show
reviewed" reveals already-approved/rejected items.

## Known limitations

- **One sync run caps at 20 matching emails per mailbox** (`MAX_CANDIDATES_PER_ACCOUNT`
  in `src/lib/ingestion.ts`) to keep a single Vercel function invocation - and a
  single Claude call per email - within typical serverless time limits. A
  mailbox with a bigger backlog catches up over a few syncs; lower this
  further (and the cron route's `maxDuration`) if your Vercel plan caps
  function duration below 60s.
- **Every staged transaction becomes an EXPENSE on approval.** Every source
  this phase ingests (receipts, invoices, payment confirmations,
  subscriptions, order confirmations) represents money going out - nothing
  here stages income, so there's no type picker in the review UI.
- **One transaction per email.** If an email describes more than one distinct
  charge, the model is instructed to skip it (`isTransaction: false`) rather
  than pick one arbitrarily. Forward that kind of email through manual entry
  or CSV import instead.
- **Forwarded receipts** usually still parse fine (the original transaction
  details are normally still in the body as quoted text) but the sender/date
  headers will reflect the forward, not the original message - the parser is
  told to prefer any transaction date mentioned in the body text over the
  email's own send date, but a forward with no dates in the body falls back
  to the (wrong) forward date.
- **Currency inference** falls back to the app's display currency
  (Settings → Display currency) when an email gives no symbol or code -
  ingestion doesn't know the destination account yet (that's chosen at
  review), so it can't use "the account's currency" as the fallback the way a
  later, account-aware step could.
- **HTML email bodies** are converted to text with a small regex-based
  stripper, not a full HTML parser - occasional layout noise in what reaches
  Claude is expected and generally harmless to extraction quality.
- **Google app verification**: while your OAuth consent screen is in
  "Testing" status, only the test users you add can complete the Gmail
  connect flow. That's expected for personal use; publishing the app removes
  the cap but invites Google's verification review, which isn't needed here.
