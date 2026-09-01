# Spanish localization — design spec

## Goal

Add a language switch next to the currency selector so the whole app can be
viewed in Spanish. English stays the default; Spanish is a full second
translation of the UI, not a partial/fallback experience.

## Non-goals

- No URL-based locale routing (no `/en`, `/es` paths). This stays a single
  stored preference, not a routing concern — same shape as `displayCurrency`.
- No date/number format localization. Dates stay in their current format
  (e.g. "Aug 16-31", "August 16-31, 2026") and currency figures are
  unaffected by language. Only UI copy (labels, headings, buttons, empty
  states, toasts, validation messages) is translated.
- No third-party i18n library (e.g. next-intl). A custom, zero-dependency,
  type-checked dictionary approach is used instead — see below.
- Multi-user / per-visitor language preference is out of scope; Cadence is
  single-user, so one stored language, same as one stored display currency.

## Data & persistence

Add a `language` column to the `Settings` singleton, mirroring
`displayCurrency`:

```prisma
model Settings {
  id              String   @id @default("singleton")
  pinHash         String?
  displayCurrency String   @default("USD")
  language        String   @default("en")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

A Prisma migration adds the column with the `"en"` default, so existing rows
need no backfill.

`AppContext` (`src/lib/data/context.ts`) gains a `language: Locale` field,
populated from `settings.language` the same way `displayCurrency` is
populated today. This is read once per request via the existing `cache()`
wrapper — no new plumbing.

A new server action, `updateLanguageAction`, is added to
`src/server/actions/settings.ts`, structurally identical to
`updateDisplayCurrencyAction`: validate the incoming code against `["en",
"es"]`, upsert `Settings.language`, `revalidateApp()`, return a translated
confirmation message.

## Translation mechanism

No i18n library. Plain, type-checked dictionary objects:

- `src/lib/i18n/en.ts` — the canonical English dictionary, one nested key per
  page/area: `nav`, `dashboard`, `transactions`, `accounts`, `budgets`,
  `recurring`, `goals`, `reports`, `settings`, `review`, `login`, `shell`,
  and `common` (shared words: Save, Cancel, Edit, Delete, etc.).
- `src/lib/i18n/es.ts` — the Spanish dictionary, typed as `satisfies typeof
  en` so a missing or mistyped key is a TypeScript compile error, not a
  silent runtime fallback to English.
- `src/lib/i18n/index.ts` — exports `type Locale = "en" | "es"`, the
  `dictionaries` map, and `getDictionary(locale: Locale)`.

**Server components** (the majority of this app, since it's server-actions
based with minimal client-side state) call:

```ts
const { language } = await getAppContext();
const t = getDictionary(language);
```

then reference `t.dashboard.safeToSpend` etc. `getAppContext()` is already
`cache()`-wrapped per request, so this adds no extra data fetching.

**Server actions** (toast/validation messages) fetch `getSettings()`
directly — the same call `updateDisplayCurrencyAction` already makes — and
translate the message they return via `ActionState`.

**Client components** (switchers, dialogs, interactive forms) receive
`locale` as a prop from their nearest server-component parent, exactly like
`CurrencySwitcher` receives `value={context.displayCurrency}` today.
Dictionaries are plain objects with no server-only imports, so client
components can safely import `getDictionary` and use it with the passed-in
`locale` prop.

**Login page** (`src/app/login/page.tsx`) runs before authentication, so it
can't call `getAppContext()` (which is gated behind other app data). It
reads `Settings.language` directly via the existing `getSettings()` helper
from `src/lib/auth.ts`, the same way it already reads PIN-configuration
state without requiring auth.

## The switch component

`src/components/shell/language-switcher.tsx` — a `LanguageSwitcher` client
component, a near-verbatim sibling of `src/components/shell/currency-
switcher.tsx`:

- Dropdown trigger shows the current language code (`EN` / `ES`).
- Dropdown lists both languages with a checkmark on the active one.
- `onSelect` calls `updateLanguageAction` via `useTransition`, same
  optimistic-toast pattern as the currency switcher.

Placed immediately next to `CurrencySwitcher` in
`src/components/shell/app-shell.tsx`'s header:

```tsx
<CurrencySwitcher value={context.displayCurrency} />
<LanguageSwitcher value={context.language} />
<ThemeToggle />
<LogoutButton />
```

## Rollout scope

"Everything" means every page under `src/app/(app)/*` (dashboard,
transactions, accounts, budgets, recurring, goals, reports, settings,
review), the app shell (nav labels, period-rail copy, sidebar footer text),
the login/PIN screen, and all toast/validation messages surfaced by server
actions. Of the ~148 files in `src/`, the large majority are non-UI (`lib/`,
`server/actions/` business logic, Prisma-generated client, data-query
helpers) and are untouched — the translation work concentrates on
`src/components/**/*.tsx` and `src/app/**/page.tsx` files that render
user-facing text.

Implementation proceeds page-by-page, in this order (roughly increasing
complexity / dependency order):

1. Shell & nav (app-shell, nav-links, period-rail, login/PIN gate)
2. Dashboard
3. Transactions (incl. CSV import dialog)
4. Accounts
5. Budgets
6. Recurring
7. Goals
8. Reports
9. Settings (incl. email connections copy)
10. Review queue

Each step: add the page's dictionary keys to both `en.ts` and `es.ts`, swap
hardcoded JSX strings for `t.*` lookups, translate any validation/toast
messages the page's server actions emit.

## Testing / verification

No existing UI-text test infrastructure in this repo — `scripts/verify-
domain.ts` covers domain logic (pay periods, safe-to-spend, transfers), not
copy. Verification is manual: after each page's pass, toggle the language
switcher and click through that page in both languages, confirming:

- No leftover hardcoded English string when Spanish is active.
- No broken layout from longer Spanish strings (buttons, nav labels, badges
  are the highest-risk spots).
- The switch itself persists across a reload (confirms the Settings write
  round-trips) and across the login screen.

## Error handling

Same shape as the existing currency flow: `updateLanguageAction` returns
`fail(message)` on validation failure (invalid/unknown language code) or
`done(message)` on success, surfaced via the existing toast pattern in
`LanguageSwitcher`. No new error states are introduced.
