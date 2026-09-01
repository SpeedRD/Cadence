# Spanish Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a language switcher next to the currency selector so the whole
app can be viewed in Spanish, with English as the default.

**Architecture:** A `language` column on the `Settings` singleton (mirroring
`displayCurrency`), read into the existing per-request `AppContext`. A
zero-dependency, type-checked dictionary (`src/lib/i18n/en.ts` /
`src/lib/i18n/es.ts`) supplies translated strings to server components (via
`getAppContext()`), server actions (via `getSettings()`), and client
components (via a `locale` prop, same pattern as `CurrencySwitcher`).

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma 7, no new
dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-spanish-localization-design.md`

## Global Constraints

- No URL-based locale routing — this is a stored preference, not a route.
- No date/number format localization — only UI copy translates. Dates,
  currency figures, and period labels (`Aug 16-31` etc.) are unchanged.
- No third-party i18n library — custom dictionaries only.
- `es.ts` must be typed `satisfies typeof en` — a missing/mistyped key is a
  compile error. Run `npm run typecheck` after every task.
- Single-user app: one stored language, no per-visitor state.
- No automated UI-text test suite exists in this repo. Verification is
  manual: toggle the switcher, click through the affected page(s) in both
  languages.

---

## Task 1: Foundation — schema, context, dictionaries skeleton, switcher

**Files:**
- Modify: `prisma/schema.prisma` (Settings model)
- Create: `prisma/migrations/<timestamp>_add_language_setting/migration.sql` (generated, not hand-written)
- Modify: `src/lib/data/context.ts`
- Modify: `src/server/actions/settings.ts`
- Create: `src/lib/i18n/en.ts`
- Create: `src/lib/i18n/es.ts`
- Create: `src/lib/i18n/index.ts`
- Create: `src/components/shell/language-switcher.tsx`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `src/components/auth/pin-gate.tsx`
- Modify: `src/server/actions/auth.ts`

**Interfaces:**
- Produces: `type Locale = "en" | "es"` (`src/lib/i18n/index.ts`)
- Produces: `getDictionary(locale: Locale): Dictionary` (`src/lib/i18n/index.ts`)
- Produces: `AppContext.language: Locale` (`src/lib/data/context.ts`)
- Produces: `updateLanguageAction(state, formData): Promise<ActionState>` (`src/server/actions/settings.ts`)
- Consumed by every later task: `getDictionary`, `AppContext.language`.

- [ ] **Step 1: Add `language` to the Settings model**

Edit `prisma/schema.prisma`:

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

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_language_setting`

This requires a reachable dev database (`DATABASE_URL` in `.env`). It
creates `prisma/migrations/<timestamp>_add_language_setting/migration.sql`
with an `ALTER TABLE "Settings" ADD COLUMN "language" TEXT NOT NULL DEFAULT
'en'` statement and regenerates the Prisma client.

Expected: command exits 0, new migration folder exists, `npm run typecheck`
still passes (Prisma client types now include `language`).

- [ ] **Step 3: Create the dictionary type and English dictionary**

Create `src/lib/i18n/en.ts`:

```ts
export const en = {
  common: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    add: "Add",
    keepIt: "Keep it",
    saved: "Saved",
    deleted: "Deleted",
    done: "Done",
    name: "Name",
    date: "Date",
    amount: "Amount",
    currency: "Currency",
    category: "Category",
    note: "Note",
    type: "Type",
    optional: "Optional",
    checkFormAndRetry: "Check the form and try again",
    accountTypeLabels: {
      CHECKING: "Checking",
      SAVINGS: "Savings",
      CASH: "Cash",
      OTHER: "Other",
    } as Record<string, string>,
    transactionTypeLabels: {
      EXPENSE: "Expense",
      INCOME: "Income",
      TRANSFER: "Transfer",
    } as Record<string, string>,
    sourceLabels: {
      MANUAL: "Manual",
      CSV: "CSV",
      GMAIL: "Gmail",
      OUTLOOK: "Outlook",
      PAYPAL: "PayPal",
    } as Record<string, string>,
    frequencyLabels: {
      WEEKLY: "Weekly",
      BIWEEKLY: "Every 2 weeks",
      MONTHLY: "Monthly",
      YEARLY: "Yearly",
    } as Record<string, string>,
    recurringKindLabels: {
      SUBSCRIPTION: "Subscription",
      CONTRIBUTION: "Contribution",
    } as Record<string, string>,
  },
  nav: {
    dashboard: "Dashboard",
    transactions: "Transactions",
    review: "Review",
    accounts: "Accounts",
    budgets: "Budgets",
    recurring: "Recurring",
    goals: "Goals",
    reports: "Reports",
    settings: "Settings",
  },
  shell: {
    paidTwiceAMonth: (range: string) => `Paid twice a month. Budgets run ${range}.`,
    periodClosed: "Period closed",
    daysLeft: (n: number) => `${n} day${n === 1 ? "" : "s"} left`,
    lockCadenceAria: "Lock Cadence",
    toggleThemeAria: "Toggle light and dark mode",
    displayCurrencyLabel: "Display currency",
    languageLabel: "Language",
  },
  login: {
    createSubtitle:
      "Set a PIN to lock this ledger. It stays on this device's session, hashed in your own database.",
    loginSubtitle: "Enter your PIN to open the ledger.",
    newPin: "New PIN",
    pin: "PIN",
    confirm: "Confirm",
    confirmPinAria: "Confirm PIN",
    digitsHint: "4 to 6 digits",
    setPinAndContinue: "Set PIN and continue",
    unlock: "Unlock",
    pinAlreadySet: "A PIN is already set for this app",
    entriesMustMatch: "Both entries must match",
    pinDoesNotMatch: "That PIN doesn't match",
  },
} as const;

export type Dictionary = typeof en;
```

- [ ] **Step 4: Create the Spanish dictionary**

Create `src/lib/i18n/es.ts`:

```ts
import type { Dictionary } from "./en";

export const es = {
  common: {
    save: "Guardar",
    cancel: "Cancelar",
    delete: "Eliminar",
    edit: "Editar",
    add: "Agregar",
    keepIt: "Conservar",
    saved: "Guardado",
    deleted: "Eliminado",
    done: "Listo",
    name: "Nombre",
    date: "Fecha",
    amount: "Monto",
    currency: "Moneda",
    category: "Categoría",
    note: "Nota",
    type: "Tipo",
    optional: "Opcional",
    checkFormAndRetry: "Revisa el formulario e intenta de nuevo",
    accountTypeLabels: {
      CHECKING: "Corriente",
      SAVINGS: "Ahorros",
      CASH: "Efectivo",
      OTHER: "Otro",
    } as Record<string, string>,
    transactionTypeLabels: {
      EXPENSE: "Gasto",
      INCOME: "Ingreso",
      TRANSFER: "Transferencia",
    } as Record<string, string>,
    sourceLabels: {
      MANUAL: "Manual",
      CSV: "CSV",
      GMAIL: "Gmail",
      OUTLOOK: "Outlook",
      PAYPAL: "PayPal",
    } as Record<string, string>,
    frequencyLabels: {
      WEEKLY: "Semanal",
      BIWEEKLY: "Cada 2 semanas",
      MONTHLY: "Mensual",
      YEARLY: "Anual",
    } as Record<string, string>,
    recurringKindLabels: {
      SUBSCRIPTION: "Suscripción",
      CONTRIBUTION: "Aporte",
    } as Record<string, string>,
  },
  nav: {
    dashboard: "Panel",
    transactions: "Transacciones",
    review: "Revisión",
    accounts: "Cuentas",
    budgets: "Presupuestos",
    recurring: "Recurrentes",
    goals: "Metas",
    reports: "Informes",
    settings: "Ajustes",
  },
  shell: {
    paidTwiceAMonth: (range: string) => `Pago dos veces al mes. Los presupuestos van del ${range}.`,
    periodClosed: "Periodo cerrado",
    daysLeft: (n: number) => `${n} día${n === 1 ? "" : "s"} restante${n === 1 ? "" : "s"}`,
    lockCadenceAria: "Bloquear Cadence",
    toggleThemeAria: "Cambiar modo claro y oscuro",
    displayCurrencyLabel: "Moneda de visualización",
    languageLabel: "Idioma",
  },
  login: {
    createSubtitle:
      "Crea un PIN para bloquear este libro contable. Se guarda en la sesión de este dispositivo, cifrado en tu propia base de datos.",
    loginSubtitle: "Ingresa tu PIN para abrir el libro contable.",
    newPin: "PIN nuevo",
    pin: "PIN",
    confirm: "Confirmar",
    confirmPinAria: "Confirmar PIN",
    digitsHint: "De 4 a 6 dígitos",
    setPinAndContinue: "Crear PIN y continuar",
    unlock: "Desbloquear",
    pinAlreadySet: "Ya hay un PIN configurado para esta app",
    entriesMustMatch: "Ambas entradas deben coincidir",
    pinDoesNotMatch: "Ese PIN no coincide",
  },
} as const satisfies Dictionary;
```

- [ ] **Step 5: Create the dictionary index**

Create `src/lib/i18n/index.ts`:

```ts
import { en } from "./en";
import { es } from "./es";

export type Locale = "en" | "es";
export type { Dictionary } from "./en";

export const dictionaries = { en, es } as const;

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "es";
}
```

- [ ] **Step 6: Add `language` to AppContext**

Edit `src/lib/data/context.ts`:

```ts
import { cache } from "react";

import { getSettings } from "@/lib/auth";
import { toCurrency, type CurrencyCode, type RateTable } from "@/lib/currency";
import { today } from "@/lib/date";
import { getDictionary, isLocale, type Locale } from "@/lib/i18n";
import { periodForDate, type PeriodInfo } from "@/lib/period";
import { getRateTable } from "@/lib/rates";
import { advanceDueRecurringItems } from "@/lib/recurring";

export interface AppContext {
  displayCurrency: CurrencyCode;
  language: Locale;
  rates: RateTable;
  today: Date;
  currentPeriod: PeriodInfo;
}

export const getAppContext = cache(async (): Promise<AppContext> => {
  const now = today();
  await advanceDueRecurringItems(now);
  const [settings, rates] = await Promise.all([getSettings(), getRateTable()]);
  return {
    displayCurrency: toCurrency(settings.displayCurrency),
    language: isLocale(settings.language) ? settings.language : "en",
    rates,
    today: now,
    currentPeriod: periodForDate(now),
  };
});
```

Note: `getDictionary` is imported here for re-export convenience in later
tasks but not called in this file — pages call it themselves with
`context.language`. Remove the unused-import if your linter flags it, or
drop that import line; it is not required by this file's own logic.

Actually — simplify: **do not** import `getDictionary` in `context.ts` at
all, since this file doesn't call it. Only import `isLocale` and `Locale`:

```ts
import { isLocale, type Locale } from "@/lib/i18n";
```

- [ ] **Step 7: Add the language server action**

Edit `src/server/actions/settings.ts` — add alongside
`updateDisplayCurrencyAction`:

```ts
import { isLocale } from "@/lib/i18n";

export async function updateLanguageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const language = String(formData.get("language") ?? "");
  if (!isLocale(language)) return fail("Unknown language");

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: { language },
    create: { id: SETTINGS_ID, language },
  });
  revalidateApp();
  return done(language === "es" ? "Mostrando Cadence en español" : "Showing Cadence in English");
}
```

Add the `import { isLocale } from "@/lib/i18n";` line near the top with the
other imports.

- [ ] **Step 8: Create the LanguageSwitcher component**

Create `src/components/shell/language-switcher.tsx`, modeled on
`src/components/shell/currency-switcher.tsx`:

```tsx
"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Locale } from "@/lib/i18n";
import { updateLanguageAction } from "@/server/actions/settings";
import { cn } from "@/lib/utils";

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

/** Sets the language every label and message in the app renders in. */
export function LanguageSwitcher({
  value,
  switcherLabel,
}: {
  value: Locale;
  switcherLabel: string;
}) {
  const [pending, startTransition] = useTransition();

  const select = (code: Locale) => {
    if (code === value) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("language", code);
      const result = await updateLanguageAction(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} className="font-mono">
          {value.toUpperCase()}
          <ChevronsUpDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{switcherLabel}</DropdownMenuLabel>
        {LANGUAGES.map(({ code, label }) => (
          <DropdownMenuItem key={code} onSelect={() => select(code)}>
            <Check
              className={cn("size-3.5", code === value ? "opacity-100" : "opacity-0")}
            />
            <span className="font-mono">{code.toUpperCase()}</span>
            <span className="text-muted-foreground">{label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 9: Wire the switcher and translate the shell into app-shell.tsx**

Edit `src/components/shell/app-shell.tsx`. Add the import and translate the
literal strings:

```tsx
import { NavLinks } from "@/components/shell/nav-links";
import { CurrencySwitcher } from "@/components/shell/currency-switcher";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { LogoutButton } from "@/components/shell/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { PeriodRail } from "@/components/period-rail";

import type { AppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod, daysRemainingInPeriod } from "@/lib/period";

export function AppShell({
  context,
  children,
}: {
  context: AppContext;
  children: React.ReactNode;
}) {
  const { currentPeriod } = context;
  const t = getDictionary(context.language);
  const remaining = daysRemainingInPeriod(context.today, currentPeriod);
  const elapsed = daysElapsedInPeriod(context.today, currentPeriod);
```

Replace the sidebar footer text:

```tsx
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t.shell.paidTwiceAMonth(currentPeriod.period === "A" ? "1-15" : "16-end")}
          </p>
```

Replace the period-remaining text:

```tsx
                <p className="text-[0.6875rem] text-muted-foreground">
                  {remaining === 0 ? t.shell.periodClosed : t.shell.daysLeft(remaining)}
                </p>
```

Replace the header actions row:

```tsx
            <div className="ml-auto flex items-center gap-1">
              <CurrencySwitcher value={context.displayCurrency} />
              <LanguageSwitcher value={context.language} switcherLabel={t.shell.languageLabel} />
              <ThemeToggle />
              <LogoutButton />
            </div>
```

- [ ] **Step 10: Translate CurrencySwitcher's label**

Edit `src/components/shell/currency-switcher.tsx` — add a `switcherLabel`
prop (same shape as the new `LanguageSwitcher`) instead of the hardcoded
`"Display currency"` string:

```tsx
export function CurrencySwitcher({
  value,
  switcherLabel,
}: {
  value: string;
  switcherLabel: string;
}) {
```

Replace `<DropdownMenuLabel>Display currency</DropdownMenuLabel>` with
`<DropdownMenuLabel>{switcherLabel}</DropdownMenuLabel>`.

Back in `app-shell.tsx`, update the call site from Step 9 to:

```tsx
<CurrencySwitcher value={context.displayCurrency} switcherLabel={t.shell.displayCurrencyLabel} />
```

- [ ] **Step 11: Translate the theme toggle and logout button aria-labels**

Edit `src/components/shell/theme-toggle.tsx` — add an `ariaLabel` prop:

```tsx
export function ThemeToggle({ ariaLabel }: { ariaLabel: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={ariaLabel}
      onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
    >
```

Edit `src/components/shell/logout-button.tsx` — add an `ariaLabel` prop:

```tsx
export function LogoutButton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <form action={logoutAction}>
      <Button variant="ghost" size="icon-sm" type="submit" aria-label={ariaLabel}>
        <LogOut className="size-4" />
      </Button>
    </form>
  );
}
```

Update the two call sites in `app-shell.tsx`:

```tsx
<ThemeToggle ariaLabel={t.shell.toggleThemeAria} />
<LogoutButton ariaLabel={t.shell.lockCadenceAria} />
```

- [ ] **Step 12: Translate the login page and PIN gate**

Edit `src/app/login/page.tsx` to read the language directly (pre-auth):

```tsx
import { redirect } from "next/navigation";

import { PinGate } from "@/components/auth/pin-gate";
import { isAuthenticated, isPinConfigured, getSettings } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata = { title: "Unlock - Cadence" };

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  const [configured, settings] = await Promise.all([
    isPinConfigured(),
    getSettings(),
  ]);
  const t = getDictionary(isLocale(settings.language) ? settings.language : "en");
  return <PinGate mode={configured ? "login" : "create"} t={t.login} />;
}
```

Confirm `getSettings` is exported from `src/lib/auth.ts` (it already is,
used by `getAppContext`).

Edit `src/components/auth/pin-gate.tsx` to accept and use `t`:

```tsx
import type { Dictionary } from "@/lib/i18n";

export function PinGate({
  mode,
  t,
}: {
  mode: "create" | "login";
  t: Dictionary["login"];
}) {
```

Replace the subtitle:

```tsx
            <p className="text-sm text-muted-foreground">
              {mode === "create" ? t.createSubtitle : t.loginSubtitle}
            </p>
```

Replace the "New PIN"/"PIN" eyebrow and label:

```tsx
            <p className="eyebrow">{mode === "create" ? t.newPin : t.pin}</p>
            <PinInput
              name="pin"
              label={mode === "create" ? t.newPin : t.pin}
```

Replace the "Confirm" section:

```tsx
              <p className="eyebrow">{t.confirm}</p>
              <PinInput
                name="confirm"
                label={t.confirmPinAria}
```

Replace the digits hint and submit label:

```tsx
            <p className="text-xs text-muted-foreground">{t.digitsHint}</p>
            <SubmitButton pending={pending} className={cn(!ready && "opacity-60")}>
              {mode === "create" ? t.setPinAndContinue : t.unlock}
            </SubmitButton>
```

- [ ] **Step 13: Translate the PIN action messages**

Edit `src/server/actions/auth.ts`. Read the file first to find
`createPinAction`/`loginAction` and their `fail(...)` calls (`"A PIN is
already set for this app"`, `"Both entries must match"`, `"That PIN doesn't
match"`). Fetch the language and use the dictionary:

```ts
import { getSettings } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";

export async function createPinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const settings = await getSettings();
  const t = getDictionary(isLocale(settings.language) ? settings.language : "en").login;
  // ... existing logic, replacing the three literal strings:
  // "A PIN is already set for this app"  -> t.pinAlreadySet
  // "Both entries must match"            -> t.entriesMustMatch
  // "That PIN doesn't match"             -> t.pinDoesNotMatch
}
```

Apply the same `getSettings()` + `getDictionary(...).login` pattern to
`loginAction`, replacing its `fail("That PIN doesn't match")` with
`fail(t.pinDoesNotMatch)`. Keep `firstError(parsed.error)` calls as-is for
now — Task 2 handles validation-message translation.

- [ ] **Step 14: Typecheck**

Run: `npm run typecheck`
Expected: PASS. This confirms `es.ts` satisfies `Dictionary`, and every new
prop/import type-checks.

- [ ] **Step 15: Manual verification**

Run: `npm run dev`, open `http://localhost:3000/login`.

- Confirm the login screen renders (language defaults to English on a fresh
  Settings row).
- Sign in, confirm the dashboard loads with a working `EN`/`ES` switcher
  next to the currency switcher in the header.
- Click `ES`: confirm a success toast appears, the switcher now shows `ES`,
  the sidebar footer text and the "X days left" header text switch to
  Spanish, and the theme/logout icon buttons still work (aria-labels aren't
  visually checkable, but confirm no console errors).
- Reload the page: confirm the language persists as `ES` (proves the
  Settings write round-tripped).
- Log out and back in: confirm the PIN screen text is in Spanish while
  language is set to `es`.
- Switch back to `EN` before continuing to the next task.

- [ ] **Step 16: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/i18n src/lib/data/context.ts \
  src/server/actions/settings.ts src/server/actions/auth.ts \
  src/components/shell/language-switcher.tsx src/components/shell/app-shell.tsx \
  src/components/shell/currency-switcher.tsx src/components/shell/theme-toggle.tsx \
  src/components/shell/logout-button.tsx src/app/login/page.tsx src/components/auth/pin-gate.tsx
git commit -m "Add language setting, dictionary foundation, and language switcher"
```

---

## Task 2: Shared chrome — enum labels, form buttons, validation messages

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (extend `common`)
- Modify: `src/lib/labels.ts`
- Modify: `src/components/source-badge.tsx`
- Modify: `src/components/form/form-dialog.tsx`
- Modify: `src/components/form/confirm-delete.tsx`
- Modify: `src/lib/validation.ts`
- Modify: every file under `src/server/actions/*.ts` that calls `firstError(...)`

**Interfaces:**
- Consumes: `Dictionary`, `Locale`, `getDictionary` (Task 1)
- Produces: `firstError(error: z.ZodError, locale: Locale): string` (new
  signature — was `firstError(error: z.ZodError)`)
- Produces: `t.common.accountTypeLabels` etc. already declared in Task 1;
  this task is the first to actually consume them from `labels.ts` call
  sites.

- [ ] **Step 1: Make `labels.ts` locale-aware**

Read `src/lib/labels.ts` (already read during planning — reproduced below
for context). Keep every `*_TYPES`/`*_KINDS`/`*_FREQUENCIES` array
untouched (they're value keys, not display text) and keep `labelFor` and
`titleCase` untouched. Delete the four `*_LABELS` constant objects
(`ACCOUNT_TYPE_LABELS`, `TRANSACTION_TYPE_LABELS`, `SOURCE_LABELS`,
`FREQUENCY_LABELS`) and `RECURRING_KIND_LABELS` — those now live in
`t.common.*Labels` (Task 1). `CATEGORY_KIND_LABELS` is unused in any of the
files read during planning; leave it as-is (out of scope, not user-facing
in this app's current UI).

Resulting relevant exports from `src/lib/labels.ts`:

```ts
export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CASH", "OTHER"] as const;
export const TRANSACTION_TYPES = ["EXPENSE", "INCOME", "TRANSFER"] as const;
export const TRANSACTION_SOURCES = ["MANUAL", "CSV", "GMAIL", "OUTLOOK", "PAYPAL"] as const;
export const CATEGORY_KINDS = ["EXPENSE", "INCOME"] as const;
export const CATEGORY_KIND_LABELS: Record<string, string> = {
  EXPENSE: "Expense",
  INCOME: "Income",
};
export const RECURRING_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "YEARLY"] as const;
export const RECURRING_KINDS = ["SUBSCRIPTION", "CONTRIBUTION"] as const;

export function labelFor(map: Record<string, string>, value: string): string {
  return map[value] ?? titleCase(value);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
```

- [ ] **Step 2: Update every `labels.ts` label-object import site**

Each site below currently imports one of the four removed label constants
and passes it to `labelFor(...)` or an `EnumSelect`/`SourceBadge`. Replace
the import with `t.common.<name>Labels`, where `t` is the dictionary for
the current locale, obtained via `getDictionary(context.language)` in
server components or via a `t` prop in client components (see per-file
notes). Full file list, with the exact change per file:

  - `src/components/accounts/account-dialog.tsx` (client): add `t:
    Dictionary["common"]` prop; replace `import { ACCOUNT_TYPES,
    ACCOUNT_TYPE_LABELS } from "@/lib/labels";` with `import { ACCOUNT_TYPES }
    from "@/lib/labels";` and use `labels={t.accountTypeLabels}` on the
    `EnumSelect` for `type`. (This dialog's page-level task, Task 5, wires
    the prop from its callers — this step only prepares the component
    signature; leave callers unwired until Task 5 to avoid a broken build
    mid-task. If that's not possible because TypeScript requires the prop,
    make `t` optional here (`t?: Dictionary["common"]`) with a fallback
    `const labels = t?.accountTypeLabels ?? ACCOUNT_TYPE_LABELS_FALLBACK`
    — **simplify instead**: keep this file's props change AND its callers'
    wiring together in Task 5, not here. Skip this bullet in Task 2; it is
    superseded by the equivalent step in Task 5.)
  - `src/app/(app)/accounts/page.tsx`, `src/app/(app)/accounts/[id]/page.tsx`
    (server, use `ACCOUNT_TYPE_LABELS` via `labelFor`): superseded by Task 5.
  - `src/components/transactions/transaction-dialog.tsx`,
    `src/components/transactions/transaction-filters.tsx` (use
    `TRANSACTION_TYPE_LABELS`): superseded by Task 4.
  - `src/components/recurring/recurring-dialog.tsx`,
    `src/components/recurring/recurring-list.tsx` (use `FREQUENCY_LABELS`,
    `RECURRING_KIND_LABELS`): superseded by Task 7.
  - `src/components/source-badge.tsx`, `src/app/(app)/review/page.tsx`,
    `src/components/transactions/transaction-filters.tsx` (use
    `SOURCE_LABELS`): `source-badge.tsx` is shared and touched here (below);
    the other two are superseded by Tasks 4/11.

  **In this task, only fix the one file that has no page-level task of its
  own: `src/components/source-badge.tsx`.** Give it a `labels:
  Record<string, string>` prop instead of importing `SOURCE_LABELS`
  directly:

  ```tsx
  import { labelFor } from "@/lib/labels";
  import { cn } from "@/lib/utils";

  export function SourceBadge({
    source,
    isTransfer = false,
    className,
    labels,
    transferLabel,
  }: {
    source: string;
    isTransfer?: boolean;
    className?: string;
    labels: Record<string, string>;
    transferLabel: string;
  }) {
    const Icon = isTransfer ? ArrowRightLeft : (SOURCE_ICONS[source] ?? CircleSmall);
    const label = isTransfer ? transferLabel : labelFor(labels, source);

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-foreground/6 px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground",
          className,
        )}
        title={isTransfer ? `${transferLabel} (${labelFor(labels, source)})` : label}
      >
        <Icon className="size-3" />
        {label}
      </span>
    );
  }
  ```

  Its three call sites (`transaction-table.tsx`, `accounts/[id]/page.tsx`,
  and later `review-row.tsx` if it uses it — check; it does not per the
  files read) are updated in Tasks 4 and 5, which now must pass `labels`
  and `transferLabel` — note this dependency in those tasks (already
  reflected there).

- [ ] **Step 3: Translate the shared FormDialog and ConfirmDelete button text**

Edit `src/components/form/form-dialog.tsx` — add `cancelLabel` and
`defaultSaveLabel` props:

```tsx
export function FormDialog({
  title,
  description,
  trigger,
  action,
  submitLabel,
  cancelLabel,
  children,
  size = "default",
  open: controlledOpen,
  onOpenChange,
  savedMessage,
}: {
  title: string;
  description?: string;
  trigger?: React.ReactNode;
  action: Action;
  submitLabel: string;
  cancelLabel: string;
  children: React.ReactNode;
  size?: "default" | "wide";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  savedMessage: string;
}) {
```

Update the toast fallback and the Cancel button:

```tsx
      toast.success(state.message ?? savedMessage);
      // ...
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {cancelLabel}
            </Button>
```

Remove the `submitLabel = "Save"` default — every caller must now pass it
explicitly (already true for all current callers except the ones that rely
on the default; grep confirms every `<FormDialog>` usage across the
codebase already passes `submitLabel`, so no caller breaks).

Edit `src/components/form/confirm-delete.tsx` similarly — add `keepLabel`
and `deletedMessage` props, remove the `confirmLabel = "Delete"` default:

```tsx
export function ConfirmDelete({
  id,
  action,
  title,
  description,
  trigger,
  confirmLabel,
  keepLabel,
  deletedMessage,
  open: controlledOpen,
  onOpenChange,
}: {
  id: string;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  title: string;
  description: string;
  trigger?: React.ReactNode;
  confirmLabel: string;
  keepLabel: string;
  deletedMessage: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
```

```tsx
      toast.success(state.message ?? deletedMessage);
      // ...
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {keepLabel}
            </Button>
            <SubmitButton pending={pending} variant="destructive">
              {confirmLabel}
            </SubmitButton>
```

Every `<FormDialog>` and `<ConfirmDelete>` call site across the app must now
pass these new required props. This touches every dialog file — each
page-level task (3 through 11) updates the call sites it owns. List of
call sites, for tracking: `transaction-dialog.tsx`, `transfer-dialog.tsx`,
`account-dialog.tsx`, `recurring-dialog.tsx`, `goal-dialog.tsx`,
`contribution-dialog.tsx`, `review-edit-dialog.tsx` (all `FormDialog`);
`transaction-table.tsx`, `account-row-actions.tsx`, `recurring-list.tsx`,
`goal-actions.tsx` (x2), `provider-connections.tsx` (all `ConfirmDelete`).

- [ ] **Step 4: Add validation message translation**

Edit `src/lib/validation.ts`. Add a translation map and change
`firstError`'s signature:

```ts
import type { Locale } from "@/lib/i18n";

const VALIDATION_MESSAGES_ES: Record<string, string> = {
  "Pick a date": "Elige una fecha",
  "Enter a valid date": "Ingresa una fecha válida",
  "Enter an amount greater than 0": "Ingresa un monto mayor que 0",
  "Keep notes under 500 characters": "Mantén las notas en menos de 500 caracteres",
  "Use 4 to 6 digits": "Usa de 4 a 6 dígitos",
  "Name the account": "Ponle nombre a la cuenta",
  "Pick an account": "Elige una cuenta",
  "Pick a source account": "Elige una cuenta de origen",
  "Pick a destination account": "Elige una cuenta de destino",
  "Pick two different accounts": "Elige dos cuentas diferentes",
  "Enter 0 or more": "Ingresa 0 o más",
  "Name the item": "Ponle nombre al elemento",
  "Name the goal": "Ponle nombre a la meta",
  "Add a description": "Agrega una descripción",
  "Keep the description under 200 characters":
    "Mantén la descripción en menos de 200 caracteres",
  "Pick an account before approving": "Elige una cuenta antes de aprobar",
  "Check the form and try again": "Revisa el formulario e intenta de nuevo",
};

export function firstError(error: z.ZodError, locale: Locale = "en"): string {
  const message = error.issues[0]?.message ?? "Check the form and try again";
  if (locale === "es") return VALIDATION_MESSAGES_ES[message] ?? message;
  return message;
}
```

- [ ] **Step 5: Pass locale through every `firstError` call site**

Each of these files calls `firstError(parsed.error)` and must fetch the
locale and pass it. Pattern for every file below:

```ts
import { getSettings } from "@/lib/auth";
import { isLocale } from "@/lib/i18n";
// ...
const settings = await getSettings();
const locale = isLocale(settings.language) ? settings.language : "en";
// ...
if (!parsed.success) return fail(firstError(parsed.error, locale));
```

Files: `src/server/actions/accounts.ts`, `transactions.ts`, `budgets.ts`,
`recurring.ts`, `goals.ts`, `review.ts`, `import.ts`. (`auth.ts` and
`settings.ts` already fetch settings/locale from Task 1's Step 13 and don't
need a second fetch — reuse the existing `settings`/`t` binding there
instead of calling `getSettings()` twice.)

Where a file already calls `getAppContext()` (unlikely in action files,
but check), reuse `context.language` instead of a second `getSettings()`
call.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: FAIL initially, listing every `<FormDialog>`/`<ConfirmDelete>`
call site missing the new required props, and every `firstError(...)` call
that's fine (default param covers it) — the required prop errors are
expected here since those call sites aren't fixed until Tasks 3-11. This is
acceptable: **commit this task's shared-chrome changes together with a
placeholder pass where each `FormDialog`/`ConfirmDelete` caller listed in
Step 3 gets its required props filled in as bare minimum English defaults
right now**, so the build stays green, and then Tasks 3-11 replace those
English defaults with proper `t.*` lookups.

Revise Step 3's scope: after defining the new props, immediately grep every
`<FormDialog` and `<ConfirmDelete` usage and add literal English strings
for the new required props (`cancelLabel="Cancel"`, `savedMessage="Saved"`,
`keepLabel="Keep it"`, `deletedMessage="Deleted"`,
`confirmLabel="Delete"` where not already passed) so `npm run typecheck`
passes at the end of this task. Tasks 3-11 then replace these English
literals with dictionary lookups as part of translating their own page.

Run: `npm run typecheck` again.
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run `npm run dev`. Open any dialog (e.g. Accounts → New account) and any
delete confirmation (e.g. an account row's Delete). Confirm both still work
and show "Cancel"/"Delete"/"Keep it" (English, since per-page translation
hasn't happened yet). Confirm no console errors and `SourceBadge` still
renders correctly on the Transactions page (still using its old
`SOURCE_LABELS` import until Task 4 — if this now fails to compile because
Step 2 already changed its props, fix its two call sites
(`transaction-table.tsx`, `accounts/[id]/page.tsx`) here with literal
English args (`labels={{ MANUAL: "Manual", CSV: "CSV", GMAIL: "Gmail",
OUTLOOK: "Outlook", PAYPAL: "PayPal" }}`, `transferLabel="Transfer"`) so the
build stays green; Tasks 4 and 5 replace these with `t.common.sourceLabels`
lookups.

- [ ] **Step 8: Commit**

```bash
git add src/lib/i18n src/lib/labels.ts src/components/source-badge.tsx \
  src/components/form/form-dialog.tsx src/components/form/confirm-delete.tsx \
  src/lib/validation.ts src/server/actions/*.ts \
  src/components/transactions/transaction-table.tsx src/app/\(app\)/accounts/\[id\]/page.tsx
git commit -m "Localize shared form chrome, enum labels, and validation messages"
```

---

## Task 3: Dashboard

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `dashboard` section)
- Modify: `src/app/(app)/page.tsx`
- Modify: `src/components/dashboard/period-hero.tsx`
- Modify: `src/components/dashboard/goal-card.tsx`
- Modify: `src/components/dashboard/upcoming-list.tsx`

**Interfaces:**
- Consumes: `getDictionary`, `AppContext.language` (Task 1)

- [ ] **Step 1: Add the `dashboard` dictionary section**

Add to `src/lib/i18n/en.ts`, inside the exported object, as a new top-level
key alongside `common`/`nav`/`shell`/`login`:

```ts
  dashboard: {
    goalsHeading: "Goals",
    allGoals: "All goals",
    noGoalsTitle: "No goals yet",
    noGoalsDescription:
      "Track something you are saving towards and Cadence works out what each pay period needs to carry.",
    createGoal: "Create a goal",
    nextDays: (n: number) => `Next ${n} days`,
    nothingDue: "Nothing due in the next week.",
    periodPrefix: "Period",
    closed: "closed",
    daysLeftOfTotal: (remaining: number, total: number) =>
      `${remaining} of ${total} days left`,
    safeToSpendPerDay: "Safe to spend per day",
    leftForRest: "left for the rest of this period",
    overThePlan: "over the plan for this period",
    setBudgetPrompt:
      "Set a budget for this period and Cadence works out what you can spend each day after committed outflows.",
    setPeriodBudget: "Set this period's budget",
    spent: "Spent",
    percentOfBudget: (pct: number) => `${pct}% of budget`,
    noBudget: "no budget",
    ofBudgeted: (amount: string) => `of ${amount} budgeted`,
    committed: "Committed",
    itemsDueBefore: (count: number, date: string) =>
      `${count} item${count === 1 ? "" : "s"} due before ${date}`,
    income: "Income",
    loggedThisPeriod: "logged this period",
    of: (amount: string) => `of ${amount}`,
    reached: "Reached",
    dueThisPeriod: "due this period",
    periodsTo: (n: number, date: string) => `${n} periods to ${date}`,
    perPayPeriod: "per pay period",
    pace: "Pace",
    perPeriod: "per period",
    onTrackFor: (date: string) => `on track for ${date}`,
    noContributionsYet: "No contributions yet",
    contributionSuffix: " · contribution",
  },
```

Add the matching Spanish block to `src/lib/i18n/es.ts`:

```ts
  dashboard: {
    goalsHeading: "Metas",
    allGoals: "Todas las metas",
    noGoalsTitle: "Aún no hay metas",
    noGoalsDescription:
      "Registra algo para lo que estás ahorrando y Cadence calcula lo que necesita cada periodo de pago.",
    createGoal: "Crear una meta",
    nextDays: (n: number) => `Próximos ${n} días`,
    nothingDue: "Nada vence la próxima semana.",
    periodPrefix: "Periodo",
    closed: "cerrado",
    daysLeftOfTotal: (remaining: number, total: number) =>
      `${remaining} de ${total} días restantes`,
    safeToSpendPerDay: "Disponible para gastar por día",
    leftForRest: "restante para el resto de este periodo",
    overThePlan: "sobre lo planeado para este periodo",
    setBudgetPrompt:
      "Define un presupuesto para este periodo y Cadence calcula cuánto puedes gastar cada día después de los compromisos.",
    setPeriodBudget: "Definir el presupuesto de este periodo",
    spent: "Gastado",
    percentOfBudget: (pct: number) => `${pct}% del presupuesto`,
    noBudget: "sin presupuesto",
    ofBudgeted: (amount: string) => `de ${amount} presupuestado`,
    committed: "Comprometido",
    itemsDueBefore: (count: number, date: string) =>
      `${count} elemento${count === 1 ? "" : "s"} vence${count === 1 ? "" : "n"} antes de ${date}`,
    income: "Ingresos",
    loggedThisPeriod: "registrado este periodo",
    of: (amount: string) => `de ${amount}`,
    reached: "Alcanzada",
    dueThisPeriod: "vence este periodo",
    periodsTo: (n: number, date: string) => `${n} periodos hasta ${date}`,
    perPayPeriod: "por periodo de pago",
    pace: "Ritmo",
    perPeriod: "por periodo",
    onTrackFor: (date: string) => `en camino para ${date}`,
    noContributionsYet: "Aún no hay aportes",
    contributionSuffix: " · aporte",
  },
```

- [ ] **Step 2: Translate `src/app/(app)/page.tsx`**

Add `import { getDictionary } from "@/lib/i18n";` and
`const t = getDictionary(context.language).dashboard;` after `const context
= await getAppContext();`. Replace:

- `<h2 className="text-base font-semibold">Goals</h2>` → `{t.goalsHeading}`
- `<Link href="/goals">All goals</Link>` → `{t.allGoals}`
- `title="No goals yet"` → `title={t.noGoalsTitle}`
- the `description="Track something..."` prop → `description={t.noGoalsDescription}`
- `<Link href="/goals">Create a goal</Link>` → `{t.createGoal}`
- `Next {UPCOMING_WINDOW_DAYS} days` → `{t.nextDays(UPCOMING_WINDOW_DAYS)}`
- `Nothing due in the next week.` → `{t.nothingDue}`
- Pass `t` down: `<GoalCard key={goal.id} goal={goal}
  displayCurrency={context.displayCurrency} t={t} />` and `<UpcomingList
  items={upcoming} today={context.today}
  displayCurrency={context.displayCurrency} t={t} />`.

- [ ] **Step 3: Translate `period-hero.tsx`**

Add a `t: Dictionary["dashboard"]` prop:

```tsx
import type { Dictionary } from "@/lib/i18n";

export function PeriodHero({
  summary,
  elapsed,
  t,
}: {
  summary: PeriodSummary;
  elapsed: number;
  t: Dictionary["dashboard"];
}) {
```

Replace each literal:

- `Period {period.period} · {period.longLabel}` → `{t.periodPrefix} {period.period} · {period.longLabel}`
- `summary.daysRemaining === 0 ? "closed" : \`${summary.daysRemaining} of ${period.totalDays} days left\`` → `summary.daysRemaining === 0 ? t.closed : t.daysLeftOfTotal(summary.daysRemaining, period.totalDays)`
- `Safe to spend per day` (both occurrences) → `{t.safeToSpendPerDay}`
- `left for the rest of this period` → `{t.leftForRest}` (keep the `<Money/>` element before it)
- `over the plan for this period` → `{t.overThePlan}`
- `Set a budget for this period and Cadence works out what you can spend each day after committed outflows.` → `{t.setBudgetPrompt}`
- `Set this period&rsquo;s budget` → `{t.setPeriodBudget}`
- `Spent` → `{t.spent}`
- `` `${Math.round(used * 100)}% of budget` `` → `t.percentOfBudget(Math.round(used * 100))`
- `no budget` → `{t.noBudget}`
- `` of {formatMoney(...)} budgeted `` → `{t.ofBudgeted(formatMoney(summary.periodBudget, currency))}`
- `Committed` → `{t.committed}`
- the "N item(s) due before ..." paragraph → `{t.itemsDueBefore(summary.committedItems.length, formatDayMonth(period.end))}`
- `Income` → `{t.income}`
- `logged this period` → `{t.loggedThisPeriod}`

Update `page.tsx`'s `<PeriodHero summary={summary} elapsed={elapsed} />`
call to `<PeriodHero summary={summary} elapsed={elapsed} t={t} />`.

- [ ] **Step 4: Translate `goal-card.tsx`**

Add a `t: Dictionary["dashboard"]` prop (same type as `period-hero.tsx`).
Replace:

- `` of {formatMoney(goal.targetAmount, ...)} `` → `{t.of(formatMoney(goal.targetAmount, goal.currency))}`
- `Reached` → `{t.reached}`
- `due this period` → `{t.dueThisPeriod}`
- `` `${goal.periodsLeft} periods to ${formatDate(goal.targetDate)}` `` → `t.periodsTo(goal.periodsLeft, formatDate(goal.targetDate))`
- `per pay period ·` → `{t.perPayPeriod} ·`
- `Pace` → `{t.pace}`
- `per period` → `{t.perPeriod}`
- `` ` · on track for ${formatDate(goal.projectedEnd)}` `` → `` ` · ${t.onTrackFor(formatDate(goal.projectedEnd))}` ``
- `No contributions yet` → `{t.noContributionsYet}`

- [ ] **Step 5: Translate `upcoming-list.tsx`**

Add a `t: Dictionary["dashboard"]` prop. Replace:

- `isContribution ? " · contribution" : ""` → `isContribution ? t.contributionSuffix : ""`

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run `npm run dev`, view `/` (Dashboard) in English, switch to Spanish via
the header switcher, confirm every label above is translated, no English
leaks, no layout break (check the "Committed"/"Income" stat column
especially — Spanish "Comprometido" is longer than "Committed").

- [ ] **Step 8: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/page.tsx src/components/dashboard
git commit -m "Translate the dashboard page"
```

---

## Task 4: Transactions & CSV import

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `transactions` section)
- Modify: `src/app/(app)/transactions/page.tsx`
- Modify: `src/components/transactions/transaction-table.tsx`
- Modify: `src/components/transactions/transaction-dialog.tsx`
- Modify: `src/components/transactions/transfer-dialog.tsx`
- Modify: `src/components/transactions/transaction-filters.tsx`
- Modify: `src/app/(app)/transactions/import/page.tsx`
- Modify: `src/components/import/csv-importer.tsx`
- Modify: `src/server/actions/transactions.ts`, `src/server/actions/import.ts`

**Interfaces:**
- Consumes: `getDictionary`, `t.common.*`, `SourceBadge` new props (Task 2)

- [ ] **Step 1: Add the `transactions` dictionary section**

English (`src/lib/i18n/en.ts`):

```ts
  transactions: {
    title: "Transactions",
    recordsSummary: (total: number, out: string, income: string) =>
      `${total} record${total === 1 ? "" : "s"} · ${out} out, ${income} in`,
    importCsv: "Import CSV",
    transfer: "Transfer",
    new: "New",
    addAccountFirstTitle: "Add an account first",
    needAccountDescription: "Transactions belong to an account, so start there.",
    goToAccounts: "Go to accounts",
    nothingHereTitle: "Nothing here yet",
    noMatchFilters: "No transactions match these filters.",
    pageOf: (page: number, count: number, size: number) =>
      `Page ${page} of ${count} · ${size} per page`,
    previous: "Previous",
    next: "Next",
    colDate: "Date",
    colDescription: "Description",
    colAccount: "Account",
    colSource: "Source",
    colAmount: "Amount",
    rowActionsAria: "Row actions",
    transferTo: (name: string) => `Transfer to ${name}`,
    transferFrom: (name: string) => `Transfer from ${name}`,
    anotherAccount: "another account",
    uncategorized: "Uncategorized",
    deleteTransferTitle: "Delete this transfer?",
    deleteTransferDescription: "Both sides of the transfer are removed together.",
    deleteTransactionTitle: "Delete this transaction?",
    deleteTransactionDescription: "This cannot be undone.",
    editTransaction: "Edit transaction",
    newTransaction: "New transaction",
    manualDescription: "Logged manually - source stays as Manual.",
    saveChanges: "Save changes",
    addTransaction: "Add transaction",
    notePlaceholder: "What was it for?",
    editTransfer: "Edit transfer",
    moveMoney: "Move money",
    transferDescription:
      "Between your own accounts. Transfers never count as income or spending.",
    recordTransfer: "Record transfer",
    from: "From",
    to: "To",
    searchNotes: "Search notes",
    allAccounts: "All accounts",
    allCategories: "All categories",
    allTypes: "All types",
    allSources: "All sources",
    accountPlaceholder: "Account",
    categoryPlaceholder: "Category",
    typePlaceholder: "Type",
    sourcePlaceholder: "Source",
    fromDateAria: "From date",
    toDateAria: "To date",
    toSeparator: "to",
    clear: "Clear",
    backToTransactions: "Transactions",
    importCsvTitle: "Import CSV",
    importCsvDescription:
      "Map three columns, check the preview, then commit. Imported rows are tagged with the CSV source.",
    importedNeedAccount: "Imported rows need an account to land in.",
    transactionUpdated: "Transaction updated",
    transactionAdded: "Transaction added",
    transactionDeleted: "Transaction deleted",
    transferUpdated: "Transfer updated",
    transferRecorded: "Transfer recorded",
    signSigned: "Signed - negative is spending",
    signExpenses: "Every row is spending",
    signIncome: "Every row is income",
    step1: "Pick a file",
    step2: "Map the columns",
    step3: "Review and import",
    rowsRead: (name: string, count: number) =>
      `${name} · ${count} row${count === 1 ? "" : "s"} read`,
    csvHint:
      "A plain CSV export from your bank. Nothing is written until you review the preview below.",
    firstRowHeader: "First row is a header",
    dateColumn: "Date column",
    amountColumn: "Amount column",
    descriptionColumn: "Description column",
    dateFormat: "Date format",
    dateFormatHint: "How dates are written in your file",
    amountConvention: "Amount convention",
    importInto: "Import into account",
    categoryForEveryRow: "Category for every row",
    noCategory: "No category",
    column: (n: number) => `Column ${n}`,
    rowsReady: (count: number) => `${count} row${count === 1 ? "" : "s"} ready`,
    skippedSuffix: "skipped because the date or amount could not be read",
    unreadable: "unreadable",
    skipped: "skipped",
    showingFirst: (n: number, total: number) =>
      `Showing the first ${n} of ${total} rows.`,
    importCount: (n: number) => `Import ${n} transaction${n === 1 ? "" : "s"}`,
    imported: (count: number) => `Imported ${count} transaction${count === 1 ? "" : "s"}`,
    invalidDateRow: "A row has an invalid date",
    couldNotReadRows: "Could not read the parsed rows",
    accountNoLongerExists: "That account no longer exists",
    transactionNoLongerExists: "That transaction no longer exists",
    transferNoLongerExists: "That transfer no longer exists",
    editFromTransferForm: "Edit this transfer from the transfer form",
    nothingToDelete: "Nothing to delete",
  },
```

Spanish (`src/lib/i18n/es.ts`), mirroring every key:

```ts
  transactions: {
    title: "Transacciones",
    recordsSummary: (total: number, out: string, income: string) =>
      `${total} registro${total === 1 ? "" : "s"} · ${out} gastado, ${income} recibido`,
    importCsv: "Importar CSV",
    transfer: "Transferencia",
    new: "Nueva",
    addAccountFirstTitle: "Primero agrega una cuenta",
    needAccountDescription: "Las transacciones pertenecen a una cuenta, así que empieza por ahí.",
    goToAccounts: "Ir a cuentas",
    nothingHereTitle: "Todavía no hay nada aquí",
    noMatchFilters: "Ninguna transacción coincide con estos filtros.",
    pageOf: (page: number, count: number, size: number) =>
      `Página ${page} de ${count} · ${size} por página`,
    previous: "Anterior",
    next: "Siguiente",
    colDate: "Fecha",
    colDescription: "Descripción",
    colAccount: "Cuenta",
    colSource: "Fuente",
    colAmount: "Monto",
    rowActionsAria: "Acciones de la fila",
    transferTo: (name: string) => `Transferencia a ${name}`,
    transferFrom: (name: string) => `Transferencia desde ${name}`,
    anotherAccount: "otra cuenta",
    uncategorized: "Sin categoría",
    deleteTransferTitle: "¿Eliminar esta transferencia?",
    deleteTransferDescription: "Ambos lados de la transferencia se eliminan juntos.",
    deleteTransactionTitle: "¿Eliminar esta transacción?",
    deleteTransactionDescription: "Esto no se puede deshacer.",
    editTransaction: "Editar transacción",
    newTransaction: "Nueva transacción",
    manualDescription: "Registrado manualmente: la fuente queda como Manual.",
    saveChanges: "Guardar cambios",
    addTransaction: "Agregar transacción",
    notePlaceholder: "¿Para qué fue?",
    editTransfer: "Editar transferencia",
    moveMoney: "Mover dinero",
    transferDescription:
      "Entre tus propias cuentas. Las transferencias nunca cuentan como ingreso ni gasto.",
    recordTransfer: "Registrar transferencia",
    from: "Desde",
    to: "Hacia",
    searchNotes: "Buscar notas",
    allAccounts: "Todas las cuentas",
    allCategories: "Todas las categorías",
    allTypes: "Todos los tipos",
    allSources: "Todas las fuentes",
    accountPlaceholder: "Cuenta",
    categoryPlaceholder: "Categoría",
    typePlaceholder: "Tipo",
    sourcePlaceholder: "Fuente",
    fromDateAria: "Fecha desde",
    toDateAria: "Fecha hasta",
    toSeparator: "a",
    clear: "Limpiar",
    backToTransactions: "Transacciones",
    importCsvTitle: "Importar CSV",
    importCsvDescription:
      "Asigna tres columnas, revisa la vista previa y confirma. Las filas importadas se etiquetan con la fuente CSV.",
    importedNeedAccount: "Las filas importadas necesitan una cuenta donde registrarse.",
    transactionUpdated: "Transacción actualizada",
    transactionAdded: "Transacción agregada",
    transactionDeleted: "Transacción eliminada",
    transferUpdated: "Transferencia actualizada",
    transferRecorded: "Transferencia registrada",
    signSigned: "Con signo: negativo es gasto",
    signExpenses: "Cada fila es un gasto",
    signIncome: "Cada fila es un ingreso",
    step1: "Elige un archivo",
    step2: "Mapea las columnas",
    step3: "Revisa e importa",
    rowsRead: (name: string, count: number) =>
      `${name} · ${count} fila${count === 1 ? "" : "s"} leída${count === 1 ? "" : "s"}`,
    csvHint:
      "Una exportación CSV simple de tu banco. No se escribe nada hasta que revises la vista previa.",
    firstRowHeader: "La primera fila es un encabezado",
    dateColumn: "Columna de fecha",
    amountColumn: "Columna de monto",
    descriptionColumn: "Columna de descripción",
    dateFormat: "Formato de fecha",
    dateFormatHint: "Cómo se escriben las fechas en tu archivo",
    amountConvention: "Convención de montos",
    importInto: "Importar a la cuenta",
    categoryForEveryRow: "Categoría para cada fila",
    noCategory: "Sin categoría",
    column: (n: number) => `Columna ${n}`,
    rowsReady: (count: number) => `${count} fila${count === 1 ? "" : "s"} lista${count === 1 ? "" : "s"}`,
    skippedSuffix: "omitida(s) porque no se pudo leer la fecha o el monto",
    unreadable: "no se pudo leer",
    skipped: "omitida",
    showingFirst: (n: number, total: number) =>
      `Mostrando las primeras ${n} de ${total} filas.`,
    importCount: (n: number) => `Importar ${n} transacción${n === 1 ? "" : "es"}`,
    imported: (count: number) => `${count} transacción${count === 1 ? "" : "es"} importada${count === 1 ? "" : "s"}`,
    invalidDateRow: "Una fila tiene una fecha inválida",
    couldNotReadRows: "No se pudieron leer las filas procesadas",
    accountNoLongerExists: "Esa cuenta ya no existe",
    transactionNoLongerExists: "Esa transacción ya no existe",
    transferNoLongerExists: "Esa transferencia ya no existe",
    editFromTransferForm: "Edita esta transferencia desde el formulario de transferencias",
    nothingToDelete: "Nada que eliminar",
  },
```

- [ ] **Step 2: Translate `src/app/(app)/transactions/page.tsx`**

Add `const t = getDictionary(context.language).transactions;` and
`const common = getDictionary(context.language).common;` after `const
context = await getAppContext();`. Replace:

- `title="Transactions"` → `title={t.title}`
- the `description={...}` template literal → `description={t.recordsSummary(result.total, formatMoney(totals.expense, context.displayCurrency), formatMoney(totals.income, context.displayCurrency))}`
- `Import CSV` → `{t.importCsv}`
- `Transfer` (button text) → `{t.transfer}`
- `New` (button text) → `{t.new}`
- `title="Add an account first"` → `title={t.addAccountFirstTitle}`
- `description="Transactions belong to an account, so start there."` → `description={t.needAccountDescription}`
- `Go to accounts` → `{t.goToAccounts}`
- `title="Nothing here yet"` → `title={t.nothingHereTitle}`
- `description="No transactions match these filters."` → `description={t.noMatchFilters}`
- the `Page {result.page} of ...` paragraph → `{t.pageOf(result.page, result.pageCount, PAGE_SIZE)}`
- `Previous` (both branches) → `{t.previous}`
- `Next` (both branches) → `{t.next}`
- Pass `t` and `common` to `<TransactionTable ... t={t} common={common} />`,
  `<TransactionDialog ... t={t} common={common} />`, `<TransferDialog ...
  t={t} common={common} />`, `<TransactionFilters ... t={t} />`.

- [ ] **Step 3: Translate `transaction-table.tsx`**

Add `t: Dictionary["transactions"]` and `common: Dictionary["common"]`
props. Replace:

- `Date`/`Description`/`Account`/`Source`/`Amount` table headers → `{t.colDate}` etc.
- `aria-label="Row actions"` → `aria-label={t.rowActionsAria}`
- the transfer-description template literal → use `row.transferDirection === "OUT" ? t.transferTo(row.counterpartAccountName ?? t.anotherAccount) : t.transferFrom(row.counterpartAccountName ?? t.anotherAccount)`
- `row.categoryName ?? "Uncategorized"` → `row.categoryName ?? t.uncategorized`
- `Edit` → `{common.edit}`
- `Delete` → `{common.delete}`
- `title={deleting.transferId ? "Delete this transfer?" : "Delete this transaction?"}` → `title={deleting.transferId ? t.deleteTransferTitle : t.deleteTransactionTitle}`
- the matching `description` → `t.deleteTransferDescription` / `t.deleteTransactionDescription`
- Add to the `<ConfirmDelete>` call: `confirmLabel={common.delete}
  keepLabel={common.keepIt} deletedMessage={common.deleted}`
- Update `<SourceBadge source={row.source} isTransfer={row.type ===
  "TRANSFER"} />` → add `labels={common.sourceLabels}
  transferLabel={t.transfer}` (per Task 2 Step 2's new `SourceBadge` props).
- Pass `t`/`common` down to the nested `<TransactionDialog>` and
  `<TransferDialog>` calls in this file's edit branches.

- [ ] **Step 4: Translate `transaction-dialog.tsx`**

Add `t: Dictionary["transactions"]` and `common: Dictionary["common"]`
props. Replace:

- `title={editing ? "Edit transaction" : "New transaction"}` → `t.editTransaction` / `t.newTransaction`
- `description={editing ? undefined : "Logged manually - source stays as Manual."}` → `editing ? undefined : t.manualDescription`
- `submitLabel={editing ? "Save changes" : "Add transaction"}` → `t.saveChanges` / `t.addTransaction`
- add `cancelLabel={common.cancel} savedMessage={editing ? t.transactionUpdated : t.transactionAdded}`
- `label="Type"` → `label={common.type}`
- `labels={TRANSACTION_TYPE_LABELS}` → `labels={common.transactionTypeLabels}` (remove the now-unused `TRANSACTION_TYPE_LABELS` import from `@/lib/labels`, keep nothing else needed from it here)
- `label="Date"` → `label={common.date}`
- `label="Amount"` → `label={common.amount}`
- `label="Currency"` → `label={common.currency}`
- `label="Account"` → `label={common.account}` — **note**: `common` does not
  yet have `account`; add `account: "Account" / "Cuenta"` to `common` in
  this task's Step 1 dictionary additions (add it to both `en.ts` and
  `es.ts`'s `common` block).
- `label="Category"` → `label={common.category}`
- `label="Note"` → `label={common.note}`
- `placeholder="What was it for?"` → `placeholder={t.notePlaceholder}`

- [ ] **Step 5: Translate `transfer-dialog.tsx`**

Add `t: Dictionary["transactions"]` and `common: Dictionary["common"]`
props. Replace:

- `title={editing ? "Edit transfer" : "Move money"}` → `t.editTransfer` / `t.moveMoney`
- `description="Between your own accounts. Transfers never count as income or spending."` → `t.transferDescription`
- `submitLabel={editing ? "Save changes" : "Record transfer"}` → `t.saveChanges` / `t.recordTransfer`
- add `cancelLabel={common.cancel} savedMessage={editing ? t.transferUpdated : t.transferRecorded}`
- `label="From"` → `label={t.from}`
- `label="To"` → `label={t.to}`
- `label="Amount"` → `label={common.amount}`
- `label="Currency"` → `label={common.currency}`
- `label="Date"` → `label={common.date}`
- `label="Note"` → `label={common.note}`
- `placeholder="Optional"` → `placeholder={common.optional}`

- [ ] **Step 6: Translate `transaction-filters.tsx`**

Add a `t: Dictionary["transactions"]` prop. Replace:

- `placeholder="Search notes"` and `aria-label="Search notes"` → `t.searchNotes`
- `placeholder="Account"` → `t.accountPlaceholder`
- `All accounts` → `{t.allAccounts}`
- `placeholder="Category"` → `t.categoryPlaceholder`
- `All categories` → `{t.allCategories}`
- `Uncategorized` → `{t.uncategorized}`
- `placeholder="Type"` → `t.typePlaceholder`
- `All types` → `{t.allTypes}`
- `import { ... TRANSACTION_TYPE_LABELS ... } from "@/lib/labels"` usage for
  `{TRANSACTION_TYPE_LABELS[type]}` → use a `common: Dictionary["common"]`
  prop (add it) and `{common.transactionTypeLabels[type]}`
- `placeholder="Source"` → `t.sourcePlaceholder`
- `All sources` → `{t.allSources}`
- `SOURCE_LABELS[source]` → `common.sourceLabels[source]`
- `aria-label="From date"` → `t.fromDateAria`
- `aria-label="To date"` → `t.toDateAria`
- `to` (the standalone separator span) → `{t.toSeparator}`
- `Clear` → `{t.clear}`

Update the page's call site (`transaction-filters.tsx`'s caller in
`page.tsx`, Step 2) to pass `t={t}` and add `common={common}`.

- [ ] **Step 7: Translate `src/app/(app)/transactions/import/page.tsx`**

Add `const t = getDictionary(context.language).transactions;`. Replace:

- `Transactions` (link text) → `{t.backToTransactions}`
- `title="Import CSV"` → `title={t.importCsvTitle}`
- `description="Map three columns..."` → `description={t.importCsvDescription}`
- `title="Add an account first"` → `title={t.addAccountFirstTitle}`
- `description="Imported rows need an account to land in."` → `description={t.importedNeedAccount}`
- Pass `t` to `<CsvImporter accounts={accounts} categories={categories}
  defaultCurrency={...} t={t} />`.

- [ ] **Step 8: Translate `csv-importer.tsx`**

Add a `t: Dictionary["transactions"]` prop. Replace every literal listed in
the dictionary (Step 1) at its corresponding JSX/object location:
`SIGN_LABELS` object values → build from `t.signSigned`/`t.signExpenses`/
`t.signIncome` inside the component (move `SIGN_LABELS` from module scope
into the component body as `const SIGN_LABELS: Record<SignMode, string> =
{ signed: t.signSigned, expenses: t.signExpenses, income: t.signIncome };`),
`Pick a file`/`Map the columns`/`Review and import` → `t.step1`/`t.step2`/
`t.step3`, the "N rows read" paragraph → `t.rowsRead(fileName, rows.length)`,
the CSV hint paragraph → `t.csvHint`, `First row is a header` → `t.firstRowHeader`,
`Date column`/`Amount column`/`Description column` → `t.dateColumn`/
`t.amountColumn`/`t.descriptionColumn`, `Date format` → `t.dateFormat`,
`How dates are written in your file` → `t.dateFormatHint`, `Amount
convention` → `t.amountConvention`, `Import into account` → `t.importInto`,
`Currency` → (import `common` too and use `common.currency`), `Category for
every row` → `t.categoryForEveryRow`, `No category` → `t.noCategory`,
`` `Column ${index + 1}` `` → `t.column(index + 1)`, the "N rows ready"
paragraph → `t.rowsReady(validRows.length)`, the skipped-suffix text →
`t.skippedSuffix`, table headers `Date`/`Description`/`Type`/`Amount` →
`common.date`/`t.colDescription`/`common.type`/`common.amount`,
`unreadable` → `t.unreadable`, `row.note || "-"` (no change, `-` stays),
`skipped` → `t.skipped`, the "Showing the first N of M rows." paragraph →
`t.showingFirst(PREVIEW_ROWS, parsed.length)`, the submit button content →
`t.importCount(validRows.length)`.

Add `common: Dictionary["common"]` as a second prop since `Currency`,
`Date`, `Type`, `Amount` reuse shared keys. Update the caller in Step 7 to
pass `common={getDictionary(context.language).common}` as well.

- [ ] **Step 9: Translate `transactions.ts` and `import.ts` action messages**

Edit `src/server/actions/transactions.ts` and `src/server/actions/import.ts`.
Both already fetch `locale` from Task 2 Step 5. Add
`const t = getDictionary(locale).transactions;` and replace:

`transactions.ts`:
- `"That transaction no longer exists"` (x2 occurrences) → `t.transactionNoLongerExists`
- `"Edit this transfer from the transfer form"` → `t.editFromTransferForm`
- `id ? "Transaction updated" : "Transaction added"` → `id ? t.transactionUpdated : t.transactionAdded`
- `"Nothing to delete"` → `t.nothingToDelete`
- `"Transaction deleted"` → `t.transactionDeleted`
- `"That transfer no longer exists"` → `t.transferNoLongerExists`
- `"Transfer updated"` → `t.transferUpdated`
- `"Transfer recorded"` → `t.transferRecorded`

`import.ts`:
- `"Could not read the parsed rows"` → `t.couldNotReadRows`
- `"That account no longer exists"` → `t.accountNoLongerExists`
- `"A row has an invalid date"` → `t.invalidDateRow`
- the `` `Imported ${result.count} transaction${...}` `` template → `t.imported(result.count)`

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 11: Manual verification**

Run `npm run dev`. With at least one account created (create one via
Accounts if none exists — fine to use English UI for that setup step),
visit `/transactions`, switch to Spanish, confirm the page, the New/Transfer
dialogs, filters, and CSV import flow (`/transactions/import`) all show
Spanish text with no leftover English and no broken layout. Add and delete
a transaction in Spanish to confirm the toast messages are translated.

- [ ] **Step 12: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/transactions src/components/transactions \
  src/components/import/csv-importer.tsx src/server/actions/transactions.ts \
  src/server/actions/import.ts
git commit -m "Translate transactions and CSV import"
```

---

## Task 5: Accounts

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `accounts` section)
- Modify: `src/app/(app)/accounts/page.tsx`
- Modify: `src/components/accounts/account-row-actions.tsx`
- Modify: `src/components/accounts/account-dialog.tsx`
- Modify: `src/app/(app)/accounts/[id]/page.tsx`
- Modify: `src/server/actions/accounts.ts`

**Interfaces:**
- Consumes: `getDictionary`, `t.common.*` including `common.accountTypeLabels`, `common.account` (Task 4 added this key)

- [ ] **Step 1: Add the `accounts` dictionary section**

English:

```ts
  accounts: {
    title: "Accounts",
    acrossAccounts: (net: string, count: number) =>
      `${net} across ${count} account${count === 1 ? "" : "s"}`,
    whereMoneySits: "Where your money sits.",
    newAccount: "New account",
    noAccountsTitle: "No accounts yet",
    noAccountsDescription:
      "Add the accounts you actually use - checking, savings, cash - and everything else hangs off them.",
    addFirstAccount: "Add your first account",
    colType: "Type",
    colActivity: "Activity",
    colBalance: "Balance",
    transactionCount: (n: number) => `${n} transaction${n === 1 ? "" : "s"}`,
    actionsFor: (name: string) => `Actions for ${name}`,
    deleteAccountTitle: (name: string) => `Delete ${name}?`,
    transactionsGoWithIt: (n: number) =>
      `Its ${n} transaction${n === 1 ? "" : "s"} go with it, including both sides of any transfers.`,
    noTransactions: "This account has no transactions.",
    editAccount: "Edit account",
    newAccountTitle: "New account",
    addAccount: "Add account",
    namePlaceholder: "Everyday checking",
    accountsBreadcrumb: "Accounts",
    incomeIn: "Income in",
    spendingOut: "Spending out",
    netTransfers: "Net transfers",
    inOut: (inAmount: string, outAmount: string) => `${inAmount} in · ${outAmount} out`,
    noActivityTitle: "No activity yet",
    noActivityDescription:
      "Transactions logged against this account show up here with a running balance.",
    addTransaction: "Add a transaction",
    colChange: "Change",
    accountUpdated: "Account updated",
    accountAdded: "Account added",
    accountDeleted: "Account deleted",
  },
```

Spanish:

```ts
  accounts: {
    title: "Cuentas",
    acrossAccounts: (net: string, count: number) =>
      `${net} en ${count} cuenta${count === 1 ? "" : "s"}`,
    whereMoneySits: "Dónde está tu dinero.",
    newAccount: "Nueva cuenta",
    noAccountsTitle: "Aún no hay cuentas",
    noAccountsDescription:
      "Agrega las cuentas que realmente usas: corriente, ahorros, efectivo, y todo lo demás se conecta a ellas.",
    addFirstAccount: "Agrega tu primera cuenta",
    colType: "Tipo",
    colActivity: "Actividad",
    colBalance: "Saldo",
    transactionCount: (n: number) => `${n} transacción${n === 1 ? "" : "es"}`,
    actionsFor: (name: string) => `Acciones de ${name}`,
    deleteAccountTitle: (name: string) => `¿Eliminar ${name}?`,
    transactionsGoWithIt: (n: number) =>
      `Sus ${n} transacción${n === 1 ? "" : "es"} se eliminan también, incluidos ambos lados de cualquier transferencia.`,
    noTransactions: "Esta cuenta no tiene transacciones.",
    editAccount: "Editar cuenta",
    newAccountTitle: "Nueva cuenta",
    addAccount: "Agregar cuenta",
    namePlaceholder: "Cuenta corriente diaria",
    accountsBreadcrumb: "Cuentas",
    incomeIn: "Ingresos",
    spendingOut: "Gastos",
    netTransfers: "Transferencias netas",
    inOut: (inAmount: string, outAmount: string) => `${inAmount} entrada · ${outAmount} salida`,
    noActivityTitle: "Aún no hay actividad",
    noActivityDescription:
      "Las transacciones registradas en esta cuenta aparecen aquí con un saldo acumulado.",
    addTransaction: "Agregar una transacción",
    colChange: "Cambio",
    accountUpdated: "Cuenta actualizada",
    accountAdded: "Cuenta agregada",
    accountDeleted: "Cuenta eliminada",
  },
```

Also add `account: "Account"` / `account: "Cuenta"` to `common` if not
already added in Task 4 Step 4 — verify it's present before adding a
duplicate key.

- [ ] **Step 2: Translate `src/app/(app)/accounts/page.tsx`**

Add `const t = getDictionary(context.language).accounts;` and `const common
= getDictionary(context.language).common;`. Replace:

- `title="Accounts"` → `title={t.title}`
- the `description` ternary → `accounts.length > 0 ? t.acrossAccounts(formatMoney(net, context.displayCurrency), accounts.length) : t.whereMoneySits`
- `New account` → `{t.newAccount}`
- `title="No accounts yet"` → `title={t.noAccountsTitle}`
- `description="Add the accounts..."` → `description={t.noAccountsDescription}`
- `Add your first account` → `{t.addFirstAccount}`
- `Account` (column header) → `{common.account}`
- `Type` → `{t.colType}`
- `Activity` → `{t.colActivity}`
- `Balance` → `{t.colBalance}`
- `labelFor(ACCOUNT_TYPE_LABELS, account.type)` → `labelFor(common.accountTypeLabels, account.type)` (remove the now-unused `ACCOUNT_TYPE_LABELS` import, keep `labelFor` import from `@/lib/labels`)
- the `{account.transactionCount} transaction{...}` block → `{t.transactionCount(account.transactionCount)}`
- Pass `t={t}` and `common={common}` to `<AccountDialog>` and `<AccountRowActions account={account} t={t} common={common} />`.

- [ ] **Step 3: Translate `account-row-actions.tsx`**

Add `t: Dictionary["accounts"]` and `common: Dictionary["common"]` props.
Replace:

- `` `Actions for ${account.name}` `` → `t.actionsFor(account.name)`
- `Edit` → `{common.edit}`
- `Delete` → `{common.delete}`
- `` `Delete ${account.name}?` `` → `t.deleteAccountTitle(account.name)`
- the transaction-count description ternary → `account.transactionCount > 0 ? t.transactionsGoWithIt(account.transactionCount) : t.noTransactions`
- Add `confirmLabel={common.delete} keepLabel={common.keepIt}
  deletedMessage={t.accountDeleted}` to `<ConfirmDelete>`.
- Pass `t={t}` and `common={common}` to the nested `<AccountDialog>`.

- [ ] **Step 4: Translate `account-dialog.tsx`**

Add `t: Dictionary["accounts"]` and `common: Dictionary["common"]` props.
Replace:

- `title={editing ? "Edit account" : "New account"}` → `t.editAccount` / `t.newAccountTitle`
- `submitLabel={editing ? "Save changes" : "Add account"}` → (reuse `transactions.saveChanges`? No — keep local: add `saveChanges: "Save changes"` / `"Guardar cambios"` to the `accounts` dictionary section too, since this dialog only has `t: Dictionary["accounts"]` in scope, not `transactions`. Add this key to both `en.ts` and `es.ts`'s `accounts` block in Step 1.) → `t.saveChanges` / `t.addAccount`
- add `cancelLabel={common.cancel} savedMessage={editing ? t.accountUpdated : t.accountAdded}`
- `label="Name"` → `label={common.name}`
- `placeholder="Everyday checking"` → `placeholder={t.namePlaceholder}`
- `label="Type"` → `label={common.type}`
- `labels={ACCOUNT_TYPE_LABELS}` → `labels={common.accountTypeLabels}` (remove the `ACCOUNT_TYPE_LABELS` import, keep `ACCOUNT_TYPES`)
- `label="Currency"` → `label={common.currency}`

- [ ] **Step 5: Translate `src/app/(app)/accounts/[id]/page.tsx`**

Add `const t = getDictionary(context.language).accounts;` and `const common
= getDictionary(context.language).common;`. Replace:

- `Accounts` (breadcrumb link text) → `{t.accountsBreadcrumb}`
- `description={...}` → `` description={`${labelFor(common.accountTypeLabels, account.type)} · ${account.currency}`} ``
- `Edit` (button) → `{common.edit}`
- Pass `t`/`common` to `<AccountDialog>`.
- `label="Balance"` → `label={common.account /* no */}` — actually this is
  the `<Stat label="Balance" .../>` — add `balance: "Balance"` /
  `"Saldo"` to the `accounts` dictionary (Step 1) and use `label={t.balance}`.
- the hint ternary's transaction-count branch → `t.transactionCount(rows.length)`
- `label="Income in"` → `label={t.incomeIn}`
- `label="Spending out"` → `label={t.spendingOut}`
- `label="Net transfers"` → `label={t.netTransfers}`
- the `hint` template for transfers → `t.inOut(formatMoney(totals.transfersIn, account.currency), formatMoney(totals.transfersOut, account.currency))`
- `title="No activity yet"` → `title={t.noActivityTitle}`
- `description="Transactions logged..."` → `description={t.noActivityDescription}`
- `Add a transaction` → `{t.addTransaction}`
- `Date`/`Description`/`Source` headers → `{common.date}`/(add
  `description: "Description"` / `"Descripción"` to `common` — reuse
  pattern: check if already added by Task 4; if `t.colDescription` exists
  only under `transactions`, add a `common.description` key instead to
  avoid cross-section coupling. Add it to `common` in this task's Step 1.)/
  reuse `common.sourceLabels`-adjacent — actually "Source" the column header
  is generic text, add `common.source: "Source"` / `"Fuente"` too.
- `Change` → `{t.colChange}`
- `Balance` (second column header) → `{t.balance}`
- the transfer-description template (`Transfer ${...} to/from ...`) →
  reuse the same pattern as `transaction-table.tsx` in Task 4: add
  `transferTo`/`transferFrom`/`anotherAccount` to the `accounts` section too
  (duplicate small keys are fine — these are two independent dictionary
  sections; add the three keys to `accounts` in Step 1 mirroring
  `transactions`'s).
- `row.categoryName ?? "Uncategorized"` → `row.categoryName ?? common.uncategorized` (add `uncategorized: "Uncategorized"` / `"Sin categoría"` to `common` in Step 1, and prefer it over the per-section duplicates added earlier in Task 4 — **reconcile**: change Task 4's `t.uncategorized` references to `common.uncategorized` instead, since it's clearly a cross-cutting term. Since Task 4 already shipped by the time this task runs, this task only needs to add `common.uncategorized` and use it here; leaving Task 4's local `transactions.uncategorized` key as a harmless duplicate is acceptable and does not need to be revisited.)
- Update the `<SourceBadge>` call here to pass `labels={common.sourceLabels}
  transferLabel={t.transfer ?? "Transfer"}` — add a `transfer: "Transfer"` /
  `"Transferencia"` key to the `accounts` dictionary section too (Step 1).

- [ ] **Step 6: Translate `accounts.ts` action messages**

Edit `src/server/actions/accounts.ts`. It already fetches `locale` (Task 2
Step 5). Add `const t = getDictionary(locale).accounts;` and replace:

- `id ? "Account updated" : "Account added"` → `id ? t.accountUpdated : t.accountAdded`
- `"Nothing to delete"` → reuse `getDictionary(locale).transactions.nothingToDelete`, or simpler: add a `nothingToDelete: "Nothing to delete"` / `"Nada que eliminar"` key to `common` in Step 1 and use `getDictionary(locale).common.nothingToDelete` here and update Task 4's `transactions.ts` to use the same shared key instead of its local one (optional cleanup; not required — leaving both is harmless).
- `"Account deleted"` → `t.accountDeleted`

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run `npm run dev`. Visit `/accounts` and an account detail page in Spanish;
create, edit, and delete an account; confirm every label, dialog, and toast
is translated with no leftover English.

- [ ] **Step 9: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/accounts src/components/accounts \
  src/server/actions/accounts.ts
git commit -m "Translate accounts"
```

---

## Task 6: Budgets

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `budgets` section)
- Modify: `src/app/(app)/budgets/page.tsx`
- Modify: `src/components/budgets/budget-amount-form.tsx`
- Modify: `src/server/actions/budgets.ts`

- [ ] **Step 1: Add the `budgets` dictionary section**

English:

```ts
  budgets: {
    title: "Budgets",
    description:
      "Set per pay period. The overall budget drives safe to spend; category budgets track where it goes.",
    copyLastPeriod: "Copy last period",
    backToNow: "Back to now",
    overallBudget: "Overall budget",
    overallBudgetForPeriod: "Overall budget for this period",
    noOverallSet: (total: string) =>
      `No overall budget set. Category budgets total ${total} and are used instead.`,
    clearToRemove: "Clear the field to remove the overall budget.",
    spentOf: (spent: string, total: string) => `${spent} spent of ${total}`,
    committed: "Committed",
    recurringStillToCome: (n: number) =>
      `${n} recurring item${n === 1 ? "" : "s"} still to come`,
    safeToSpend: "Safe to spend",
    perDay: (amount: string, days: number) => `${amount} a day for ${days} day${days === 1 ? "" : "s"}`,
    forWholePeriod: "for the whole period",
    colCategory: "Category",
    colProgress: "Progress",
    colSpent: "Spent",
    colBudget: "Budget",
    noBudget: "no budget",
    uncategorized: "Uncategorized",
    categoryBudgetAria: (name: string) => `${name} budget`,
    saveAria: (label: string) => `Save ${label}`,
    budgetCleared: "Budget cleared",
    budgetSaved: "Budget saved",
    pickPeriodFirst: "Pick a period first",
    noBudgetToCopy: "The previous period has no budget to copy",
    everyBudgetAlreadyCopied: "This period already has every budget from last period",
    copiedForward: (n: number) => `Copied ${n} budget${n === 1 ? "" : "s"} forward`,
  },
```

Spanish:

```ts
  budgets: {
    title: "Presupuestos",
    description:
      "Se definen por periodo de pago. El presupuesto general determina lo disponible para gastar; los presupuestos por categoría muestran en qué se va.",
    copyLastPeriod: "Copiar periodo anterior",
    backToNow: "Volver a ahora",
    overallBudget: "Presupuesto general",
    overallBudgetForPeriod: "Presupuesto general de este periodo",
    noOverallSet: (total: string) =>
      `No hay presupuesto general definido. Se usa el total de los presupuestos por categoría (${total}).`,
    clearToRemove: "Vacía el campo para eliminar el presupuesto general.",
    spentOf: (spent: string, total: string) => `${spent} gastado de ${total}`,
    committed: "Comprometido",
    recurringStillToCome: (n: number) =>
      `${n} elemento${n === 1 ? "" : "s"} recurrente${n === 1 ? "" : "s"} por llegar`,
    safeToSpend: "Disponible para gastar",
    perDay: (amount: string, days: number) => `${amount} al día durante ${days} día${days === 1 ? "" : "s"}`,
    forWholePeriod: "para todo el periodo",
    colCategory: "Categoría",
    colProgress: "Progreso",
    colSpent: "Gastado",
    colBudget: "Presupuesto",
    noBudget: "sin presupuesto",
    uncategorized: "Sin categoría",
    categoryBudgetAria: (name: string) => `Presupuesto de ${name}`,
    saveAria: (label: string) => `Guardar ${label}`,
    budgetCleared: "Presupuesto eliminado",
    budgetSaved: "Presupuesto guardado",
    pickPeriodFirst: "Elige primero un periodo",
    noBudgetToCopy: "El periodo anterior no tiene presupuesto para copiar",
    everyBudgetAlreadyCopied: "Este periodo ya tiene todos los presupuestos del periodo anterior",
    copiedForward: (n: number) => `Se copiaron ${n} presupuesto${n === 1 ? "" : "s"}`,
  },
```

- [ ] **Step 2: Translate `src/app/(app)/budgets/page.tsx`**

Add `const t = getDictionary(context.language).budgets;`. Replace:

- `title="Budgets"` → `title={t.title}`
- `description="Set per pay period..."` → `description={t.description}`
- `Copy last period` → `{t.copyLastPeriod}`
- `Back to now` → `{t.backToNow}`
- `Overall budget` (CardTitle) → `{t.overallBudget}`
- `label="Overall budget for this period"` → `label={t.overallBudgetForPeriod}`
- the `summary.overallBudget === null ? ... : ...` paragraph → `summary.overallBudget === null ? t.noOverallSet(formatMoney(summary.categoryBudgetTotal, summary.currency)) : t.clearToRemove`
- the "spent of" paragraph → `` {t.spentOf(formatMoney(summary.spent, summary.currency), formatMoney(summary.periodBudget, summary.currency))} ``
- `label="Committed"` → `label={t.committed}`
- the committed `hint` template → `t.recurringStillToCome(summary.committedItems.length)`
- `label="Safe to spend"` → `label={t.safeToSpend}`
- the safe-to-spend `hint` ternary → `isCurrent ? t.perDay(formatMoney(summary.safeToSpendPerDay, summary.currency), summary.daysRemaining) : t.forWholePeriod`
- `Category`/`Progress`/`Spent`/`Budget` headers → `{t.colCategory}`/`{t.colProgress}`/`{t.colSpent}`/`{t.colBudget}`
- `no budget` → `{t.noBudget}`
- `label={\`${category.name} budget\`}` → `label={t.categoryBudgetAria(category.name)}`
- `Uncategorized` → `{t.uncategorized}`
- Pass `t` down to every `<BudgetAmountForm ... label={...} />` call
  already covered above, and add `t` prop to `BudgetAmountForm` for its
  aria-label (next step).

- [ ] **Step 3: Translate `budget-amount-form.tsx`**

Add a `saveAria: (label: string) => string` prop (or pass `t:
Dictionary["budgets"]` and use `t.saveAria`). Replace:

- `toast.success(state.message ?? "Saved")` → needs the dictionary; add a
  `t: Dictionary["budgets"]` prop and change to `toast.success(state.message
  ?? t.budgetSaved)` — note this form is also used for the overall budget
  where clearing yields `"Budget cleared"`; since the component can't tell
  which happened from the client (the server action already returns the
  correct message string via `done("Budget cleared")` /
  `done("Budget saved")`), the `?? t.budgetSaved` fallback only matters if
  `state.message` is ever undefined, which it isn't here — leave the
  fallback as `t.budgetSaved` for safety and move on.
- `aria-label={\`Save ${label}\`}` → `aria-label={t.saveAria(label)}`

Update the page's call sites to pass `t={t}` to every `<BudgetAmountForm>`.

- [ ] **Step 4: Translate `budgets.ts` action messages**

Edit `src/server/actions/budgets.ts`. Add locale fetching (Task 2 Step 5
pattern) and `const t = getDictionary(locale).budgets;`. Replace:

- `"Budget cleared"` → `t.budgetCleared`
- `"Budget saved"` → `t.budgetSaved`
- `"Pick a period first"` → `t.pickPeriodFirst`
- `"The previous period has no budget to copy"` → `t.noBudgetToCopy`
- `"This period already has every budget from last period"` → `t.everyBudgetAlreadyCopied`
- the `` `Copied ${toCreate.length} budget${...} forward` `` template → `t.copiedForward(toCreate.length)`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run `npm run dev`. Visit `/budgets` in Spanish, set an overall budget and a
category budget, use "Copiar periodo anterior", confirm every label and
toast is translated.

- [ ] **Step 7: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/budgets src/components/budgets \
  src/server/actions/budgets.ts
git commit -m "Translate budgets"
```

---

## Task 7: Recurring

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `recurring` section)
- Modify: `src/app/(app)/recurring/page.tsx`
- Modify: `src/components/recurring/recurring-dialog.tsx`
- Modify: `src/components/recurring/recurring-list.tsx`
- Modify: `src/server/actions/recurring.ts`

- [ ] **Step 1: Add the `recurring` dictionary section**

English:

```ts
  recurring: {
    title: "Recurring",
    description:
      "Everything that leaves on a schedule. Both kinds reduce safe to spend for the period they fall in.",
    newItem: "New item",
    subscriptions: "Subscriptions",
    monthlyAcrossActive: (amount: string, count: number) =>
      `${amount} a month across ${count} active item${count === 1 ? "" : "s"}`,
    noSubscriptionsTitle: "No subscriptions",
    noSubscriptionsDescription: "Add the bills that repeat so they stop surprising you mid-period.",
    recurringContributions: "Recurring contributions",
    monthlyGoingInto: (amount: string) => `${amount} a month going into something`,
    noContributionsTitle: "No recurring contributions",
    noContributionsDescription:
      "Money you put in on a schedule - an investment, a savings sweep - lives here.",
    editItem: "Edit recurring item",
    newItemTitle: "New recurring item",
    itemDescription: "Subscriptions are bills going out. Contributions are money you put into something.",
    addItem: "Add item",
    namePlaceholder: "Netflix",
    kind: "Kind",
    frequency: "Frequency",
    nextDue: "Next due",
    paused: "paused",
    actionsFor: (name: string) => `Actions for ${name}`,
    pause: "Pause",
    resume: "Resume",
    deleteItemTitle: (name: string) => `Delete ${name}?`,
    stopsCounting: "It stops counting against safe to spend straight away.",
    itemUpdated: "Recurring item updated",
    itemAdded: "Recurring item added",
    itemDeleted: "Recurring item deleted",
    itemNoLongerExists: "That item no longer exists",
    itemPaused: "Paused",
    itemResumed: "Resumed",
  },
```

Spanish:

```ts
  recurring: {
    title: "Recurrentes",
    description:
      "Todo lo que sale según un calendario. Ambos tipos reducen lo disponible para gastar en el periodo en que caen.",
    newItem: "Nuevo elemento",
    subscriptions: "Suscripciones",
    monthlyAcrossActive: (amount: string, count: number) =>
      `${amount} al mes entre ${count} elemento${count === 1 ? "" : "s"} activo${count === 1 ? "" : "s"}`,
    noSubscriptionsTitle: "Sin suscripciones",
    noSubscriptionsDescription: "Agrega las facturas que se repiten para que no te sorprendan a mitad de periodo.",
    recurringContributions: "Aportes recurrentes",
    monthlyGoingInto: (amount: string) => `${amount} al mes destinado a algo`,
    noContributionsTitle: "Sin aportes recurrentes",
    noContributionsDescription:
      "El dinero que aportas según un calendario -una inversión, un ahorro programado- vive aquí.",
    editItem: "Editar elemento recurrente",
    newItemTitle: "Nuevo elemento recurrente",
    itemDescription: "Las suscripciones son facturas que salen. Los aportes son dinero que destinas a algo.",
    addItem: "Agregar elemento",
    namePlaceholder: "Netflix",
    kind: "Tipo",
    frequency: "Frecuencia",
    nextDue: "Próximo vencimiento",
    paused: "pausado",
    actionsFor: (name: string) => `Acciones de ${name}`,
    pause: "Pausar",
    resume: "Reanudar",
    deleteItemTitle: (name: string) => `¿Eliminar ${name}?`,
    stopsCounting: "Deja de contar contra lo disponible para gastar de inmediato.",
    itemUpdated: "Elemento recurrente actualizado",
    itemAdded: "Elemento recurrente agregado",
    itemDeleted: "Elemento recurrente eliminado",
    itemNoLongerExists: "Ese elemento ya no existe",
    itemPaused: "Pausado",
    itemResumed: "Reanudado",
  },
```

- [ ] **Step 2: Translate `src/app/(app)/recurring/page.tsx`**

Add `const t = getDictionary(context.language).recurring;` and `const
common = getDictionary(context.language).common;`. Replace:

- `title="Recurring"` → `title={t.title}`
- `description="Everything that leaves..."` → `description={t.description}`
- `New item` → `{t.newItem}`
- `Subscriptions` → `{t.subscriptions}`
- the subscriptions `CardDescription` template → `t.monthlyAcrossActive(formatMoney(data.subscriptionsMonthly, currency), data.subscriptions.filter((row) => row.active).length)`
- `title="No subscriptions"` → `title={t.noSubscriptionsTitle}`
- `description="Add the bills..."` → `description={t.noSubscriptionsDescription}`
- `Recurring contributions` → `{t.recurringContributions}`
- the contributions `CardDescription` template → `t.monthlyGoingInto(formatMoney(data.contributionsMonthly, currency))`
- `Add` (button) → `{common.add}`
- `title="No recurring contributions"` → `title={t.noContributionsTitle}`
- `description="Money you put in..."` → `description={t.noContributionsDescription}`
- Pass `t={t}` and `common={common}` to both `<RecurringDialog>` calls and both `<RecurringList>` calls.

- [ ] **Step 3: Translate `recurring-dialog.tsx`**

Add `t: Dictionary["recurring"]` and `common: Dictionary["common"]` props.
Replace:

- `title={editing ? "Edit recurring item" : "New recurring item"}` → `t.editItem` / `t.newItemTitle`
- `description="Subscriptions are bills..."` → `t.itemDescription`
- `submitLabel={editing ? "Save changes" : "Add item"}` — add a
  `saveChanges: "Save changes"` / `"Guardar cambios"` key to `recurring`
  (Step 1) → `t.saveChanges` / `t.addItem`
- add `cancelLabel={common.cancel} savedMessage={editing ? t.itemUpdated : t.itemAdded}`
- `label="Name"` → `label={common.name}`
- `placeholder="Netflix"` → `placeholder={t.namePlaceholder}`
- `label="Kind"` → `label={t.kind}`
- `labels={RECURRING_KIND_LABELS}` → `labels={common.recurringKindLabels}` (remove that import from `@/lib/labels`, keep `RECURRING_KINDS`)
- `label="Frequency"` → `label={t.frequency}`
- `labels={FREQUENCY_LABELS}` → `labels={common.frequencyLabels}` (remove that import, keep `RECURRING_FREQUENCIES`)
- `label="Amount"` → `label={common.amount}`
- `label="Currency"` → `label={common.currency}`
- `label="Next due"` → `label={t.nextDue}`
- `label="Category"` → `label={common.category}`
- `label="Note"` → `label={common.note}`
- `placeholder="Optional"` → `placeholder={common.optional}`

- [ ] **Step 4: Translate `recurring-list.tsx`**

Add `t: Dictionary["recurring"]` and `common: Dictionary["common"]` props.
Replace:

- `paused` badge text → `{t.paused}`
- `labelFor(FREQUENCY_LABELS, row.frequency)` → `labelFor(common.frequencyLabels, row.frequency)` (remove `FREQUENCY_LABELS` import, keep `labelFor`)
- `` `Actions for ${row.name}` `` → `t.actionsFor(row.name)`
- `Edit` → `{common.edit}`
- `Pause` → `{t.pause}`
- `Resume` → `{t.resume}`
- `Delete` → `{common.delete}`
- `` `Delete ${deleting.name}?` `` → `t.deleteItemTitle(deleting.name)`
- `"It stops counting against safe to spend straight away."` → `t.stopsCounting`
- Add `confirmLabel={common.delete} keepLabel={common.keepIt}
  deletedMessage={t.itemDeleted}` to `<ConfirmDelete>`.
- Pass `t`/`common` to the nested `<RecurringDialog>`.
- The `toggle` function's toast fallback (`result?.message`) doesn't need a
  client-side default — the server action always returns a message (Step 5
  below), so no change needed there.

- [ ] **Step 5: Translate `recurring.ts` action messages**

Edit `src/server/actions/recurring.ts`. Add locale fetching (Task 2 Step 5
pattern) and `const t = getDictionary(locale).recurring;`. Replace:

- `id ? "Recurring item updated" : "Recurring item added"` → `id ? t.itemUpdated : t.itemAdded`
- `"Nothing to delete"` → reuse `getDictionary(locale).common.nothingToDelete` if added in Task 5, else add locally: add `nothingToDelete: "Nothing to delete"` / `"Nada que eliminar"` to `recurring` in Step 1 and use `t.nothingToDelete`.
- `"Recurring item deleted"` → `t.itemDeleted`
- `"That item no longer exists"` → `t.itemNoLongerExists`
- `item.active ? "Paused" : "Resumed"` → `item.active ? t.itemPaused : t.itemResumed`

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Manual verification**

Run `npm run dev`. Visit `/recurring` in Spanish, add a subscription and a
contribution, pause/resume and delete one, confirm all text and toasts are
translated.

- [ ] **Step 8: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/recurring src/components/recurring \
  src/server/actions/recurring.ts
git commit -m "Translate recurring"
```

---

## Task 8: Goals

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `goals` section)
- Modify: `src/app/(app)/goals/page.tsx`
- Modify: `src/app/(app)/goals/[id]/page.tsx`
- Modify: `src/components/goals/goal-dialog.tsx`
- Modify: `src/components/goals/goal-actions.tsx`
- Modify: `src/components/goals/contribution-dialog.tsx`
- Modify: `src/server/actions/goals.ts`

- [ ] **Step 1: Add the `goals` dictionary section**

English:

```ts
  goals: {
    title: "Goals",
    description: "What you are saving towards, and what each pay period has to carry.",
    newGoal: "New goal",
    noGoalsTitle: "No goals yet",
    noGoalsDescription: "Add a target amount, optionally a date, and log contributions as you make them.",
    createFirstGoal: "Create your first goal",
    reached: "Reached",
    targetDate: (date: string) => `Target ${date}`,
    noTargetDate: "No target date",
    percentOf: (pct: number, amount: string) => `${pct}% of ${amount}`,
    fullyFunded: "Fully funded",
    perPayPeriod: "per pay period",
    dueThisPeriod: "due this period",
    periodsLeft: (n: number) => `${n} periods left`,
    pace: "Pace",
    perPeriod: "per period",
    onTrackApprox: (date: string) => `on track for ~${date}`,
    toGo: (amount: string) => `${amount} to go`,
    goalsBreadcrumb: "Goals",
    logContribution: "Log contribution",
    noTargetPaceNote: "No target date - pace is projected from your contributions",
    stillToGo: "Still to go",
    contributionCount: (n: number) => `${n} contribution${n === 1 ? "" : "s"}`,
    perPayPeriodLabel: "Per pay period",
    periodsToTarget: (n: number) => `${n} periods to the target date`,
    doneAround: (date: string) => `on this pace, done around ${date}`,
    logToSetPace: "log a contribution to set a pace",
    inCurrency: (code: string) => `In ${code}`,
    ofAmount: (amount: string) => `of ${amount}`,
    driftedWarning: (amount: string) =>
      `Cached progress does not match the contribution history (${amount}). Recalculate from Settings.`,
    contributionHistory: "Contribution history",
    noContributionsYetTitle: "No contributions yet",
    noContributionsYetDescription: "Every amount you log here is the source of truth for this goal's progress.",
    removeContributionAria: "Remove contribution",
    editGoal: "Edit goal",
    goalDialogDescription: "A target date turns the goal into a per-pay-period number.",
    createGoal: "Create goal",
    namePlaceholder: "Emergency fund",
    targetAmount: "Target amount",
    targetDateLabel: "Target date",
    targetDateHint: "Optional. Without one, Cadence projects from your pace.",
    actionsFor: (name: string) => `Actions for ${name}`,
    deleteGoalTitle: (name: string) => `Delete ${name}?`,
    goalAndHistoryRemoved: "The goal and its contribution history are removed.",
    historyGoesWithIt: "Its contribution history goes with it.",
    removeContributionTitle: "Remove this contribution?",
    comesOffProgress: (amount: string) => `${amount} comes back off the goal's progress.`,
    addTo: (name: string) => `Add to ${name}`,
    contributionDialogDescription: "Contributions are the source of truth for goal progress.",
    amountWithCurrency: (code: string) => `Amount (${code})`,
    goalUpdated: "Goal updated",
    goalCreated: "Goal created",
    goalDeleted: "Goal deleted",
    goalNoLongerExists: "That goal no longer exists",
    contributionLogged: "Contribution logged",
    contributionRemoved: "Contribution removed",
    contributionNoLongerExists: "That contribution no longer exists",
  },
```

Spanish:

```ts
  goals: {
    title: "Metas",
    description: "En qué estás ahorrando y qué debe aportar cada periodo de pago.",
    newGoal: "Nueva meta",
    noGoalsTitle: "Aún no hay metas",
    noGoalsDescription: "Agrega un monto objetivo, opcionalmente una fecha, y registra aportes a medida que los hagas.",
    createFirstGoal: "Crea tu primera meta",
    reached: "Alcanzada",
    targetDate: (date: string) => `Meta para ${date}`,
    noTargetDate: "Sin fecha límite",
    percentOf: (pct: number, amount: string) => `${pct}% de ${amount}`,
    fullyFunded: "Totalmente financiada",
    perPayPeriod: "por periodo de pago",
    dueThisPeriod: "vence este periodo",
    periodsLeft: (n: number) => `${n} periodos restantes`,
    pace: "Ritmo",
    perPeriod: "por periodo",
    onTrackApprox: (date: string) => `en camino para ~${date}`,
    toGo: (amount: string) => `${amount} por alcanzar`,
    goalsBreadcrumb: "Metas",
    logContribution: "Registrar aporte",
    noTargetPaceNote: "Sin fecha límite: el ritmo se proyecta a partir de tus aportes",
    stillToGo: "Falta por alcanzar",
    contributionCount: (n: number) => `${n} aporte${n === 1 ? "" : "s"}`,
    perPayPeriodLabel: "Por periodo de pago",
    periodsToTarget: (n: number) => `${n} periodos hasta la fecha límite`,
    doneAround: (date: string) => `a este ritmo, listo alrededor de ${date}`,
    logToSetPace: "registra un aporte para establecer un ritmo",
    inCurrency: (code: string) => `En ${code}`,
    ofAmount: (amount: string) => `de ${amount}`,
    driftedWarning: (amount: string) =>
      `El progreso guardado no coincide con el historial de aportes (${amount}). Recalcula desde Ajustes.`,
    contributionHistory: "Historial de aportes",
    noContributionsYetTitle: "Aún no hay aportes",
    noContributionsYetDescription: "Cada monto que registras aquí es la fuente de verdad del progreso de esta meta.",
    removeContributionAria: "Eliminar aporte",
    editGoal: "Editar meta",
    goalDialogDescription: "Una fecha límite convierte la meta en un número por periodo de pago.",
    createGoal: "Crear meta",
    namePlaceholder: "Fondo de emergencia",
    targetAmount: "Monto objetivo",
    targetDateLabel: "Fecha límite",
    targetDateHint: "Opcional. Sin ella, Cadence proyecta a partir de tu ritmo.",
    actionsFor: (name: string) => `Acciones de ${name}`,
    deleteGoalTitle: (name: string) => `¿Eliminar ${name}?`,
    goalAndHistoryRemoved: "Se eliminan la meta y su historial de aportes.",
    historyGoesWithIt: "Su historial de aportes se elimina también.",
    removeContributionTitle: "¿Eliminar este aporte?",
    comesOffProgress: (amount: string) => `${amount} se resta del progreso de la meta.`,
    addTo: (name: string) => `Agregar a ${name}`,
    contributionDialogDescription: "Los aportes son la fuente de verdad del progreso de la meta.",
    amountWithCurrency: (code: string) => `Monto (${code})`,
    goalUpdated: "Meta actualizada",
    goalCreated: "Meta creada",
    goalDeleted: "Meta eliminada",
    goalNoLongerExists: "Esa meta ya no existe",
    contributionLogged: "Aporte registrado",
    contributionRemoved: "Aporte eliminado",
    contributionNoLongerExists: "Ese aporte ya no existe",
  },
```

- [ ] **Step 2: Translate `src/app/(app)/goals/page.tsx`**

Add `const t = getDictionary(context.language).goals;` and `const common =
getDictionary(context.language).common;`. Replace:

- `title="Goals"` → `title={t.title}`
- `description="What you are saving..."` → `description={t.description}`
- `New goal` → `{t.newGoal}`
- `title="No goals yet"` → `title={t.noGoalsTitle}`
- `description="Add a target amount..."` → `description={t.noGoalsDescription}`
- `Create your first goal` → `{t.createFirstGoal}`
- `Reached` → `{t.reached}`
- `` `Target ${formatDate(goal.targetDate)}` `` → `t.targetDate(formatDate(goal.targetDate))`
- `No target date` → `t.noTargetDate`
- the progress `span` template → `` `${Math.round(goal.progress * 100)}% of ${formatMoney(goal.targetAmount, goal.currency)}` `` → `t.percentOf(Math.round(goal.progress * 100), formatMoney(goal.targetAmount, goal.currency))`
- `Fully funded` → `{t.fullyFunded}`
- `per pay period` → `{t.perPayPeriod}`
- `· due this period` → `` ` · ${t.dueThisPeriod}` ``
- `` ` · ${goal.periodsLeft} periods left` `` → `` ` · ${t.periodsLeft(goal.periodsLeft)}` ``
- `Pace` → `{t.pace}`
- `per period` → `{t.perPeriod}`
- `` ` · ~${formatDate(goal.projectedEnd)}` `` → keep the `~` but wrap with translated word if desired — simplest: `` ` · ${t.onTrackApprox(formatDate(goal.projectedEnd))}` `` (drop the redundant literal `~`, it's baked into `onTrackApprox`)
- `` `${formatMoney(goal.remaining, goal.currency)} to go` `` → `t.toGo(formatMoney(goal.remaining, goal.currency))`
- `Add` (button) → `{common.add}`
- Pass `t={t}` to `<GoalDialog>`, `<GoalActions>`, `<ContributionDialog>`.

- [ ] **Step 3: Translate `src/app/(app)/goals/[id]/page.tsx`**

Add `const t = getDictionary(context.language).goals;`. Replace:

- `Goals` (breadcrumb) → `{t.goalsBreadcrumb}`
- the `description` ternary → `summary.targetDate ? t.targetDate(formatDate(summary.targetDate)) : t.noTargetPaceNote`
- `Log contribution` → `{t.logContribution}`
- the progress `span` → `t.percentOf(Math.round(summary.progress * 100), formatMoney(summary.targetAmount, summary.currency))`
- `label="Still to go"` → `label={t.stillToGo}`
- the `hint` → `t.contributionCount(summary.contributionCount)`
- `label="Per pay period"` → `label={t.perPayPeriodLabel}`
- the `hint` ternary → `summary.periodsLeft === 0 ? t.dueThisPeriod : t.periodsToTarget(summary.periodsLeft)`
- `label="Pace"` → `label={t.pace}`
- `value={... : "-"}` (leave `"-"` as-is, it's a placeholder dash not text)
- the `hint` ternary → `summary.projectedEnd ? t.doneAround(formatDate(summary.projectedEnd)) : t.logToSetPace`
- `` label={`In ${context.displayCurrency}`} `` → `label={t.inCurrency(context.displayCurrency)}`
- the `hint` → `` t.ofAmount(formatMoney(summary.displayTarget, context.displayCurrency)) ``
- the drifted-warning paragraph → `t.driftedWarning(formatMoney(contributionTotal, summary.currency))`
- `Contribution history` → `{t.contributionHistory}`
- `title="No contributions yet"` → `title={t.noContributionsYetTitle}`
- `description="Every amount you log..."` → `description={t.noContributionsYetDescription}`
- `Date`/`Note`/`Amount` headers → `{common.date}` / (add `note` already
  exists in `common` from Task 1 — reuse it) `{common.note}` /
  `{common.amount}`
- Pass `t={t}` to `<ContributionDialog>` and `<GoalActions>`.

- [ ] **Step 4: Translate `goal-dialog.tsx`**

Add `t: Dictionary["goals"]` and `common: Dictionary["common"]` props.
Replace:

- `title={editing ? "Edit goal" : "New goal"}` → `t.editGoal` / `t.newGoal`
- `description="A target date turns..."` → `t.goalDialogDescription`
- `submitLabel={editing ? "Save changes" : "Create goal"}` — add
  `saveChanges: "Save changes"` / `"Guardar cambios"` to `goals` (Step 1) →
  `t.saveChanges` / `t.createGoal`
- add `cancelLabel={common.cancel} savedMessage={editing ? t.goalUpdated : t.goalCreated}`
- `label="Name"` → `label={common.name}`
- `placeholder="Emergency fund"` → `placeholder={t.namePlaceholder}`
- `label="Target amount"` → `label={t.targetAmount}`
- `label="Currency"` → `label={common.currency}`
- `label="Target date"` → `label={t.targetDateLabel}`
- `hint="Optional. Without one, Cadence projects from your pace."` → `hint={t.targetDateHint}`

- [ ] **Step 5: Translate `goal-actions.tsx`**

Add `t: Dictionary["goals"]` and `common: Dictionary["common"]` props to
both exported functions (`GoalActions` and `ContributionDeleteButton`).
Replace:

- `` `Actions for ${goal.name}` `` → `t.actionsFor(goal.name)`
- `Edit` → `{common.edit}`
- `Delete` → `{common.delete}`
- `` `Delete ${goal.name}?` `` → `t.deleteGoalTitle(goal.name)`
- the description ternary → `redirectAfterDelete ? t.goalAndHistoryRemoved : t.historyGoesWithIt`
- Add `confirmLabel={common.delete} keepLabel={common.keepIt}
  deletedMessage={t.goalDeleted}` to that `<ConfirmDelete>`.
- Pass `t`/`common` to the nested `<GoalDialog>`.
- `title="Remove this contribution?"` → `title={t.removeContributionTitle}`
- `` description={`${amount} comes back off the goal's progress.`} `` → `description={t.comesOffProgress(amount)}`
- `aria-label="Remove contribution"` → `aria-label={t.removeContributionAria}`
- Add `confirmLabel={common.delete} keepLabel={common.keepIt}
  deletedMessage={t.contributionRemoved}` to this second `<ConfirmDelete>`.

- [ ] **Step 6: Translate `contribution-dialog.tsx`**

Add `t: Dictionary["goals"]` and `common: Dictionary["common"]` props.
Replace:

- `title={\`Add to ${goalName}\`}` → `title={t.addTo(goalName)}`
- `description="Contributions are the source of truth..."` → `t.contributionDialogDescription`
- `submitLabel="Log contribution"` → `t.logContribution`
- add `cancelLabel={common.cancel} savedMessage={t.contributionLogged}`
- `` label={`Amount (${currency})`} `` → `label={t.amountWithCurrency(currency)}`
- `label="Date"` → `label={common.date}`
- `label="Note"` → `label={common.note}`
- `placeholder="Optional"` → `placeholder={common.optional}`

Update every caller of `<ContributionDialog>` (both goals pages, Steps 2-3)
to pass `t={t}` and `common={getDictionary(context.language).common}`.

- [ ] **Step 7: Translate `goals.ts` action messages**

Edit `src/server/actions/goals.ts`. Add locale fetching (Task 2 Step 5
pattern) and `const t = getDictionary(locale).goals;`. Replace:

- `id ? "Goal updated" : "Goal created"` → `id ? t.goalUpdated : t.goalCreated`
- `"Nothing to delete"` → reuse `common.nothingToDelete` if it exists by now, else keep local.
- `"Goal deleted"` → `t.goalDeleted`
- `"That goal no longer exists"` → `t.goalNoLongerExists`
- `"Contribution logged"` → `t.contributionLogged`
- `"That contribution no longer exists"` → `t.contributionNoLongerExists`
- `"Contribution removed"` → `t.contributionRemoved`

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Manual verification**

Run `npm run dev`. Visit `/goals` and a goal detail page in Spanish, create
a goal, log and remove a contribution, edit and delete a goal. Confirm all
text and toasts are translated.

- [ ] **Step 10: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/goals src/components/goals \
  src/server/actions/goals.ts
git commit -m "Translate goals"
```

---

## Task 9: Reports

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `reports` section)
- Modify: `src/app/(app)/reports/page.tsx`
- Modify: `src/components/reports/category-bars.tsx` (no literal text — verify, skip if none)
- Modify: `src/components/reports/trend-chart.tsx`

No server action messages in this area (reports are read-only).

- [ ] **Step 1: Add the `reports` dictionary section**

English:

```ts
  reports: {
    title: "Reports",
    description: (code: string) => `Everything in ${code}, converted at current rates.`,
    spendingByCategory: "Spending by category",
    nothingSpentTitle: "Nothing spent this period",
    nothingSpentDescription: "Categorised spending shows up here as soon as you log it.",
    lastNPeriods: (n: number) => `Last ${n} pay periods`,
    averagePerPeriod: (amount: string) => `${amount} average per period`,
    peakPeriod: "peak period",
    thisPeriod: "This period",
    categoriesTouched: (n: number) => `${n} categor${n === 1 ? "y" : "ies"} touched`,
    acrossNPeriods: (n: number) => `Across ${n} periods`,
    incomeThisPeriod: "Income this period",
    tooltipOut: (amount: string) => `${amount} out`,
    tooltipIn: (amount: string) => `${amount} in`,
  },
```

Spanish:

```ts
  reports: {
    title: "Informes",
    description: (code: string) => `Todo en ${code}, convertido a las tasas actuales.`,
    spendingByCategory: "Gastos por categoría",
    nothingSpentTitle: "Nada gastado este periodo",
    nothingSpentDescription: "Los gastos categorizados aparecen aquí en cuanto los registras.",
    lastNPeriods: (n: number) => `Últimos ${n} periodos de pago`,
    averagePerPeriod: (amount: string) => `${amount} de promedio por periodo`,
    peakPeriod: "periodo pico",
    thisPeriod: "Este periodo",
    categoriesTouched: (n: number) => `${n} categoría${n === 1 ? "" : "s"} usada${n === 1 ? "" : "s"}`,
    acrossNPeriods: (n: number) => `En ${n} periodos`,
    incomeThisPeriod: "Ingresos este periodo",
    tooltipOut: (amount: string) => `${amount} gastado`,
    tooltipIn: (amount: string) => `${amount} recibido`,
  },
```

- [ ] **Step 2: Translate `src/app/(app)/reports/page.tsx`**

Add `const t = getDictionary(context.language).reports;`. Replace:

- `title="Reports"` → `title={t.title}`
- the `description` template → `description={t.description(context.displayCurrency)}`
- `Spending by category` → `{t.spendingByCategory}`
- `title="Nothing spent this period"` → `title={t.nothingSpentTitle}`
- `description="Categorised spending..."` → `description={t.nothingSpentDescription}`
- `` Last {TREND_PERIODS} pay periods `` → `{t.lastNPeriods(TREND_PERIODS)}`
- the average `CardDescription` template → `t.averagePerPeriod(formatMoney(average, context.displayCurrency))`
- `label="This period"` → `label={t.thisPeriod}`
- the categories-touched `hint` template → `t.categoriesTouched(spendingLines.length)`
- `` label={`Across ${TREND_PERIODS} periods`} `` → `label={t.acrossNPeriods(TREND_PERIODS)}`
- `label="Income this period"` → `label={t.incomeThisPeriod}`
- Pass `t` to `<TrendChart points={trend} currency={...} currentKey={...} t={t} />`.

- [ ] **Step 3: Confirm `category-bars.tsx` needs no changes**

Re-read `src/components/reports/category-bars.tsx` (already read during
planning): it renders only `line.name` (data, not UI copy) and computed
percentages — no hardcoded English strings. No edit needed for this file.

- [ ] **Step 4: Translate `trend-chart.tsx`**

Add a `t: Dictionary["reports"]` prop. Replace:

- `peak period` → `{t.peakPeriod}`
- `` aria-label={`${point.period.longLabel}: ${formatMoney(point.spent, currency)} spent`} `` → `` aria-label={`${point.period.longLabel}: ${t.tooltipOut(formatMoney(point.spent, currency))}`} ``
- `` {formatMoney(point.spent, currency)} out `` → `{t.tooltipOut(formatMoney(point.spent, currency))}`
- `` {formatMoney(point.income, currency)} in `` → `{t.tooltipIn(formatMoney(point.income, currency))}`

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run `npm run dev`. Visit `/reports` in Spanish with at least one
transaction logged, confirm both cards and the trend-chart tooltips are
translated.

- [ ] **Step 7: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/reports src/components/reports
git commit -m "Translate reports"
```

---

## Task 10: Settings

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `settingsPage` section — named to avoid colliding with the `Settings` Prisma model or the `settings.ts` action file)
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `src/app/(app)/settings/connections/page.tsx`
- Modify: `src/components/settings/provider-connections.tsx`
- Modify: `src/components/settings/display-currency-form.tsx`
- Modify: `src/server/actions/settings.ts`
- Modify: `src/server/actions/connections.ts`

- [ ] **Step 1: Add the `settingsPage` dictionary section**

English:

```ts
  settingsPage: {
    title: "Settings",
    description: "A single-user ledger: one PIN, one display currency, one set of rules.",
    displayCurrencyTitle: "Display currency",
    displayCurrencyDescription: "Every figure in the app is converted into this currency.",
    exchangeRates: "Exchange rates",
    exchangeRatesDescription: "USD-based, cached for 24 hours, cross rates derived through USD.",
    usdTo: (code: string) => `USD to ${code}`,
    lastFetched: (datetime: string) => `Last fetched ${datetime} UTC`,
    noRatesFetched: "No rates fetched yet",
    rateServiceUnreachable: " · the rate service was unreachable, using the last known values",
    goalProgress: "Goal progress",
    goalProgressDescription:
      "Goal totals are cached for speed. Contributions are the source of truth - rebuild the cache from them if anything looks off.",
    recalculateGoalTotals: "Recalculate goal totals",
    emailConnections: "Email connections",
    emailConnectionsDescription:
      "Gmail and Outlook accounts Cadence pulls transactional emails from, staged on /review before they become transactions.",
    manageConnections: "Manage connections",
    session: "Session",
    sessionDescription: (tz: string, currencies: string) =>
      `Pay periods are resolved in ${tz}. Currencies available: ${currencies}.`,
    lockCadence: "Lock Cadence",
    connectionsTitle: "Connections",
    connectionsDescription: "Gmail and Outlook accounts Cadence pulls transactional emails from.",
    syncNow: "Sync now",
    reviewQueue: "Review queue",
    connectedTo: (x: string) => `Connected ${x}.`,
    gmailDescription: "Reads receipts, invoices and subscription emails (gmail.readonly).",
    outlookDescription: "Reads the same kinds of emails via Microsoft Graph (Mail.Read).",
    neverSynced: "Never synced",
    lastSynced: (datetime: string) => `Last synced ${datetime} UTC`,
    noAccountConnected: "No account connected yet.",
    disconnectTitle: (email: string) => `Disconnect ${email}?`,
    disconnectDescription:
      "Cadence stops syncing this mailbox. Transactions already staged or approved from it are kept.",
    disconnect: "Disconnect",
    connectAccount: (label: string) => `Connect ${label} account`,
    goalsRecalculated: (count: number) => `Recalculated ${count} goal${count === 1 ? "" : "s"}`,
    showingIn: (code: string) => `Showing amounts in ${code}`,
    nothingToDisconnect: "Nothing to disconnect",
    connectionNoLongerExists: "That connection no longer exists",
    disconnected: (email: string) => `Disconnected ${email}`,
    connectFirst: "Connect a Gmail or Outlook account first",
    syncedResult: (accounts: number, staged: number) =>
      `Synced ${accounts} account${accounts === 1 ? "" : "s"} - ${staged} new item${staged === 1 ? "" : "s"} staged`,
  },
```

Spanish:

```ts
  settingsPage: {
    title: "Ajustes",
    description: "Un libro contable de un solo usuario: un PIN, una moneda de visualización, un conjunto de reglas.",
    displayCurrencyTitle: "Moneda de visualización",
    displayCurrencyDescription: "Toda cifra en la app se convierte a esta moneda.",
    exchangeRates: "Tasas de cambio",
    exchangeRatesDescription: "Basadas en USD, cacheadas por 24 horas; las tasas cruzadas se derivan a través de USD.",
    usdTo: (code: string) => `USD a ${code}`,
    lastFetched: (datetime: string) => `Última actualización ${datetime} UTC`,
    noRatesFetched: "Aún no se han obtenido tasas",
    rateServiceUnreachable: " · el servicio de tasas no estaba disponible; se usan los últimos valores conocidos",
    goalProgress: "Progreso de metas",
    goalProgressDescription:
      "Los totales de las metas se cachean por velocidad. Los aportes son la fuente de verdad: reconstruye la caché a partir de ellos si algo se ve mal.",
    recalculateGoalTotals: "Recalcular totales de metas",
    emailConnections: "Conexiones de correo",
    emailConnectionsDescription:
      "Cuentas de Gmail y Outlook desde las que Cadence extrae correos transaccionales, puestas en /review antes de convertirse en transacciones.",
    manageConnections: "Administrar conexiones",
    session: "Sesión",
    sessionDescription: (tz: string, currencies: string) =>
      `Los periodos de pago se resuelven en ${tz}. Monedas disponibles: ${currencies}.`,
    lockCadence: "Bloquear Cadence",
    connectionsTitle: "Conexiones",
    connectionsDescription: "Cuentas de Gmail y Outlook desde las que Cadence extrae correos transaccionales.",
    syncNow: "Sincronizar ahora",
    reviewQueue: "Cola de revisión",
    connectedTo: (x: string) => `Conectado ${x}.`,
    gmailDescription: "Lee recibos, facturas y correos de suscripción (gmail.readonly).",
    outlookDescription: "Lee los mismos tipos de correos vía Microsoft Graph (Mail.Read).",
    neverSynced: "Nunca sincronizado",
    lastSynced: (datetime: string) => `Última sincronización ${datetime} UTC`,
    noAccountConnected: "Aún no hay ninguna cuenta conectada.",
    disconnectTitle: (email: string) => `¿Desconectar ${email}?`,
    disconnectDescription:
      "Cadence deja de sincronizar este correo. Las transacciones ya puestas en revisión o aprobadas desde él se conservan.",
    disconnect: "Desconectar",
    connectAccount: (label: string) => `Conectar cuenta de ${label}`,
    goalsRecalculated: (count: number) => `Se recalcularon ${count} meta${count === 1 ? "" : "s"}`,
    showingIn: (code: string) => `Mostrando montos en ${code}`,
    nothingToDisconnect: "Nada que desconectar",
    connectionNoLongerExists: "Esa conexión ya no existe",
    disconnected: (email: string) => `${email} desconectado`,
    connectFirst: "Conecta primero una cuenta de Gmail o Outlook",
    syncedResult: (accounts: number, staged: number) =>
      `Se sincronizaron ${accounts} cuenta${accounts === 1 ? "" : "s"} - ${staged} elemento${staged === 1 ? "" : "s"} nuevo${staged === 1 ? "" : "s"} en revisión`,
  },
```

- [ ] **Step 2: Translate `src/app/(app)/settings/page.tsx`**

Add `const t = getDictionary(context.language).settingsPage;`. Replace:

- `title="Settings"` → `title={t.title}`
- `description="A single-user ledger..."` → `description={t.description}`
- `Display currency` (CardTitle) → `{t.displayCurrencyTitle}`
- `Every figure in the app is converted into this currency.` → `{t.displayCurrencyDescription}`
- `Exchange rates` → `{t.exchangeRates}`
- `USD-based, cached for 24 hours...` → `{t.exchangeRatesDescription}`
- `` `USD to ${code}` `` → `t.usdTo(code)`
- the `Last fetched ...` / `No rates fetched yet` ternary → `context.rates.fetchedAt ? t.lastFetched(context.rates.fetchedAt.toISOString().slice(0, 16).replace("T", " ")) : t.noRatesFetched`
- the stale suffix → `context.rates.stale ? t.rateServiceUnreachable : ""`
- `Goal progress` → `{t.goalProgress}`
- `Goal totals are cached for speed...` → `{t.goalProgressDescription}`
- `Recalculate goal totals` → `{t.recalculateGoalTotals}`
- `Email connections` → `{t.emailConnections}`
- `Gmail and Outlook accounts Cadence pulls...` → `{t.emailConnectionsDescription}`
- `Manage connections` → `{t.manageConnections}`
- `Session` → `{t.session}`
- the session `CardDescription` template → `t.sessionDescription(timezone, CURRENCIES.map((code) => CURRENCY_LABELS[code] ?? code).join(", "))`
- `Lock Cadence` → `{t.lockCadence}`
- Pass `t` to `<DisplayCurrencyForm value={context.displayCurrency} t={t}
  />`.

- [ ] **Step 3: Translate `display-currency-form.tsx`**

Add a `t: Dictionary["settingsPage"]` prop. Replace:

- `toast.success(state.message ?? "Saved")` → import `getDictionary`'s
  `common` isn't available here unless passed too — simplest: add a
  `common: Dictionary["common"]` prop as well and use `t.showingIn`-style
  server-provided message as the primary source (the action already
  returns a translated message per Step 6 below), so the client fallback
  only needs `common.saved`. Add `common` prop and use `state.message ??
  common.saved`.
- `Save` (SubmitButton content) → `{common.save}`

Update the page's call site to also pass `common={getDictionary(context.language).common}`.

- [ ] **Step 4: Translate `src/app/(app)/settings/connections/page.tsx`**

Add `const t = getDictionary(???).settingsPage;` — this page has no
`getAppContext()` call currently; add one: `const context = await
getAppContext();` then `const t = getDictionary(context.language).settingsPage;`.
Replace:

- `title="Connections"` → `title={t.connectionsTitle}`
- `description="Gmail and Outlook accounts..."` → `description={t.connectionsDescription}`
- `Sync now` → `{t.syncNow}`
- `Review queue` → `{t.reviewQueue}`
- `` <AlertDescription>Connected {connected}.</AlertDescription> `` → `<AlertDescription>{t.connectedTo(connected)}</AlertDescription>`
- `label="Gmail"` → `label="Gmail"` (brand name, unchanged)
- `description="Reads receipts, invoices..."` → `description={t.gmailDescription}`
- `label="Outlook"` → unchanged (brand name)
- `description="Reads the same kinds..."` → `description={t.outlookDescription}`
- Pass `t` to both `<ProviderConnections>` calls.

- [ ] **Step 5: Translate `provider-connections.tsx`**

Add a `t: Dictionary["settingsPage"]` and `common: Dictionary["common"]`
prop. Replace:

- the `formatSyncedAt` helper's `"Never synced"` / template → move the
  translation into the component: change `formatSyncedAt` to accept `t` as
  a parameter: `function formatSyncedAt(date: Date | null, t:
  Dictionary["settingsPage"]): string { if (!date) return t.neverSynced;
  return t.lastSynced(date.toISOString().slice(0, 16).replace("T", " ")); }`
  and call it as `formatSyncedAt(connection.lastSyncedAt, t)`.
- `No account connected yet.` → `{t.noAccountConnected}`
- `` `Disconnect ${connection.emailAddress}?` `` → `t.disconnectTitle(connection.emailAddress)`
- `"Cadence stops syncing this mailbox..."` → `t.disconnectDescription`
- `Disconnect` (both the `confirmLabel` prop and the trigger button text) → `{t.disconnect}`
- Add `keepLabel={common.keepIt} deletedMessage={t.disconnected(connection.emailAddress)}` to `<ConfirmDelete>`.
- `` Connect {label} account `` → `{t.connectAccount(label)}`

Update the caller (Step 4) to also pass `common={getDictionary(context.language).common}`.

- [ ] **Step 6: Translate `settings.ts` action messages**

Edit `src/server/actions/settings.ts`. It already has `getSettings`-style
locale access from Task 1's `updateLanguageAction`; for the other two
actions, add locale fetching (Task 2 Step 5 pattern, or reuse `settings`
already fetched in this file if refactoring naturally allows it — simplest
is a fresh `getSettings()` call per action, consistent with the rest of the
codebase) and `const t = getDictionary(locale).settingsPage;`. Replace:

- `` `Showing amounts in ${parsed.data.displayCurrency}` `` (in `updateDisplayCurrencyAction`) → `t.showingIn(parsed.data.displayCurrency)`
- `` `Recalculated ${count} goal${count === 1 ? "" : "s"}` `` (in `recalculateGoalsAction`) → `t.goalsRecalculated(count)`

- [ ] **Step 7: Translate `connections.ts` action messages**

Edit `src/server/actions/connections.ts`. Add locale fetching and `const t
= getDictionary(locale).settingsPage;`. Replace:

- `"Nothing to disconnect"` → `t.nothingToDisconnect`
- `"That connection no longer exists"` → `t.connectionNoLongerExists`
- `` `Disconnected ${connection.emailAddress}` `` → `t.disconnected(connection.emailAddress)`
- `"Connect a Gmail or Outlook account first"` → `t.connectFirst`
- the multi-line `Synced ...` template → `t.syncedResult(result.accountsSynced, result.staged)`

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Manual verification**

Run `npm run dev`. Visit `/settings` and `/settings/connections` in
Spanish. Confirm every card, the currency form, and (if a Gmail/Outlook
connection exists in your dev environment) the connect/disconnect/sync
flows show translated text and toasts. If no email provider is configured
in your local `.env`, it's acceptable to verify the connections page's
static text only (empty-state "No account connected yet." message) without
completing an actual OAuth connection.

- [ ] **Step 10: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/settings src/components/settings \
  src/server/actions/settings.ts src/server/actions/connections.ts
git commit -m "Translate settings"
```

---

## Task 11: Review

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts` (add `review` section)
- Modify: `src/app/(app)/review/page.tsx`
- Modify: `src/components/review/review-row.tsx`
- Modify: `src/components/review/review-table.tsx`
- Modify: `src/components/review/review-edit-dialog.tsx`
- Modify: `src/server/actions/review.ts`

- [ ] **Step 1: Add the `review` dictionary section**

English:

```ts
  review: {
    title: "Review queue",
    pendingItems: (n: number) => `${n} pending item${n === 1 ? "" : "s"} from connected inboxes.`,
    hideReviewed: "Hide reviewed",
    showReviewed: "Show reviewed",
    addAccountFirstTitle: "Add an account first",
    needAccountDescription: "Approving a staged item needs somewhere to put it.",
    goToAccounts: "Go to accounts",
    nothingToReviewTitle: "Nothing to review",
    noStagedYet: "No staged items yet - connect an inbox and sync to get started.",
    noPendingItems: 'No pending items. Approved and rejected items stay hidden - use "Show reviewed" to see them.',
    manageConnections: "Manage connections",
    colAmount: "Amount",
    colAccount: "Account",
    colCategory: "Category",
    colActions: "Actions",
    approved: "Approved",
    rejected: "Rejected",
    pickAccountFirst: "Pick an account before approving",
    editAria: "Edit",
    reject: "Reject",
    approve: "Approve",
    approvedToast: "Approved",
    rejectedToast: "Rejected",
    pickAnAccount: "Pick an account",
    noCategory: "No category",
    editStagedTitle: "Edit staged item",
    editStagedDescription: "Changes are saved but stay pending until you approve.",
    stagedSaved: "Saved",
    itemNoLongerExists: "That item no longer exists",
    alreadyReviewed: "This item was already reviewed",
    accountNoLongerExists: "That account no longer exists",
    transactionAlreadyExists: "This transaction already exists",
    nothingToReject: "Nothing to reject",
  },
```

Spanish:

```ts
  review: {
    title: "Cola de revisión",
    pendingItems: (n: number) => `${n} elemento${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"} de las bandejas conectadas.`,
    hideReviewed: "Ocultar revisados",
    showReviewed: "Mostrar revisados",
    addAccountFirstTitle: "Primero agrega una cuenta",
    needAccountDescription: "Aprobar un elemento en revisión necesita dónde registrarse.",
    goToAccounts: "Ir a cuentas",
    nothingToReviewTitle: "Nada para revisar",
    noStagedYet: "Aún no hay elementos en revisión: conecta una bandeja y sincroniza para empezar.",
    noPendingItems: 'No hay elementos pendientes. Los aprobados y rechazados quedan ocultos: usa "Mostrar revisados" para verlos.',
    manageConnections: "Administrar conexiones",
    colAmount: "Monto",
    colAccount: "Cuenta",
    colCategory: "Categoría",
    colActions: "Acciones",
    approved: "Aprobado",
    rejected: "Rechazado",
    pickAccountFirst: "Elige una cuenta antes de aprobar",
    editAria: "Editar",
    reject: "Rechazar",
    approve: "Aprobar",
    approvedToast: "Aprobado",
    rejectedToast: "Rechazado",
    pickAnAccount: "Elige una cuenta",
    noCategory: "Sin categoría",
    editStagedTitle: "Editar elemento en revisión",
    editStagedDescription: "Los cambios se guardan pero quedan pendientes hasta que apruebes.",
    stagedSaved: "Guardado",
    itemNoLongerExists: "Ese elemento ya no existe",
    alreadyReviewed: "Este elemento ya fue revisado",
    accountNoLongerExists: "Esa cuenta ya no existe",
    transactionAlreadyExists: "Esta transacción ya existe",
    nothingToReject: "Nada que rechazar",
  },
```

- [ ] **Step 2: Translate `src/app/(app)/review/page.tsx`**

This page currently has no `getAppContext()` call. Add one:
`const context = await getAppContext();` and `const t =
getDictionary(context.language).review;` and `const common =
getDictionary(context.language).common;`. Replace:

- `title="Review queue"` → `title={t.title}`
- the `description` template → `description={t.pendingItems(pendingCount)}`
- the show/hide link text → `{showReviewed ? t.hideReviewed : t.showReviewed}`
- `title="Add an account first"` → `title={t.addAccountFirstTitle}`
- `description="Approving a staged item needs somewhere to put it."` → `description={t.needAccountDescription}`
- `Go to accounts` → `{t.goToAccounts}`
- `title="Nothing to review"` → `title={t.nothingToReviewTitle}`
- the `description` ternary → `showReviewed ? t.noStagedYet : t.noPendingItems`
- `Manage connections` → `{t.manageConnections}`
- `labelFor(SOURCE_LABELS, source)` → `labelFor(common.sourceLabels, source)` (remove the `SOURCE_LABELS` import from `@/lib/labels`, keep `labelFor`)
- Pass `t={t}` and `common={common}` to `<ReviewTable>`.

- [ ] **Step 3: Translate `review-table.tsx`**

Add `t: Dictionary["review"]` and `common: Dictionary["common"]` props.
Replace:

- `Date` → `{common.date}`
- `Description` → add `description: "Description"` / `"Descripción"` to
  `common` if not already present from Task 5 Step 5 (verify before
  duplicating) — use `{common.description}`
- `Amount` → `{common.amount}`
- `Account` → `{common.account}`
- `Category` → `{common.category}`
- `Actions` → `{t.colActions}`
- Pass `t`/`common` down to each `<ReviewRow>` and to `<ReviewEditDialog>`.

- [ ] **Step 4: Translate `review-row.tsx`**

Add `t: Dictionary["review"]` and `common: Dictionary["common"]` props.
Replace:

- the `STATUS_BADGE` map's `label` values (`"Approved"`, `"Rejected"`) —
  move this map inside the component so it can use `t`:
  ```tsx
  const STATUS_BADGE: Record<string, { label: string; variant: "secondary" | "destructive" }> = {
    APPROVED: { label: t.approved, variant: "secondary" },
    REJECTED: { label: t.rejected, variant: "destructive" },
  };
  ```
- `toast.error("Pick an account before approving")` → `toast.error(t.pickAccountFirst)`
- `toast.success(result?.message ?? "Approved")` → `toast.success(result?.message ?? t.approvedToast)`
- `toast.success(result?.message ?? "Rejected")` → `toast.success(result?.message ?? t.rejectedToast)`
- `placeholder="Pick an account"` → `placeholder={t.pickAnAccount}`
- `placeholder="Category"` → `placeholder={common.category}`
- `No category` → `{t.noCategory}`
- `aria-label="Edit"` → `aria-label={t.editAria}`
- `Reject` → `{t.reject}`
- `Approve` → `{t.approve}`

- [ ] **Step 5: Translate `review-edit-dialog.tsx`**

Add `t: Dictionary["review"]` and `common: Dictionary["common"]` props.
Replace:

- `title="Edit staged item"` → `title={t.editStagedTitle}`
- `description="Changes are saved but stay pending until you approve."` → `description={t.editStagedDescription}`
- `submitLabel="Save"` → `submitLabel={common.save}`
- add `cancelLabel={common.cancel} savedMessage={t.stagedSaved}`
- `label="Date"` → `label={common.date}`
- `label="Currency"` → `label={common.currency}`
- `label="Amount"` → `label={common.amount}`
- `label="Description"` → `label={common.description}`
- `label="Account"` → `label={common.account}`
- `label="Category"` → `label={common.category}`

- [ ] **Step 6: Translate `review.ts` action messages**

Edit `src/server/actions/review.ts`. It already fetches `locale` (Task 2
Step 5, applied to `review.ts` as one of the listed files — confirm; if
`review.ts` wasn't in that list, add the same locale-fetch pattern here
now). Add `const t = getDictionary(locale).review;`. Replace:

- `"That item no longer exists"` (three occurrences) → `t.itemNoLongerExists`
- `"This item was already reviewed"` (three occurrences) → `t.alreadyReviewed`
- `"Saved"` → `t.stagedSaved`
- `"That account no longer exists"` → `t.accountNoLongerExists`
- `"This transaction already exists"` → `t.transactionAlreadyExists`
- `"Approved"` → `t.approvedToast`
- `"Nothing to reject"` → `t.nothingToReject`
- `"Rejected"` → `t.rejectedToast`

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run `npm run dev`. Visit `/review` in Spanish (with a staged item if one
exists in your dev database, or just the empty state otherwise). Confirm
the page text, table headers, row actions, edit dialog, and toasts are
translated with no leftover English.

- [ ] **Step 9: Commit**

```bash
git add src/lib/i18n src/app/\(app\)/review src/components/review \
  src/server/actions/review.ts
git commit -m "Translate review queue"
```

---

## Final full-app sweep

- [ ] **Step 1: Full typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both PASS.

- [ ] **Step 2: Full click-through in Spanish**

Run `npm run dev`. Starting from `/login`, switch to Spanish, and click
through every nav item (Dashboard, Transactions, Review, Accounts, Budgets,
Recurring, Goals, Reports, Settings) plus the transaction detail flows
(CSV import, account detail, goal detail, settings connections). Confirm:

- No leftover English string anywhere in the UI chrome (data values —
  account names, category names, notes — are user data and correctly stay
  as typed).
- No broken layout from longer Spanish strings, particularly in the sidebar
  nav, table headers, and badge/pill components.
- Switching back to English restores all English text immediately (no stale
  cached Spanish fragments).

- [ ] **Step 3: Commit (if any sweep fixes were needed)**

```bash
git add -A
git commit -m "Fix remaining localization issues from full-app sweep"
```
