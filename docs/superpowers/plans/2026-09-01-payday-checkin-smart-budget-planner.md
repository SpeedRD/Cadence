# Payday Check-in + Smart Budget Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a payday check-in + smart budget planner to Cadence: on the 15th/last day of the month, guide the user through confirming account balances, recording income, reserving commitments (subscriptions, recurring contributions, goal roadmaps, a protected buffer), and planning flexible category budgets for the pay period ahead — while adding account archive/restore so the check-in's "active accounts" list is always accurate.

**Architecture:** Purely additive Prisma models (`PaydayCheckin`, `PaydayAccountSnapshot`, `PaydayPlanAllocation`) plus an `Account.status`/`archivedAt` lifecycle and a `Category.isEssentialFixed` flag. A pure calculation module (`src/lib/payday.ts`) implements the planning formula and is exercised by `scripts/verify-domain.ts`, the codebase's existing (only) test harness. A server-side data loader (`src/lib/data/payday.ts`) assembles a `PaydayCheckinDraft` from live data (or from a previously confirmed check-in, for safe re-editing) for a client wizard (`PaydayCheckinDialog`) modeled on the existing `CsvImporter`: all step state lives in the client, and one final submit posts a JSON payload (validated server-side with `zod`, mirroring `importTransactionsAction`) to a single `confirmPaydayCheckinAction` that does the entire write — snapshots, reconciled income transactions, the check-in row, plan-allocation audit rows, and half-month Budget rows — inside one `prisma.$transaction`. The server never trusts client-sent "recommended" figures; it recomputes them itself from live data and only accepts the user's edited "planned" values.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components + Server Actions, Prisma 7 / PostgreSQL, Tailwind v4 + shadcn/radix-ui components, Zod, no test framework (extend `scripts/verify-domain.ts`).

**Spec:** The full spec is the user's original task message in this conversation (payday check-in + smart budget planner: core decisions, financial planning model, data model, UX flow, integrity rules, testing and acceptance criteria). There is no separate spec file on disk — this plan is the only artifact deriving from it; read the "Global Constraints" below before any task, they are the non-negotiable rules from that spec.

## Global Constraints

- Business dates always go through `src/lib/date.ts`'s `today()`/`appTimeZone()` — never `new Date()` or `process.env.APP_TIMEZONE` directly.
- Pay periods always go through `src/lib/period.ts` — never hand-roll 1-15/16-end math.
- Cross-currency comparisons always go through `convert()` in `src/lib/currency.ts` (USD-mediated). Never overwrite an original transaction/goal/recurring-item's own stored currency.
- Reported-balance differences are diagnostic only — never auto-create a transaction from them.
- Income transactions are created only when a check-in is **confirmed**, dated with `today()`, never counting opening balances/transfers/reconciliation differences as income.
- Planned goal/category/buffer/carryover amounts are **never** written as actual `GoalContribution` rows or actual expense transactions — only as `PaydayPlanAllocation` audit rows and (for essential/flexible categories only) `Budget` rows.
- The planner must never recommend a plan with zero buffer, and must never silently shrink the buffer or a goal's required roadmap contribution to make totals balance — surface the deficit instead.
- Archiving an account must never delete or alter its financial history. Permanent deletion stays blocked while any history exists.
- Every new user-facing string is added to **both** `src/lib/i18n/en.ts` and `src/lib/i18n/es.ts` in the same task, keeping the `es.ts` `satisfies Dictionary` check green — no English leaks into the Spanish UI.
- No new test framework. This repo's only verification tool is `npx tsx scripts/verify-domain.ts` (run against a scratch Postgres — never a database with real data) using its existing `check(name, condition)` / `eq(name, actual, expected)` helpers. Every task that adds calculation logic adds assertions to that script in the same task or a directly-following task; there is no red/green unit-test runner to cycle against, so "write the test" here means "add a `check`/`eq` block to `scripts/verify-domain.ts` and run the whole script," not a new isolated test file.
- Run `npm run typecheck` and `npm run lint` after any task that touches `.ts`/`.tsx` files with compile-sensitive changes (new Prisma fields/enums, new dictionary keys, new component props) before moving on — don't let type errors accumulate across tasks.
- Prisma client types regenerate via `npx prisma generate` (also runs automatically on `npm run build` and `postinstall`) — run it manually after every schema change before typechecking.

---

## Task 1: Prisma schema — Account lifecycle, Category essential-fixed flag, Settings planning preferences, new TransactionSource value, and the three new Payday models

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a new migration folder under `prisma/migrations/` (generated by the Prisma CLI, not hand-written)

**Interfaces:**
- Produces: `AccountStatus` enum (`ACTIVE`, `ARCHIVED`), `Account.status`/`Account.archivedAt`, `Category.isEssentialFixed`, `Settings.bufferPercent`/`bufferFloorAmount`/`bufferFloorCurrency`/`carryoverIncludedByDefault`/`checkinPromptDismissedOn`, `TransactionSource.PAYDAY_CHECKIN`, `PaydayCheckinStatus` enum (`DRAFT`, `CONFIRMED`), `PaydayAllocationType` enum, and the `PaydayCheckin` / `PaydayAccountSnapshot` / `PaydayPlanAllocation` models — every later task's Prisma queries depend on these exact field names.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add `ARCHIVED` support to Account. Change:
```prisma
model Account {
  id                 String              @id @default(cuid())
  name               String
  currency           String
  type               AccountType         @default(CHECKING)
  createdAt          DateTime            @default(now())
  transactions       Transaction[]
  stagedTransactions StagedTransaction[]

  @@index([name])
}
```
to:
```prisma
enum AccountStatus {
  ACTIVE
  ARCHIVED
}

model Account {
  id                 String                  @id @default(cuid())
  name               String
  currency           String
  type               AccountType             @default(CHECKING)
  status             AccountStatus           @default(ACTIVE)
  archivedAt         DateTime?
  createdAt          DateTime                @default(now())
  transactions       Transaction[]
  stagedTransactions StagedTransaction[]
  paydaySnapshots    PaydayAccountSnapshot[]

  @@index([name])
  @@index([status, name])
}
```

Add `isEssentialFixed` to Category. Change:
```prisma
model Category {
  id                    String              @id @default(cuid())
  name                  String              @unique
  kind                  CategoryKind        @default(EXPENSE)
  isSubscriptionDefault Boolean             @default(false)
  /// Marks the category whose expense transactions count as savings/investing
  /// rather than lifestyle spending in the monthly pace feature (src/lib/data/monthly.ts).
  isSavingsDefault      Boolean             @default(false)
  color                 String              @default("#7a8590")
  icon                  String?
  createdAt             DateTime            @default(now())
  transactions          Transaction[]
  budgets               Budget[]
  recurringItems        RecurringItem[]
  stagedTransactions    StagedTransaction[]

  @@index([kind])
}
```
to:
```prisma
model Category {
  id                    String                 @id @default(cuid())
  name                  String                 @unique
  kind                  CategoryKind           @default(EXPENSE)
  isSubscriptionDefault Boolean                @default(false)
  /// Marks the category whose expense transactions count as savings/investing
  /// rather than lifestyle spending in the monthly pace feature (src/lib/data/monthly.ts).
  isSavingsDefault      Boolean                @default(false)
  /// User-configured: this category is essential fixed spending, so the payday
  /// planner reserves it before flexible category suggestions instead of
  /// treating it as discretionary. Never inferred from the category's name.
  isEssentialFixed      Boolean                @default(false)
  color                 String                 @default("#7a8590")
  icon                  String?
  createdAt             DateTime               @default(now())
  transactions          Transaction[]
  budgets               Budget[]
  recurringItems        RecurringItem[]
  stagedTransactions    StagedTransaction[]
  paydayAllocations     PaydayPlanAllocation[]

  @@index([kind])
}
```

Add `PAYDAY_CHECKIN` to the source enum:
```prisma
enum TransactionSource {
  MANUAL
  CSV
  GMAIL
  OUTLOOK
  PAYPAL
  PAYDAY_CHECKIN
}
```

Add planning preferences to Settings. Change:
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
to:
```prisma
model Settings {
  id                         String    @id @default("singleton")
  pinHash                    String?
  displayCurrency            String    @default("USD")
  language                   String    @default("en")
  /// Payday planner: default protected buffer = max(bufferPercent% of income, bufferFloorAmount).
  bufferPercent               Int      @default(10)
  bufferFloorAmount           Decimal  @default(2000) @db.Decimal(14, 2)
  bufferFloorCurrency         String   @default("DOP")
  carryoverIncludedByDefault  Boolean  @default(true)
  /// The civil date (APP_TIMEZONE) the user last dismissed the auto-opened
  /// payday check-in prompt, so it doesn't force-open again the same day.
  checkinPromptDismissedOn    DateTime? @db.Date
  createdAt                  DateTime  @default(now())
  updatedAt                  DateTime  @updatedAt
}
```

Add the three new models plus reverse relations on `Goal` and `RecurringItem`. Change:
```prisma
model Goal {
  id           String    @id @default(cuid())
  name         String
  targetAmount Decimal   @db.Decimal(14, 2)
  currency     String
  targetDate   DateTime? @db.Date
  /// Cached sum of contributions. GoalContribution is the source of truth;
  /// see recomputeGoalSaved() in src/lib/goals.ts.
  savedAmount  Decimal   @default(0) @db.Decimal(14, 2)
  createdAt    DateTime  @default(now())
  achievedAt   DateTime?

  contributions GoalContribution[]
}
```
to:
```prisma
model Goal {
  id           String    @id @default(cuid())
  name         String
  targetAmount Decimal   @db.Decimal(14, 2)
  currency     String
  targetDate   DateTime? @db.Date
  /// Cached sum of contributions. GoalContribution is the source of truth;
  /// see recomputeGoalSaved() in src/lib/goals.ts.
  savedAmount  Decimal   @default(0) @db.Decimal(14, 2)
  createdAt    DateTime  @default(now())
  achievedAt   DateTime?

  contributions     GoalContribution[]
  paydayAllocations PaydayPlanAllocation[]
}
```

Change:
```prisma
model RecurringItem {
  id           String             @id @default(cuid())
  name         String
  amount       Decimal            @db.Decimal(14, 2)
  currency     String
  frequency    RecurringFrequency
  kind         RecurringKind
  nextDate     DateTime           @db.Date
  active       Boolean            @default(true)
  categoryId   String?
  note         String?
  /// Set by Phase 2 auto-detection; unused for now.
  detectedFrom TransactionSource?
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  category Category? @relation(fields: [categoryId], references: [id], onDelete: SetNull)

  @@index([active, nextDate])
  @@index([kind])
}
```
to:
```prisma
model RecurringItem {
  id           String             @id @default(cuid())
  name         String
  amount       Decimal            @db.Decimal(14, 2)
  currency     String
  frequency    RecurringFrequency
  kind         RecurringKind
  nextDate     DateTime           @db.Date
  active       Boolean            @default(true)
  categoryId   String?
  note         String?
  /// Set by Phase 2 auto-detection; unused for now.
  detectedFrom TransactionSource?
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  category          Category?               @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  paydayAllocations PaydayPlanAllocation[]

  @@index([active, nextDate])
  @@index([kind])
}
```

Finally, append these new enums and models at the end of the file (after `ExchangeRate`):
```prisma
enum PaydayCheckinStatus {
  DRAFT
  CONFIRMED
}

enum PaydayAllocationType {
  SUBSCRIPTION
  RECURRING_CONTRIBUTION
  GOAL
  ESSENTIAL_CATEGORY
  FLEXIBLE_CATEGORY
  BUFFER
  CARRYOVER
}

/// One row per pay period the user has checked in for. Confirming a check-in
/// creates its income transactions and snapshots; re-confirming an existing
/// CONFIRMED row updates it in place rather than duplicating anything - see
/// confirmPaydayCheckinAction in src/server/actions/payday.ts.
model PaydayCheckin {
  id                String              @id @default(cuid())
  year              Int
  month             Int
  period            PayPeriod
  checkinDate       DateTime            @db.Date
  currency          String
  totalIncome       Decimal             @default(0) @db.Decimal(14, 2)
  includedCarryover Decimal             @default(0) @db.Decimal(14, 2)
  protectedBuffer   Decimal             @default(0) @db.Decimal(14, 2)
  status            PaydayCheckinStatus @default(DRAFT)
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  snapshots   PaydayAccountSnapshot[]
  allocations PaydayPlanAllocation[]

  @@unique([year, month, period])
  @@index([status])
}

/// A reported-balance-vs-ledger reconciliation snapshot for one account in one
/// check-in. Never mutates Account/Transaction data - see getAccountBalances
/// in src/lib/data/accounts.ts for how expectedLedgerBalance is computed.
model PaydayAccountSnapshot {
  id                    String   @id @default(cuid())
  paydayCheckinId       String
  accountId             String
  expectedLedgerBalance Decimal  @db.Decimal(14, 2)
  reportedBalance       Decimal  @db.Decimal(14, 2)
  difference            Decimal  @db.Decimal(14, 2)
  incomeEntered         Decimal  @default(0) @db.Decimal(14, 2)
  incomeNote            String?
  /// The actual INCOME Transaction created for incomeEntered > 0, if any - so
  /// re-confirming updates/removes that one row instead of creating another.
  incomeTransactionId   String?  @unique
  currency              String
  createdAt             DateTime @default(now())

  checkin PaydayCheckin @relation(fields: [paydayCheckinId], references: [id], onDelete: Cascade)
  account Account       @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@unique([paydayCheckinId, accountId])
}

/// Why/how each dollar in a confirmed plan was reserved or suggested - an audit
/// trail alongside the real Budget rows the plan writes. Never itself an actual
/// expense, GoalContribution, or transaction.
model PaydayPlanAllocation {
  id                String               @id @default(cuid())
  paydayCheckinId   String
  type              PaydayAllocationType
  categoryId        String?
  goalId            String?
  recurringItemId   String?
  recommendedAmount Decimal              @db.Decimal(14, 2)
  plannedAmount     Decimal              @db.Decimal(14, 2)
  currency          String
  basis             String?
  note              String?
  createdAt         DateTime             @default(now())

  checkin       PaydayCheckin  @relation(fields: [paydayCheckinId], references: [id], onDelete: Cascade)
  category      Category?      @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  goal          Goal?          @relation(fields: [goalId], references: [id], onDelete: SetNull)
  recurringItem RecurringItem? @relation(fields: [recurringItemId], references: [id], onDelete: SetNull)

  @@index([paydayCheckinId, type])
}
```

- [ ] **Step 2: Generate and apply the migration locally**

Run (requires the local Postgres from `DATABASE_URL` in `.env` to be running, per README setup):
```bash
npx prisma migrate dev --name add_payday_checkin_and_account_archive
```
This both writes `prisma/migrations/<timestamp>_add_payday_checkin_and_account_archive/migration.sql` and applies it to your local database, then runs `prisma generate`.

Expected: the CLI reports the migration applied successfully with no data loss warnings (every change here is additive - new nullable/defaulted columns, new enums, new tables - so no destructive-change confirmation prompt should appear). If the CLI does prompt about a destructive change, stop and re-check the schema diff above before continuing - none of these fields should require one.

- [ ] **Step 3: Verify the generated client picks up the new types**

Run:
```bash
npx prisma generate && npm run typecheck
```
Expected: both succeed. `npm run typecheck` will still fail here because no code references the new fields yet - confirm the *only* errors (if any) are pre-existing, i.e. this step should pass cleanly since nothing in `src/` uses the new fields yet.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "db: add account archive lifecycle, essential-fixed categories, planning settings, and payday check-in models"
```

---

## Task 2: `isPaydayDate` helper and payday-planning pure logic module

**Files:**
- Modify: `src/lib/period.ts`
- Create: `src/lib/payday.ts`
- Test: `scripts/verify-domain.ts` (append assertions)

**Interfaces:**
- Consumes: `PERIOD_A_LAST_DAY`, `startOfDay`, `daysInMonth` (already in `src/lib/period.ts`/`src/lib/date.ts`); `round2` from `src/lib/money.ts`.
- Produces: `isPaydayDate(date: Date): boolean` from `src/lib/period.ts`; `defaultProtectedBuffer(incomeTotal: number, bufferPercent: number, floorAmount: number): number`, `availableForFlexibleCategories(input: FlexibleInput): number` (and the `FlexibleInput` type), `scaleFlexibleSuggestions(suggestions: {id: string; suggested: number}[], available: number): {id: string; suggested: number; scaled: number}[]` from the new `src/lib/payday.ts` — Task 5's data loader and Task 6's server action both import these.

- [ ] **Step 1: Add `isPaydayDate` to `src/lib/period.ts`**

Add this export right after `PERIOD_A_LAST_DAY` (needs `daysInMonth`, already imported at the top of the file from `@/lib/date`):
```ts
/** True on the 15th or the actual last calendar day of the month (Feb/leap-year safe). */
export function isPaydayDate(date: Date): boolean {
  const day = startOfDay(date);
  const dayOfMonth = day.getUTCDate();
  const lastDay = daysInMonth(day.getUTCFullYear(), day.getUTCMonth() + 1);
  return dayOfMonth === PERIOD_A_LAST_DAY || dayOfMonth === lastDay;
}
```

- [ ] **Step 2: Create `src/lib/payday.ts`**

```ts
/**
 * Pure calculation logic for the payday check-in / smart budget planner.
 * No I/O here - src/lib/data/payday.ts assembles the inputs from Prisma and
 * src/server/actions/payday.ts recomputes the same functions server-side
 * before persisting a confirmed plan, so the numbers a user sees are always
 * exactly what gets written.
 */
import { round2 } from "@/lib/money";

/** max(bufferPercent% of this check-in's income, the configured floor). Never zero unless the floor itself is zero. */
export function defaultProtectedBuffer(
  incomeTotal: number,
  bufferPercent: number,
  floorAmount: number,
): number {
  const percentOfIncome = (Math.max(0, incomeTotal) * bufferPercent) / 100;
  return round2(Math.max(percentOfIncome, floorAmount));
}

export interface FlexibleInput {
  income: number;
  includedCarryover: number;
  subscriptions: number;
  recurringContributions: number;
  goalPlan: number;
  essentialFixed: number;
  buffer: number;
}

/**
 * availableForFlexibleCategories = income + carryover - subscriptions -
 * recurringContributions - goalPlan - essentialFixed - buffer. Can be
 * negative - callers must show that as a deficit, never clamp it to zero.
 */
export function availableForFlexibleCategories(input: FlexibleInput): number {
  return round2(
    input.income +
      input.includedCarryover -
      input.subscriptions -
      input.recurringContributions -
      input.goalPlan -
      input.essentialFixed -
      input.buffer,
  );
}

export interface FlexibleSuggestion {
  id: string;
  suggested: number;
}

export interface ScaledFlexibleSuggestion extends FlexibleSuggestion {
  scaled: number;
}

/**
 * Scales suggested flexible-category amounts down proportionally so they never
 * sum past `available`. If available <= 0, every suggestion scales to 0 - the
 * planner must not suggest spending money that doesn't exist. If the raw
 * suggestions already fit, they pass through unscaled.
 */
export function scaleFlexibleSuggestions(
  suggestions: FlexibleSuggestion[],
  available: number,
): ScaledFlexibleSuggestion[] {
  if (available <= 0) {
    return suggestions.map((s) => ({ ...s, scaled: 0 }));
  }
  const total = suggestions.reduce((sum, s) => sum + s.suggested, 0);
  if (total <= available || total === 0) {
    return suggestions.map((s) => ({ ...s, scaled: round2(s.suggested) }));
  }
  const factor = available / total;
  return suggestions.map((s) => ({ ...s, scaled: round2(s.suggested * factor) }));
}
```

- [ ] **Step 3: Append assertions to `scripts/verify-domain.ts`**

Add these imports to the top of the file, alongside the existing `@/lib/period` import block:
```ts
import { isPaydayDate } from "@/lib/period";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "@/lib/payday";
```

Add a new section right before the final `console.log("\n== cleanup ==")` block:
```ts
  console.log("\n== payday planner (pure) ==");
  eq("the 15th is a payday date", isPaydayDate(civilDate(2026, 8, 15)), true);
  eq("Aug 31 is a payday date", isPaydayDate(civilDate(2026, 8, 31)), true);
  eq("Feb 28 2026 (non-leap) is a payday date", isPaydayDate(civilDate(2026, 2, 28)), true);
  eq("Feb 29 2024 (leap) is a payday date", isPaydayDate(civilDate(2024, 2, 29)), true);
  eq("Feb 28 2024 (leap, not last day) is not a payday date", isPaydayDate(civilDate(2024, 2, 28)), false);
  eq("the 16th is not a payday date", isPaydayDate(civilDate(2026, 8, 16)), false);
  eq("the 1st is not a payday date", isPaydayDate(civilDate(2026, 8, 1)), false);

  eq("buffer = 10% of income when that beats the floor", defaultProtectedBuffer(50000, 10, 2000), 5000);
  eq("buffer falls back to the floor when 10% of income is smaller", defaultProtectedBuffer(1000, 10, 2000), 2000);
  eq("zero income still yields the floor, never zero", defaultProtectedBuffer(0, 10, 2000), 2000);

  eq(
    "available flexible money follows the exact formula",
    availableForFlexibleCategories({
      income: 40000,
      includedCarryover: 2000,
      subscriptions: 3000,
      recurringContributions: 5000,
      goalPlan: 6000,
      essentialFixed: 8000,
      buffer: 4000,
    }),
    16000,
  );
  eq(
    "a shortfall shows as a negative amount, not zero",
    availableForFlexibleCategories({
      income: 10000,
      includedCarryover: 0,
      subscriptions: 3000,
      recurringContributions: 5000,
      goalPlan: 6000,
      essentialFixed: 0,
      buffer: 2000,
    }),
    -6000,
  );

  const suggestions = [
    { id: "groceries", suggested: 6000 },
    { id: "dining", suggested: 3000 },
    { id: "shopping", suggested: 1000 },
  ];
  const fits = scaleFlexibleSuggestions(suggestions, 20000);
  eq("suggestions that already fit pass through unscaled", fits.map((s) => s.scaled).join(","), "6000,3000,1000");
  const scaled = scaleFlexibleSuggestions(suggestions, 5000);
  eq("over-budget suggestions scale down proportionally", scaled.map((s) => s.scaled).join(","), "3000,1500,500");
  const deficit = scaleFlexibleSuggestions(suggestions, -500);
  eq("a deficit scales every suggestion to zero, never negative", deficit.every((s) => s.scaled === 0), true);
```

- [ ] **Step 4: Run the verification script**

```bash
DATABASE_URL="<your scratch db url>" npx tsx scripts/verify-domain.ts
```
Expected: every new line under `== payday planner (pure) ==` prints `ok`, and the final line still reads `All checks passed.`

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/period.ts src/lib/payday.ts scripts/verify-domain.ts
git commit -m "feat: add payday-date detection and the payday planner's pure calculation logic"
```

---

## Task 3: Account archive/restore — data layer and server actions

**Files:**
- Modify: `src/lib/data/accounts.ts`
- Modify: `src/server/actions/accounts.ts`
- Modify: `src/app/(app)/transactions/page.tsx`, `src/app/(app)/transactions/import/page.tsx`, `src/app/(app)/review/page.tsx` (filter account pickers to active-only)
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts`
- Test: `scripts/verify-domain.ts`

**Interfaces:**
- Produces: `getAccountBalances(context, options?: { status?: "ACTIVE" | "ARCHIVED" | "ALL" }): Promise<AccountBalance[]>` (new optional second arg, `AccountBalance` gains a `status` field), `archiveAccountAction`, `restoreAccountAction` (both the standard `(ActionState, FormData) => Promise<ActionState>` shape) — Task 4's Accounts page and Task 8's dashboard/wizard both call `getAccountBalances` with `{ status: "ACTIVE" }` (the default) to get the dynamic active-account list the spec requires.

- [ ] **Step 1: Update `getAccountBalances` in `src/lib/data/accounts.ts`**

Change the top of the file and the function signature:
```ts
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { balanceSign } from "@/lib/transactions";

import type { AppContext } from "@/lib/data/context";
import type { AccountStatus, AccountType } from "@/generated/prisma/enums";

export interface AccountBalance {
  id: string;
  name: string;
  type: AccountType;
  status: AccountStatus;
  currency: string;
  createdAt: Date;
  /** In the account's own currency. */
  balance: number;
  /** Same balance converted to the selected display currency. */
  displayBalance: number;
  transactionCount: number;
}

export type AccountStatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

/**
 * Balances are aggregated in SQL per (account, type, currency, direction) and
 * converted afterwards, so a foreign-currency transaction lands in the account's
 * own currency. Transfers net to zero across their two legs.
 *
 * Defaults to active accounts only - the dynamic "active accounts" list the
 * payday check-in and every "pick an account" selector must use. Pass
 * { status: "ARCHIVED" } or { status: "ALL" } for historical/admin views.
 */
export async function getAccountBalances(
  context: AppContext,
  options: { status?: AccountStatusFilter } = {},
): Promise<AccountBalance[]> {
  const status = options.status ?? "ACTIVE";
  const [accounts, groups, counts] = await Promise.all([
    prisma.account.findMany({
      where: status === "ALL" ? undefined : { status },
      orderBy: { name: "asc" },
    }),
    prisma.transaction.groupBy({
      by: ["accountId", "type", "currency", "transferDirection"],
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({ by: ["accountId"], _count: { _all: true } }),
  ]);
```

Then, inside the `accounts.map(...)` return object, add the `status` field:
```ts
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      status: account.status,
      currency: account.currency,
      createdAt: account.createdAt,
      balance: round2(balance),
      displayBalance: round2(
        convert(balance, account.currency, context.displayCurrency, context.rates),
      ),
      transactionCount: countByAccount.get(account.id) ?? 0,
    };
```
(The `groups`/`counts` queries stay unfiltered by status - `getAccountLedger` and every other balance/history read already looks accounts up by id directly, so archived accounts keep computing correctly wherever they're referenced by id; only the *listing* query is filtered.)

- [ ] **Step 2: Rewrite the account server actions in `src/server/actions/accounts.ts`**

Replace the whole file with:
```ts
"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { accountSchema, firstError, formObject } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function saveAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const parsed = accountSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  if (id) {
    await prisma.account.update({ where: { id }, data: values });
  } else {
    await prisma.account.create({ data: values });
  }

  revalidateApp();
  return done(id ? t.accountUpdated : t.accountAdded);
}

export async function archiveAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.accountNoLongerExists);

  await prisma.account.update({
    where: { id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });

  revalidateApp();
  return done(t.accountArchived);
}

export async function restoreAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.accountNoLongerExists);

  await prisma.account.update({
    where: { id },
    data: { status: "ACTIVE", archivedAt: null },
  });

  revalidateApp();
  return done(t.accountRestored);
}

/**
 * Permanent deletion is only safe when the account has no financial history at
 * all - transactions (including both legs of a transfer, since a transfer leg
 * is a Transaction row on this account), staged items awaiting review, and
 * payday check-in snapshots. Anything else must be archived instead.
 */
export async function deleteAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(common.nothingToDelete);

  const [transactionCount, stagedCount, snapshotCount] = await Promise.all([
    prisma.transaction.count({ where: { accountId: id } }),
    prisma.stagedTransaction.count({ where: { accountId: id } }),
    prisma.paydayAccountSnapshot.count({ where: { accountId: id } }),
  ]);
  if (transactionCount > 0 || stagedCount > 0 || snapshotCount > 0) {
    return fail(t.archiveInstead);
  }

  await prisma.account.delete({ where: { id } });

  revalidateApp();
  return done(t.accountDeleted);
}
```

- [ ] **Step 3: Filter the three raw account pickers to active-only**

In `src/app/(app)/transactions/page.tsx`, `src/app/(app)/transactions/import/page.tsx`, and `src/app/(app)/review/page.tsx`, each has a call shaped like:
```ts
    prisma.account.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
```
Add `where: { status: "ACTIVE" },` to each (after `orderBy`, before `select`). These three lists are all "pick an account to put a new/approved transaction into," which the spec restricts to active accounts. (The `TransactionFilters` "filter by account" dropdown on the transactions page shares this same narrowed list as a deliberate simplification - filtering existing rows by an archived account's name is out of scope for this feature.)

- [ ] **Step 4: Add the new `accounts` dictionary keys to `src/lib/i18n/en.ts`**

In the `accounts` section, right after `accountDeleted: "Account deleted",`, add:
```ts
    accountArchived: "Account archived",
    accountRestored: "Account restored",
    accountNoLongerExists: "That account no longer exists",
    archiveAccount: "Archive account",
    restoreAccount: "Restore account",
    archiveAccountTitle: (name: string) => `Archive ${name}?`,
    archiveAccountDescription:
      "Its history stays intact everywhere it already appears - it just stops showing up when picking an account for something new.",
    archiveInstead: "Archive it instead - it has financial history to keep.",
    deletePermanently: "Delete permanently",
    activeTab: "Active",
    archivedTab: "Archived",
    noArchivedAccountsTitle: "No archived accounts",
    noArchivedAccountsDescription:
      "Accounts you archive keep their full history and show up here.",
    archivedBadge: "Archived",
```

- [ ] **Step 5: Add the matching Spanish keys to `src/lib/i18n/es.ts`**

In the `accounts` section, right after `accountDeleted: "Cuenta eliminada",` (or the equivalent existing line - match whatever the current Spanish `accountDeleted` line reads), add:
```ts
    accountArchived: "Cuenta archivada",
    accountRestored: "Cuenta restaurada",
    accountNoLongerExists: "Esa cuenta ya no existe",
    archiveAccount: "Archivar cuenta",
    restoreAccount: "Restaurar cuenta",
    archiveAccountTitle: (name: string) => `¿Archivar ${name}?`,
    archiveAccountDescription:
      "Su historial se mantiene intacto donde ya aparece - solo deja de aparecer al elegir una cuenta para algo nuevo.",
    archiveInstead: "Archívala en su lugar - tiene historial financiero que conservar.",
    deletePermanently: "Eliminar permanentemente",
    activeTab: "Activas",
    archivedTab: "Archivadas",
    noArchivedAccountsTitle: "No hay cuentas archivadas",
    noArchivedAccountsDescription:
      "Las cuentas que archives conservan su historial completo y aparecen aquí.",
    archivedBadge: "Archivada",
```

- [ ] **Step 6: Append account-lifecycle assertions to `scripts/verify-domain.ts`**

Add this section right before `console.log("\n== cleanup ==")` (after the payday-planner section added in Task 2):
```ts
  console.log("\n== account archive lifecycle ==");
  const { getAccountBalances } = await import("../src/lib/data/accounts");
  const archiveTestAccount = await prisma.account.create({
    data: { name: "Verify Archive Me", currency: "USD", type: "CHECKING" },
  });
  let activeList = await getAccountBalances(context);
  check(
    "a fresh account is active by default and appears in the active list",
    activeList.some((a) => a.id === archiveTestAccount.id),
  );

  await prisma.account.update({
    where: { id: archiveTestAccount.id },
    data: { status: "ARCHIVED", archivedAt: context.today },
  });
  activeList = await getAccountBalances(context);
  check(
    "an archived account disappears from the active list",
    !activeList.some((a) => a.id === archiveTestAccount.id),
  );
  const archivedList = await getAccountBalances(context, { status: "ARCHIVED" });
  check(
    "the archived account still appears in the archived list",
    archivedList.some((a) => a.id === archiveTestAccount.id),
  );

  await prisma.transaction.create({
    data: {
      date: context.today,
      amount: 25,
      currency: "USD",
      type: "EXPENSE",
      accountId: archiveTestAccount.id,
      source: "MANUAL",
    },
  });
  const { getAccountLedger } = await import("../src/lib/data/accounts");
  const archivedLedger = await getAccountLedger(archiveTestAccount.id, context);
  eq(
    "an archived account's transactions and balance stay fully readable",
    archivedLedger?.rows.length,
    1,
  );

  const { deleteAccountAction, restoreAccountAction } = await import(
    "../src/server/actions/accounts"
  );
  const blockedDelete = new FormData();
  blockedDelete.set("id", archiveTestAccount.id);
  const blockedResult = await deleteAccountAction(null, blockedDelete);
  check(
    "permanent delete is blocked while transaction history exists",
    blockedResult?.ok === false,
  );
  const stillThere = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  check("the blocked account was not deleted", Boolean(stillThere));

  const restoreForm = new FormData();
  restoreForm.set("id", archiveTestAccount.id);
  await restoreAccountAction(null, restoreForm);
  const restored = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  eq("restore sets status back to ACTIVE", restored?.status, "ACTIVE");
  eq("restore clears archivedAt", restored?.archivedAt, null);

  await prisma.transaction.deleteMany({ where: { accountId: archiveTestAccount.id } });
  const cleanDeleteForm = new FormData();
  cleanDeleteForm.set("id", archiveTestAccount.id);
  const cleanDeleteResult = await deleteAccountAction(null, cleanDeleteForm);
  check(
    "permanent delete succeeds once no history remains",
    cleanDeleteResult?.ok === true,
  );
  const gone = await prisma.account.findUnique({ where: { id: archiveTestAccount.id } });
  check("the account is actually gone", gone === null);
```

- [ ] **Step 7: Run the verification script and typecheck**

```bash
DATABASE_URL="<your scratch db url>" npx tsx scripts/verify-domain.ts
npm run typecheck
```
Expected: every new `== account archive lifecycle ==` line prints `ok`, `All checks passed.` at the end, and `typecheck` is clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/data/accounts.ts src/server/actions/accounts.ts \
  "src/app/(app)/transactions/page.tsx" "src/app/(app)/transactions/import/page.tsx" \
  "src/app/(app)/review/page.tsx" src/lib/i18n/en.ts src/lib/i18n/es.ts scripts/verify-domain.ts
git commit -m "feat: add account archive/restore with history-aware permanent delete"
```

---

## Task 4: Accounts page — Active/Archived tabs and row actions

**Files:**
- Modify: `src/components/accounts/account-row-actions.tsx`
- Modify: `src/app/(app)/accounts/page.tsx`

**Interfaces:**
- Consumes: `getAccountBalances`, `archiveAccountAction`, `restoreAccountAction`, `deleteAccountAction` from Task 3; `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `@/components/ui/tabs`; `Badge` from `@/components/ui/badge` (variant `"outline"` exists).
- Produces: `AccountRowActions` now takes `account: { ...; status: string }` (was missing `status`) — no other consumer of this component exists outside this page.

- [ ] **Step 1: Replace `src/components/accounts/account-row-actions.tsx`**

```tsx
"use client";

import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { ConfirmDelete } from "@/components/form/confirm-delete";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getDictionary, type Locale } from "@/lib/i18n";
import {
  archiveAccountAction,
  deleteAccountAction,
  restoreAccountAction,
} from "@/server/actions/accounts";

export function AccountRowActions({
  account,
  locale,
}: {
  account: {
    id: string;
    name: string;
    type: string;
    status: string;
    currency: string;
    transactionCount: number;
  };
  locale: Locale;
}) {
  const t = getDictionary(locale).accounts;
  const common = getDictionary(locale).common;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isArchived = account.status === "ARCHIVED";

  async function runLifecycleAction(
    action: (state: null, formData: FormData) => Promise<{ ok: boolean; error?: string; message?: string } | null>,
    fallbackMessage: string,
  ) {
    const form = new FormData();
    form.set("id", account.id);
    const result = await action(null, form);
    if (result?.ok) toast.success(result.message ?? fallbackMessage);
    else if (result?.error) toast.error(result.error);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t.actionsFor(account.name)}>
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isArchived ? (
            <DropdownMenuItem
              onSelect={() => runLifecycleAction(restoreAccountAction, t.accountRestored)}
            >
              <ArchiveRestore className="size-3.5" />
              {t.restoreAccount}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                {common.edit}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => runLifecycleAction(archiveAccountAction, t.accountArchived)}
              >
                <Archive className="size-3.5" />
                {t.archiveAccount}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 className="size-3.5" />
            {isArchived ? t.deletePermanently : common.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <AccountDialog
          open
          onOpenChange={(next) => !next && setEditing(false)}
          locale={locale}
          values={{
            id: account.id,
            name: account.name,
            type: account.type,
            currency: account.currency,
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDelete
          open
          onOpenChange={(next) => !next && setDeleting(false)}
          id={account.id}
          action={deleteAccountAction}
          title={t.deleteAccountTitle(account.name)}
          description={
            account.transactionCount > 0
              ? t.transactionsGoWithIt(account.transactionCount)
              : t.noTransactions
          }
          confirmLabel={isArchived ? t.deletePermanently : common.delete}
          keepLabel={common.keepIt}
          deletedMessage={t.accountDeleted}
        />
      ) : null}
    </>
  );
}
```
Note: `deleteAccountAction` now fails with `t.archiveInstead` instead of deleting when history exists (Task 3) - `ConfirmDelete` already renders `state.error` inline, so that message surfaces correctly with no changes needed to `ConfirmDelete` itself.

- [ ] **Step 2: Replace `src/app/(app)/accounts/page.tsx`**

```tsx
import { Plus } from "lucide-react";
import Link from "next/link";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { AccountRowActions } from "@/components/accounts/account-row-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { getAccountBalances, type AccountBalance } from "@/lib/data/accounts";
import { getAppContext } from "@/lib/data/context";
import { getDictionary, type Dictionary, type Locale } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";

export const metadata = { title: "Accounts - Cadence" };

export default async function AccountsPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).accounts;
  const common = getDictionary(context.language).common;
  const [active, archived] = await Promise.all([
    getAccountBalances(context, { status: "ACTIVE" }),
    getAccountBalances(context, { status: "ARCHIVED" }),
  ]);
  const net = active.reduce((total, account) => total + account.displayBalance, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={
          active.length > 0
            ? t.acrossAccounts(formatMoney(net, context.displayCurrency), active.length)
            : t.whereMoneySits
        }
        actions={
          <AccountDialog
            values={{ currency: context.displayCurrency }}
            locale={context.language}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                {t.newAccount}
              </Button>
            }
          />
        }
      />

      {active.length === 0 && archived.length === 0 ? (
        <EmptyState
          title={t.noAccountsTitle}
          description={t.noAccountsDescription}
          action={
            <AccountDialog
              values={{ currency: context.displayCurrency }}
              locale={context.language}
              trigger={<Button size="sm">{t.addFirstAccount}</Button>}
            />
          }
        />
      ) : (
        <Tabs defaultValue="active">
          <TabsList>
            <TabsTrigger value="active">{t.activeTab}</TabsTrigger>
            <TabsTrigger value="archived">{t.archivedTab}</TabsTrigger>
          </TabsList>
          <TabsContent value="active">
            {active.length === 0 ? (
              <EmptyState title={t.noAccountsTitle} description={t.noAccountsDescription} />
            ) : (
              <AccountsTable
                accounts={active}
                displayCurrency={context.displayCurrency}
                locale={context.language}
                t={t}
                common={common}
              />
            )}
          </TabsContent>
          <TabsContent value="archived">
            {archived.length === 0 ? (
              <EmptyState
                title={t.noArchivedAccountsTitle}
                description={t.noArchivedAccountsDescription}
              />
            ) : (
              <AccountsTable
                accounts={archived}
                displayCurrency={context.displayCurrency}
                locale={context.language}
                t={t}
                common={common}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function AccountsTable({
  accounts,
  displayCurrency,
  locale,
  t,
  common,
}: {
  accounts: AccountBalance[];
  displayCurrency: string;
  locale: Locale;
  t: Dictionary["accounts"];
  common: Dictionary["common"];
}) {
  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{common.account}</TableHead>
              <TableHead className="hidden sm:table-cell">{t.colType}</TableHead>
              <TableHead className="hidden sm:table-cell">{t.colActivity}</TableHead>
              <TableHead className="text-right">{t.colBalance}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <Link
                    href={`/accounts/${account.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {account.name}
                  </Link>
                  <p className="figure text-[0.6875rem] text-muted-foreground">
                    {account.currency}
                    {account.status === "ARCHIVED" ? (
                      <Badge variant="outline" className="ml-1.5 align-middle">
                        {t.archivedBadge}
                      </Badge>
                    ) : null}
                  </p>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                  {labelFor(common.accountTypeLabels, account.type)}
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground tnum sm:table-cell">
                  {t.transactionCount(account.transactionCount)}
                </TableCell>
                <TableCell className="text-right">
                  <span className="figure text-sm">
                    {formatMoney(account.balance, account.currency)}
                  </span>
                  {account.currency !== displayCurrency ? (
                    <p className="figure text-[0.6875rem] text-muted-foreground">
                      {formatMoney(account.displayBalance, displayCurrency)}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <AccountRowActions account={account} locale={locale} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Manual check**

```bash
npm run dev
```
Visit `/accounts`: confirm the Active tab shows existing accounts, the Archived tab is empty and shows the empty state, and archiving one via the row menu moves it to the Archived tab with its history/balance still correct, and restoring it moves it back.

- [ ] **Step 4: Typecheck, lint, and commit**

```bash
npm run typecheck
npm run lint
git add src/components/accounts/account-row-actions.tsx "src/app/(app)/accounts/page.tsx"
git commit -m "feat: add Active/Archived tabs and archive/restore actions to the Accounts page"
```

---

## Task 5: Payday check-in data loader — `src/lib/data/payday.ts`

**Files:**
- Create: `src/lib/data/payday.ts`

**Interfaces:**
- Consumes: `getAccountBalances` (Task 3), `getPeriodSummary` (existing), `listGoals`/`GoalSummary` (existing), `getSettings` (existing, `@/lib/auth`), `isPaydayDate`/`nextPeriod`/`periodInfo`/`previousPeriod`/`type PeriodRef` (existing + Task 2), `availableForFlexibleCategories`/`defaultProtectedBuffer`/`scaleFlexibleSuggestions` (Task 2), `convert`, `num`/`round2`, `prisma`.
- Produces: `planPeriodRef(context): PeriodRef`, `getPaydayCheckinDraft(context): Promise<PaydayCheckinDraft>`, `getCategorySuggestions(planRef, categories, context): Promise<Map<string, {amount:number; basis:SuggestionBasis}>>`, `getAvailableCarryover(planRef, context): Promise<{amount:number; basis:CarryoverBasis}>`, and the exported types `PaydayCheckinDraft`, `PaydayAccountDraft`, `PaydayCommittedDraft`, `PaydayGoalDraft`, `PaydayCategoryDraft`, `SuggestionBasis`, `CarryoverBasis` — Task 7's server action imports `getCategorySuggestions`/`getAvailableCarryover` directly so its own recomputation is byte-for-byte the same logic the draft used, and Task 10 (wizard UI) and Task 11/12 (dashboard/budgets) import the draft loader and its types.

- [ ] **Step 1: Create `src/lib/data/payday.ts`**

```ts
/**
 * Assembles everything the payday check-in wizard needs to show for the
 * "current plan period" - the period a check-in opened right now would plan
 * for. See planPeriodRef() for why that isn't always context.currentPeriod.
 *
 * Every "recommended"/"suggested" figure here is always computed fresh from
 * live data. When a CONFIRMED check-in already exists for the plan period,
 * this overlays the user's previously *chosen* values (reported balances,
 * income, planned amounts) on top, so re-opening the wizard shows what was
 * actually confirmed rather than re-suggesting from scratch - but it never
 * trusts old data for the recommendations themselves. Task 7's server action
 * repeats this same recomputation before persisting, so nothing the client
 * sends is trusted as a "recommended" figure.
 */
import { getSettings } from "@/lib/auth";
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import {
  availableForFlexibleCategories,
  defaultProtectedBuffer,
  scaleFlexibleSuggestions,
} from "@/lib/payday";
import {
  daysRemainingInPeriod,
  isPaydayDate,
  nextPeriod,
  periodInfo,
  previousPeriod,
  type PeriodRef,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";

import { getAccountBalances } from "@/lib/data/accounts";
import { getPeriodSummary, type CommittedItem } from "@/lib/data/period-summary";
import { listGoals } from "@/lib/data/goals";

import type { AppContext } from "@/lib/data/context";

export interface PaydayAccountDraft {
  accountId: string;
  name: string;
  currency: string;
  type: string;
  expectedLedgerBalance: number;
  reportedBalance: number;
  incomeEntered: number;
  incomeNote: string;
}

export interface PaydayCommittedDraft {
  recurringItemId: string;
  name: string;
  amount: number;
  nativeAmount: number;
  currency: string;
  nextDate: Date;
}

export interface PaydayGoalDraft {
  goalId: string;
  name: string;
  currency: string;
  recommendedAmount: number;
  plannedAmount: number;
  targetDate: Date;
  periodsLeft: number;
}

export type SuggestionBasis = "last_budget" | "average" | "none";

export interface PaydayCategoryDraft {
  categoryId: string;
  name: string;
  color: string;
  suggestedAmount: number;
  plannedAmount: number;
  basis: SuggestionBasis;
}

export type CarryoverBasis = "prior_period_budget" | "no_prior_budget";

export interface PaydayCheckinDraft {
  periodRef: PeriodRef;
  periodLabel: string;
  isEditingConfirmed: boolean;
  checkinId: string | null;
  displayCurrency: string;
  accounts: PaydayAccountDraft[];
  subscriptions: PaydayCommittedDraft[];
  contributions: PaydayCommittedDraft[];
  subscriptionsTotal: number;
  contributionsTotal: number;
  goals: PaydayGoalDraft[];
  essentialCategories: PaydayCategoryDraft[];
  flexibleCategories: PaydayCategoryDraft[];
  suggestedBuffer: number;
  plannedBuffer: number;
  bufferFloor: number;
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  /** Days left in the plan period counting today, for the safe-to-spend-per-day estimate in Step 4 - the full period length when opened exactly on a payday (the period hasn't started yet), fewer when opened partway through an already-current period. */
  daysRemainingInPlanPeriod: number;
}

/**
 * The period a check-in opened right now plans for: the *next* period when
 * today is exactly a payday date (the 15th/last day, i.e. the last day of the
 * period that's ending), otherwise the period containing today (covers
 * opening the wizard a few days into an already-current period).
 */
export function planPeriodRef(context: AppContext): PeriodRef {
  return isPaydayDate(context.today)
    ? nextPeriod(context.currentPeriod)
    : context.currentPeriod;
}

const HISTORY_PERIODS = 6;

/** Exported so Task 7's server action can recompute the exact same suggestions before persisting - never trusting a client-sent "recommended" figure. */
export async function getCategorySuggestions(
  planRef: PeriodRef,
  categories: { id: string }[],
  context: AppContext,
): Promise<Map<string, { amount: number; basis: SuggestionBasis }>> {
  const result = new Map<string, { amount: number; basis: SuggestionBasis }>();
  if (categories.length === 0) return result;
  const categoryIds = categories.map((c) => c.id);

  const prevRef = previousPeriod(planRef);
  const lastBudgets = await prisma.budget.findMany({
    where: {
      year: prevRef.year,
      month: prevRef.month,
      period: prevRef.period,
      categoryId: { in: categoryIds },
    },
  });
  const lastBudgetByCategory = new Map(
    lastBudgets
      .filter((budget) => budget.categoryId && num(budget.amount) > 0)
      .map((budget) => [
        budget.categoryId as string,
        round2(
          convert(num(budget.amount), budget.currency, context.displayCurrency, context.rates),
        ),
      ]),
  );

  const remaining = categoryIds.filter((id) => !lastBudgetByCategory.has(id));
  const historicalTotals = new Map<string, number>();
  const historicalNonZero = new Set<string>();
  if (remaining.length > 0) {
    let cursor = prevRef;
    for (let i = 0; i < HISTORY_PERIODS; i += 1) {
      const summary = await getPeriodSummary(periodInfo(cursor), context);
      for (const line of summary.categories) {
        if (!line.categoryId || !remaining.includes(line.categoryId)) continue;
        historicalTotals.set(line.categoryId, (historicalTotals.get(line.categoryId) ?? 0) + line.spent);
        if (line.spent > 0) historicalNonZero.add(line.categoryId);
      }
      cursor = previousPeriod(previousPeriod(cursor));
    }
  }

  for (const id of categoryIds) {
    const fromBudget = lastBudgetByCategory.get(id);
    if (fromBudget !== undefined) {
      result.set(id, { amount: fromBudget, basis: "last_budget" });
    } else if (historicalNonZero.has(id)) {
      result.set(id, { amount: round2((historicalTotals.get(id) ?? 0) / HISTORY_PERIODS), basis: "average" });
    } else {
      result.set(id, { amount: 0, basis: "none" });
    }
  }
  return result;
}

/**
 * The immediately preceding pay period's own unspent budget - never all
 * account balances, and never fabricated when that period had no budget to
 * measure against. Clamped at 0: an overspent prior period carries nothing
 * forward rather than compounding a deficit into the new plan.
 */
export async function getAvailableCarryover(
  planRef: PeriodRef,
  context: AppContext,
): Promise<{ amount: number; basis: CarryoverBasis }> {
  const prevSummary = await getPeriodSummary(periodInfo(previousPeriod(planRef)), context);
  if (!prevSummary.hasBudget) return { amount: 0, basis: "no_prior_budget" };
  return { amount: round2(Math.max(0, prevSummary.safeToSpend)), basis: "prior_period_budget" };
}

function toCommittedDraft(item: CommittedItem): PaydayCommittedDraft {
  return {
    recurringItemId: item.id,
    name: item.name,
    amount: item.amount,
    nativeAmount: item.nativeAmount,
    currency: item.currency,
    nextDate: item.nextDate,
  };
}

export async function getPaydayCheckinDraft(context: AppContext): Promise<PaydayCheckinDraft> {
  const planRef = planPeriodRef(context);
  const plan = periodInfo(planRef);

  const [accounts, planSummary, allGoals, essentialCategoryRows, flexibleCategoryRows, carryover, settings, existing] =
    await Promise.all([
      getAccountBalances(context, { status: "ACTIVE" }),
      getPeriodSummary(plan, context),
      listGoals(context),
      prisma.category.findMany({
        where: { kind: "EXPENSE", isEssentialFixed: true, isSubscriptionDefault: false, isSavingsDefault: false },
        orderBy: { name: "asc" },
      }),
      prisma.category.findMany({
        where: { kind: "EXPENSE", isEssentialFixed: false, isSubscriptionDefault: false, isSavingsDefault: false },
        orderBy: { name: "asc" },
      }),
      getAvailableCarryover(planRef, context),
      getSettings(),
      prisma.paydayCheckin.findFirst({
        where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
        include: { snapshots: true, allocations: true },
      }),
    ]);

  const existingSnapshotByAccount = new Map((existing?.snapshots ?? []).map((s) => [s.accountId, s]));
  const existingAllocationByKey = new Map(
    (existing?.allocations ?? []).map((a) => [
      `${a.type}:${a.categoryId ?? a.goalId ?? a.recurringItemId ?? ""}`,
      a,
    ]),
  );

  const accountDrafts: PaydayAccountDraft[] = accounts.map((account) => {
    const snapshot = existingSnapshotByAccount.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      currency: account.currency,
      type: account.type,
      expectedLedgerBalance: account.balance,
      reportedBalance: snapshot ? num(snapshot.reportedBalance) : account.balance,
      incomeEntered: snapshot ? num(snapshot.incomeEntered) : 0,
      incomeNote: snapshot?.incomeNote ?? "",
    };
  });
  const totalIncome = round2(
    accountDrafts.reduce(
      (sum, a) => sum + convert(a.incomeEntered, a.currency, context.displayCurrency, context.rates),
      0,
    ),
  );

  const subscriptions = planSummary.committedItems.filter((i) => i.kind === "SUBSCRIPTION").map(toCommittedDraft);
  const contributions = planSummary.committedItems.filter((i) => i.kind === "CONTRIBUTION").map(toCommittedDraft);
  const subscriptionsTotal = round2(subscriptions.reduce((sum, i) => sum + i.amount, 0));
  const contributionsTotal = round2(contributions.reduce((sum, i) => sum + i.amount, 0));

  const goals: PaydayGoalDraft[] = allGoals
    .filter((g) => g.targetDate && !g.achievedAt && g.perPeriod !== null)
    .map((g) => {
      const existingAlloc = existingAllocationByKey.get(`GOAL:${g.id}`);
      return {
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        recommendedAmount: g.perPeriod as number,
        plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : (g.perPeriod as number),
        targetDate: g.targetDate as Date,
        periodsLeft: g.periodsLeft as number,
      };
    });
  const goalPlanTotal = round2(
    goals.reduce((sum, g) => sum + convert(g.plannedAmount, g.currency, context.displayCurrency, context.rates), 0),
  );

  const essentialSuggestions = await getCategorySuggestions(planRef, essentialCategoryRows, context);
  const essentialCategories: PaydayCategoryDraft[] = essentialCategoryRows.map((category) => {
    const suggestion = essentialSuggestions.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`ESSENTIAL_CATEGORY:${category.id}`);
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: suggestion.amount,
      plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : suggestion.amount,
      basis: suggestion.basis,
    };
  });
  const essentialFixedTotal = round2(essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0));

  const bufferFloor = round2(
    convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, context.displayCurrency, context.rates),
  );
  const suggestedBuffer = defaultProtectedBuffer(totalIncome, settings.bufferPercent, bufferFloor);
  const existingBufferAlloc = existingAllocationByKey.get("BUFFER:");
  const plannedBuffer = existingBufferAlloc ? num(existingBufferAlloc.plannedAmount) : suggestedBuffer;

  const includedCarryover = existing
    ? num(existing.includedCarryover)
    : settings.carryoverIncludedByDefault
      ? carryover.amount
      : 0;

  const flexibleSuggestions = await getCategorySuggestions(planRef, flexibleCategoryRows, context);
  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: plannedBuffer,
  });
  const scaled = scaleFlexibleSuggestions(
    flexibleCategoryRows.map((c) => ({ id: c.id, suggested: flexibleSuggestions.get(c.id)?.amount ?? 0 })),
    available,
  );
  const scaledById = new Map(scaled.map((s) => [s.id, s.scaled]));
  const flexibleCategories: PaydayCategoryDraft[] = flexibleCategoryRows.map((category) => {
    const suggestion = flexibleSuggestions.get(category.id) ?? { amount: 0, basis: "none" as const };
    const existingAlloc = existingAllocationByKey.get(`FLEXIBLE_CATEGORY:${category.id}`);
    const scaledAmount = scaledById.get(category.id) ?? 0;
    return {
      categoryId: category.id,
      name: category.name,
      color: category.color,
      suggestedAmount: scaledAmount,
      plannedAmount: existingAlloc ? num(existingAlloc.plannedAmount) : scaledAmount,
      basis: suggestion.basis,
    };
  });

  return {
    periodRef: planRef,
    periodLabel: plan.longLabel,
    isEditingConfirmed: Boolean(existing),
    checkinId: existing?.id ?? null,
    displayCurrency: context.displayCurrency,
    accounts: accountDrafts,
    subscriptions,
    contributions,
    subscriptionsTotal,
    contributionsTotal,
    goals,
    essentialCategories,
    flexibleCategories,
    suggestedBuffer,
    plannedBuffer,
    bufferFloor,
    availableCarryover: carryover.amount,
    carryoverBasis: carryover.basis,
    includedCarryover,
    daysRemainingInPlanPeriod: daysRemainingInPeriod(context.today, plan),
  };
}
```

Note: `getPeriodSummary`'s `CommittedItem` type isn't currently exported from `src/lib/data/period-summary.ts` (only the interface is declared, not re-exported by name in the existing `export interface CommittedItem` line - check the file: it already reads `export interface CommittedItem {`, so it *is* exported already; the `import { getPeriodSummary, type CommittedItem } from "@/lib/data/period-summary";` line above will resolve correctly with no changes needed to that file).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: clean. This file has no UI and isn't imported anywhere yet, so this step is purely a compile check on the new code itself.

- [ ] **Step 3: Commit**

```bash
git add src/lib/data/payday.ts
git commit -m "feat: add the payday check-in draft loader (accounts, commitments, goals, category suggestions, buffer, carryover)"
```

---

## Task 6: Validation schemas for the confirm payload and planning preferences

**Files:**
- Modify: `src/lib/validation.ts`

**Interfaces:**
- Produces: `paydayConfirmSchema`, `planningPreferencesSchema` — Task 7 and Task 8 import these.

- [ ] **Step 1: Add the two schemas to `src/lib/validation.ts`**

Add right after the existing `export const settingsSchema = ...` block:
```ts
export const paydayConfirmSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  period: z.enum(["A", "B"]),
  accounts: z
    .array(
      z.object({
        accountId: z.string().trim().min(1),
        reportedBalance: z.number(),
        incomeEntered: z.number().min(0),
        incomeNote: z.string().max(200).nullable(),
      }),
    )
    .min(1, "Add at least one active account"),
  goals: z.array(
    z.object({
      goalId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  essentialCategories: z.array(
    z.object({
      categoryId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  flexibleCategories: z.array(
    z.object({
      categoryId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  buffer: z.number().min(0),
  includedCarryover: z.number(),
  acknowledgedDeficit: z.boolean(),
  acknowledgedZeroBuffer: z.boolean(),
});

export const planningPreferencesSchema = z.object({
  bufferPercent: z.coerce.number().int().min(0).max(100),
  bufferFloorAmount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const parsed = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message: "Enter 0 or more" });
        return z.NEVER;
      }
      return Math.round(parsed * 100) / 100;
    }),
  bufferFloorCurrency: currency,
  carryoverIncludedByDefault: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "on" || value === "true"),
});
```

- [ ] **Step 2: Add the one new validation message to the Spanish map**

In the `VALIDATION_MESSAGES_ES` object, add:
```ts
  "Add at least one active account": "Agrega al menos una cuenta activa",
```

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/validation.ts
git commit -m "feat: add validation schemas for the payday confirm payload and planning preferences"
```

---

## Task 7: `confirmPaydayCheckinAction` and `dismissPaydayPromptAction`

**Files:**
- Create: `src/server/actions/payday.ts`

**Interfaces:**
- Consumes: `getAppContext` (`@/lib/data/context`), `getSettings`/`requireAuth` (`@/lib/auth`), `convert`, `num`/`round2`, `defaultProtectedBuffer`/`availableForFlexibleCategories` (Task 2), `getAccountBalances` (Task 3), `getCategorySuggestions`/`getAvailableCarryover` (Task 5), `getPeriodSummary`, `listGoals`, `periodInfo`/`type PeriodRef`, `paydayConfirmSchema` (Task 6), `firstError`, `done`/`fail`/`revalidateApp`/`type ActionState`.
- Produces: `confirmPaydayCheckinAction`, `dismissPaydayPromptAction` — Task 10's wizard `useActionState`s the first; Task 11's dashboard card calls the second directly (same "call a server action from a client handler" pattern as Task 4's row actions).

- [ ] **Step 1: Create `src/server/actions/payday.ts`**

```ts
"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { convert } from "@/lib/currency";
import { num, round2 } from "@/lib/money";
import { getDictionary, isLocale } from "@/lib/i18n";
import { availableForFlexibleCategories, defaultProtectedBuffer } from "@/lib/payday";
import { periodInfo, type PeriodRef } from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { firstError, formObject, paydayConfirmSchema } from "@/lib/validation";

import { getAccountBalances } from "@/lib/data/accounts";
import { getAvailableCarryover, getCategorySuggestions } from "@/lib/data/payday";
import { getAppContext } from "@/lib/data/context";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { listGoals } from "@/lib/data/goals";

import { done, fail, revalidateApp, type ActionState } from "./utils";

/**
 * Confirms one pay period's payday check-in atomically: reconciled income
 * transactions, balance snapshots, the check-in row itself, plan-allocation
 * audit rows, and the essential/flexible category Budget rows. Never creates
 * actual expense transactions or GoalContribution rows - see the financial
 * integrity rules in this plan's Global Constraints. Every "recommended"
 * figure is recomputed here from live data; only the user's edited "planned"
 * values are trusted from the client payload.
 */
export async function confirmPaydayCheckinAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const context = await getAppContext();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).payday;

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail(t.couldNotReadPlan);
  }
  const parsed = paydayConfirmSchema.safeParse(payload);
  if (!parsed.success) return fail(firstError(parsed.error, locale));
  const input = parsed.data;
  const planRef: PeriodRef = { year: input.year, month: input.month, period: input.period };
  const plan = periodInfo(planRef);

  const [liveAccounts, planSummary, allGoals, essentialCategories, flexibleCategories, carryover] =
    await Promise.all([
      getAccountBalances(context, { status: "ACTIVE" }),
      getPeriodSummary(plan, context),
      listGoals(context),
      prisma.category.findMany({
        where: { kind: "EXPENSE", isEssentialFixed: true, isSubscriptionDefault: false, isSavingsDefault: false },
      }),
      prisma.category.findMany({
        where: { kind: "EXPENSE", isEssentialFixed: false, isSubscriptionDefault: false, isSavingsDefault: false },
      }),
      getAvailableCarryover(planRef, context),
    ]);
  const liveAccountById = new Map(liveAccounts.map((a) => [a.id, a]));
  const essentialById = new Map(essentialCategories.map((c) => [c.id, c]));
  const flexibleById = new Map(flexibleCategories.map((c) => [c.id, c]));
  const [essentialSuggestions, flexibleSuggestions] = await Promise.all([
    getCategorySuggestions(planRef, essentialCategories, context),
    getCategorySuggestions(planRef, flexibleCategories, context),
  ]);

  const accountInputs = input.accounts.filter((a) => liveAccountById.has(a.accountId));
  if (accountInputs.length === 0) return fail(t.noActiveAccounts);

  const totalIncome = round2(
    accountInputs.reduce((sum, a) => {
      const account = liveAccountById.get(a.accountId)!;
      return sum + convert(a.incomeEntered, account.currency, context.displayCurrency, context.rates);
    }, 0),
  );

  const subscriptionItems = planSummary.committedItems.filter((i) => i.kind === "SUBSCRIPTION");
  const contributionItems = planSummary.committedItems.filter((i) => i.kind === "CONTRIBUTION");
  const subscriptionsTotal = round2(subscriptionItems.reduce((sum, i) => sum + i.amount, 0));
  const contributionsTotal = round2(contributionItems.reduce((sum, i) => sum + i.amount, 0));

  const goalById = new Map(allGoals.map((g) => [g.id, g]));
  const goalInputs = input.goals.filter((g) => {
    const goal = goalById.get(g.goalId);
    return Boolean(goal && goal.targetDate && !goal.achievedAt);
  });
  const goalPlanTotal = round2(
    goalInputs.reduce((sum, g) => {
      const goal = goalById.get(g.goalId)!;
      return sum + convert(g.plannedAmount, goal.currency, context.displayCurrency, context.rates);
    }, 0),
  );

  const essentialInputs = input.essentialCategories.filter((c) => essentialById.has(c.categoryId));
  const essentialFixedTotal = round2(essentialInputs.reduce((sum, c) => sum + c.plannedAmount, 0));
  const flexibleInputs = input.flexibleCategories.filter((c) => flexibleById.has(c.categoryId));
  const flexibleTotal = round2(flexibleInputs.reduce((sum, c) => sum + c.plannedAmount, 0));

  const bufferFloor = round2(
    convert(num(settings.bufferFloorAmount), settings.bufferFloorCurrency, context.displayCurrency, context.rates),
  );
  const recommendedBuffer = defaultProtectedBuffer(totalIncome, settings.bufferPercent, bufferFloor);

  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover: input.includedCarryover,
    subscriptions: subscriptionsTotal,
    recurringContributions: contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: input.buffer,
  });

  const needsDeficitAck = available < 0 || flexibleTotal > Math.max(0, available);
  if (needsDeficitAck && !input.acknowledgedDeficit) {
    return fail(t.acknowledgeDeficitFirst);
  }
  if (input.buffer <= 0 && !input.acknowledgedZeroBuffer) {
    return fail(t.acknowledgeZeroBufferFirst);
  }

  const checkinDate = context.today;

  await prisma.$transaction(async (tx) => {
    const existingCheckin = await tx.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period },
    });
    const checkin = existingCheckin
      ? await tx.paydayCheckin.update({
          where: { id: existingCheckin.id },
          data: {
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover: input.includedCarryover,
            protectedBuffer: input.buffer,
            status: "CONFIRMED",
          },
        })
      : await tx.paydayCheckin.create({
          data: {
            year: planRef.year,
            month: planRef.month,
            period: planRef.period,
            checkinDate,
            currency: context.displayCurrency,
            totalIncome,
            includedCarryover: input.includedCarryover,
            protectedBuffer: input.buffer,
            status: "CONFIRMED",
          },
        });

    for (const accountInput of accountInputs) {
      const account = liveAccountById.get(accountInput.accountId)!;
      const difference = round2(accountInput.reportedBalance - account.balance);
      const existingSnapshot = await tx.paydayAccountSnapshot.findFirst({
        where: { paydayCheckinId: checkin.id, accountId: account.id },
      });

      let incomeTransactionId = existingSnapshot?.incomeTransactionId ?? null;
      if (accountInput.incomeEntered > 0) {
        if (incomeTransactionId) {
          await tx.transaction.update({
            where: { id: incomeTransactionId },
            data: { date: checkinDate, amount: accountInput.incomeEntered, note: accountInput.incomeNote },
          });
        } else {
          const created = await tx.transaction.create({
            data: {
              date: checkinDate,
              amount: accountInput.incomeEntered,
              currency: account.currency,
              type: "INCOME",
              accountId: account.id,
              note: accountInput.incomeNote,
              source: "PAYDAY_CHECKIN",
            },
          });
          incomeTransactionId = created.id;
        }
      } else if (incomeTransactionId) {
        await tx.transaction.delete({ where: { id: incomeTransactionId } });
        incomeTransactionId = null;
      }

      const snapshotData = {
        expectedLedgerBalance: account.balance,
        reportedBalance: accountInput.reportedBalance,
        difference,
        incomeEntered: accountInput.incomeEntered,
        incomeNote: accountInput.incomeNote,
        incomeTransactionId,
        currency: account.currency,
      };
      if (existingSnapshot) {
        await tx.paydayAccountSnapshot.update({ where: { id: existingSnapshot.id }, data: snapshotData });
      } else {
        await tx.paydayAccountSnapshot.create({
          data: { paydayCheckinId: checkin.id, accountId: account.id, ...snapshotData },
        });
      }
    }

    await tx.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkin.id } });

    const allocationRows = [
      ...subscriptionItems.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "SUBSCRIPTION" as const,
        recurringItemId: item.id,
        recommendedAmount: item.nativeAmount,
        plannedAmount: item.nativeAmount,
        currency: item.currency,
        basis: "recurring_item",
      })),
      ...contributionItems.map((item) => ({
        paydayCheckinId: checkin.id,
        type: "RECURRING_CONTRIBUTION" as const,
        recurringItemId: item.id,
        recommendedAmount: item.nativeAmount,
        plannedAmount: item.nativeAmount,
        currency: item.currency,
        basis: "recurring_item",
      })),
      ...goalInputs.map((g) => {
        const goal = goalById.get(g.goalId)!;
        return {
          paydayCheckinId: checkin.id,
          type: "GOAL" as const,
          goalId: goal.id,
          recommendedAmount: goal.perPeriod ?? 0,
          plannedAmount: g.plannedAmount,
          currency: goal.currency,
          basis: "roadmap",
        };
      }),
      ...essentialInputs.map((c) => ({
        paydayCheckinId: checkin.id,
        type: "ESSENTIAL_CATEGORY" as const,
        categoryId: c.categoryId,
        recommendedAmount: essentialSuggestions.get(c.categoryId)?.amount ?? 0,
        plannedAmount: c.plannedAmount,
        currency: context.displayCurrency,
        basis: essentialSuggestions.get(c.categoryId)?.basis ?? "none",
      })),
      ...flexibleInputs.map((c) => ({
        paydayCheckinId: checkin.id,
        type: "FLEXIBLE_CATEGORY" as const,
        categoryId: c.categoryId,
        recommendedAmount: flexibleSuggestions.get(c.categoryId)?.amount ?? 0,
        plannedAmount: c.plannedAmount,
        currency: context.displayCurrency,
        basis: flexibleSuggestions.get(c.categoryId)?.basis ?? "none",
      })),
      {
        paydayCheckinId: checkin.id,
        type: "BUFFER" as const,
        recommendedAmount: recommendedBuffer,
        plannedAmount: input.buffer,
        currency: context.displayCurrency,
        basis: "buffer_formula",
      },
      {
        paydayCheckinId: checkin.id,
        type: "CARRYOVER" as const,
        recommendedAmount: carryover.amount,
        plannedAmount: input.includedCarryover,
        currency: context.displayCurrency,
        basis: carryover.basis,
      },
    ];
    await tx.paydayPlanAllocation.createMany({ data: allocationRows });

    for (const categoryInput of [...essentialInputs, ...flexibleInputs]) {
      const existingBudget = await tx.budget.findFirst({
        where: {
          year: planRef.year,
          month: planRef.month,
          period: planRef.period,
          categoryId: categoryInput.categoryId,
        },
      });
      if (existingBudget) {
        await tx.budget.update({
          where: { id: existingBudget.id },
          data: { amount: categoryInput.plannedAmount, currency: context.displayCurrency },
        });
      } else {
        await tx.budget.create({
          data: {
            year: planRef.year,
            month: planRef.month,
            period: planRef.period,
            categoryId: categoryInput.categoryId,
            amount: categoryInput.plannedAmount,
            currency: context.displayCurrency,
          },
        });
      }
    }
  });

  revalidateApp();
  return done(t.checkinConfirmed);
}

/** Records that the user dismissed today's auto-opened prompt, so it stays available as a dashboard card without forcing the modal open again the same day. */
export async function dismissPaydayPromptAction(_previous: ActionState): Promise<ActionState> {
  await requireAuth();
  const context = await getAppContext();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { checkinPromptDismissedOn: context.today },
  });
  revalidateApp();
  return done();
}
```

Note: `formObject` is imported but unused in this file - remove that import (this action reads `formData.get("payload")` directly, following the same JSON-payload pattern as `importTransactionsAction` in `src/server/actions/import.ts`, not per-field `formObject`).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: clean (the `payday` dictionary section it references - `t.couldNotReadPlan`, `t.noActiveAccounts`, `t.acknowledgeDeficitFirst`, `t.acknowledgeZeroBufferFirst`, `t.checkinConfirmed` - doesn't exist yet; Task 9 adds it. If typecheck fails only on those missing keys, that's expected at this point in the plan - re-run typecheck after Task 9 instead of treating it as a blocker here.)

- [ ] **Step 3: Commit**

```bash
git add src/server/actions/payday.ts
git commit -m "feat: add confirmPaydayCheckinAction (atomic snapshots, income, allocations, budgets) and dismissPaydayPromptAction"
```

---

## Task 8: Settings — planning preferences and essential-fixed category toggles

**Files:**
- Modify: `src/server/actions/settings.ts`
- Modify: `src/app/(app)/settings/page.tsx`
- Create: `src/components/settings/planning-preferences-form.tsx`
- Create: `src/components/settings/essential-category-toggle.tsx`

**Interfaces:**
- Consumes: `planningPreferencesSchema` (Task 6), `Field`/`SubmitButton`/`CurrencySelect`/`Switch`/`Input` (existing UI), `getDictionary` (Task 9 adds the `settingsPage` keys this references - typecheck this task's new keys together with Task 9, same as Task 7).
- Produces: `savePlanningPreferencesAction`, `toggleEssentialCategoryAction`; `<PlanningPreferencesForm>`, `<EssentialCategoryToggle>`.

- [ ] **Step 1: Add the two actions to `src/server/actions/settings.ts`**

Add these two exports at the end of the file (after `recalculateGoalsAction`), and add `planningPreferencesSchema` to the existing `import { firstError, formObject, settingsSchema } from "@/lib/validation";` line (becomes `import { firstError, formObject, planningPreferencesSchema, settingsSchema } from "@/lib/validation";`):
```ts
export async function savePlanningPreferencesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const parsed = planningPreferencesSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: parsed.data,
    create: { id: SETTINGS_ID, ...parsed.data },
  });
  revalidateApp();
  return done(t.planningPreferencesSaved);
}

export async function toggleEssentialCategoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const isEssentialFixed = formData.get("isEssentialFixed") === "true";
  if (!categoryId) return fail(t.categoryNoLongerExists);

  await prisma.category.update({ where: { id: categoryId }, data: { isEssentialFixed } });
  revalidateApp();
  return done(isEssentialFixed ? t.categoryMarkedEssential : t.categoryUnmarkedEssential);
}
```

- [ ] **Step 2: Create `src/components/settings/planning-preferences-form.tsx`**

```tsx
"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { CurrencySelect } from "@/components/form/selects";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getDictionary, type Locale } from "@/lib/i18n";
import { savePlanningPreferencesAction } from "@/server/actions/settings";

export function PlanningPreferencesForm({
  bufferPercent,
  bufferFloorAmount,
  bufferFloorCurrency,
  carryoverIncludedByDefault,
  locale,
}: {
  bufferPercent: number;
  bufferFloorAmount: number;
  bufferFloorCurrency: string;
  carryoverIncludedByDefault: boolean;
  locale: Locale;
}) {
  const t = getDictionary(locale).settingsPage;
  const common = getDictionary(locale).common;
  const [state, formAction, pending] = useActionState(savePlanningPreferencesAction, null);
  const [carryoverDefault, setCarryoverDefault] = useState(carryoverIncludedByDefault);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) toast.success(state.message ?? t.planningPreferencesSaved);
    else if (state.error) toast.error(state.error);
  }, [state, t.planningPreferencesSaved]);

  return (
    <form action={formAction} className="space-y-4">
      <input
        type="hidden"
        name="carryoverIncludedByDefault"
        value={carryoverDefault ? "true" : "false"}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.bufferPercentLabel} htmlFor="buffer-percent" hint={t.bufferPercentHint}>
          <Input
            id="buffer-percent"
            name="bufferPercent"
            type="number"
            min={0}
            max={100}
            defaultValue={bufferPercent}
          />
        </Field>
        <Field label={t.bufferFloorLabel} htmlFor="buffer-floor">
          <div className="flex gap-2">
            <Input
              id="buffer-floor"
              name="bufferFloorAmount"
              inputMode="decimal"
              className="font-mono"
              defaultValue={bufferFloorAmount}
            />
            <div className="w-24">
              <CurrencySelect name="bufferFloorCurrency" defaultValue={bufferFloorCurrency} />
            </div>
          </div>
        </Field>
      </div>

      <label className="flex items-center gap-2.5 text-sm">
        <Switch checked={carryoverDefault} onCheckedChange={setCarryoverDefault} />
        {t.carryoverDefaultLabel}
      </label>
      <p className="text-xs text-muted-foreground">{t.carryoverDefaultHint}</p>

      {state?.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton pending={pending} size="sm">
        {common.save}
      </SubmitButton>
    </form>
  );
}
```

- [ ] **Step 3: Create `src/components/settings/essential-category-toggle.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { toggleEssentialCategoryAction } from "@/server/actions/settings";

export function EssentialCategoryToggle({
  categoryId,
  initialValue,
  ariaLabel,
  errorMessage,
}: {
  categoryId: string;
  initialValue: boolean;
  ariaLabel: string;
  errorMessage: string;
}) {
  const [checked, setChecked] = useState(initialValue);
  const [pending, startTransition] = useTransition();

  return (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={pending}
      onCheckedChange={(next) => {
        setChecked(next);
        startTransition(async () => {
          const form = new FormData();
          form.set("categoryId", categoryId);
          form.set("isEssentialFixed", next ? "true" : "false");
          const result = await toggleEssentialCategoryAction(null, form);
          if (result?.error) {
            setChecked(!next);
            toast.error(result.error || errorMessage);
          }
        });
      }}
    />
  );
}
```

- [ ] **Step 4: Add the two new cards to `src/app/(app)/settings/page.tsx`**

Change the imports at the top to add:
```ts
import { EssentialCategoryToggle } from "@/components/settings/essential-category-toggle";
import { PlanningPreferencesForm } from "@/components/settings/planning-preferences-form";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
```
(alongside the existing imports; `getSettings` isn't currently imported in this file - `getAppContext` doesn't expose the new buffer/carryover fields, so add `import { getSettings } from "@/lib/auth";` too.)

In the component body, after `const timezone = appTimeZone();` and before the `return`, add:
```ts
  const settings = await getSettings();
  const eligibleCategories = await prisma.category.findMany({
    where: { kind: "EXPENSE", isSubscriptionDefault: false, isSavingsDefault: false },
    orderBy: { name: "asc" },
  });
```

Inside the `<div className="grid gap-5 lg:grid-cols-2">`, right after the `</Card>` that closes the "Exchange rates" card and before the "Goal progress" `<Card>`, insert:
```tsx
        <Card>
          <CardHeader>
            <CardTitle>{t.planningPreferencesTitle}</CardTitle>
            <CardDescription>{t.planningPreferencesDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlanningPreferencesForm
              bufferPercent={settings.bufferPercent}
              bufferFloorAmount={num(settings.bufferFloorAmount)}
              bufferFloorCurrency={settings.bufferFloorCurrency}
              carryoverIncludedByDefault={settings.carryoverIncludedByDefault}
              locale={context.language}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t.essentialCategoriesTitle}</CardTitle>
            <CardDescription>{t.essentialCategoriesDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {eligibleCategories.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noEligibleCategories}</p>
            ) : (
              <ul className="divide-y divide-border/70">
                {eligibleCategories.map((category) => (
                  <li key={category.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      {category.name}
                    </span>
                    <EssentialCategoryToggle
                      categoryId={category.id}
                      initialValue={category.isEssentialFixed}
                      ariaLabel={t.essentialToggleAria(category.name)}
                      errorMessage={t.categoryNoLongerExists}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
```

- [ ] **Step 5: Manual check**

```bash
npm run dev
```
Visit `/settings`: confirm "Planning preferences" saves the buffer percent/floor/currency and the carryover switch, and "Essential fixed categories" toggles persist (reload the page and confirm the switch state survived).

- [ ] **Step 6: Typecheck, lint, and commit**

This task's new dictionary keys (`planningPreferencesTitle`, `planningPreferencesDescription`, `bufferPercentLabel`, `bufferPercentHint`, `bufferFloorLabel`, `carryoverDefaultLabel`, `carryoverDefaultHint`, `planningPreferencesSaved`, `essentialCategoriesTitle`, `essentialCategoriesDescription`, `noEligibleCategories`, `essentialToggleAria`, `categoryNoLongerExists`, `categoryMarkedEssential`, `categoryUnmarkedEssential`) are added to both dictionaries in Task 9 - run `npm run typecheck` after Task 9 completes, not standalone here.
```bash
git add src/server/actions/settings.ts "src/app/(app)/settings/page.tsx" \
  src/components/settings/planning-preferences-form.tsx \
  src/components/settings/essential-category-toggle.tsx
git commit -m "feat: add planning preferences and essential-fixed category settings"
```

---

## Task 9: Localization — the full `payday` dictionary, settings/goals additions, and the new source label

**Files:**
- Modify: `src/lib/i18n/en.ts`
- Modify: `src/lib/i18n/es.ts`
- Modify: `src/lib/labels.ts`
- Modify: `src/components/source-badge.tsx`

**Interfaces:**
- Produces: `Dictionary["payday"]` (all keys Task 7's server action and Task 10's wizard reference by exact name below), the `settingsPage` additions Task 8 references, two new `goals` keys Task 13 references, `common.sourceLabels.PAYDAY_CHECKIN`, and `"PAYDAY_CHECKIN"` added to `TRANSACTION_SOURCES`/`SOURCE_LABELS`/`SOURCE_ICONS`.

- [ ] **Step 1: Add `"PAYDAY_CHECKIN"` to `src/lib/labels.ts`**

Change:
```ts
export const TRANSACTION_SOURCES = [
  "MANUAL",
  "CSV",
  "GMAIL",
  "OUTLOOK",
  "PAYPAL",
] as const;
export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  CSV: "CSV",
  GMAIL: "Gmail",
  OUTLOOK: "Outlook",
  PAYPAL: "PayPal",
};
```
to:
```ts
export const TRANSACTION_SOURCES = [
  "MANUAL",
  "CSV",
  "GMAIL",
  "OUTLOOK",
  "PAYPAL",
  "PAYDAY_CHECKIN",
] as const;
export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  CSV: "CSV",
  GMAIL: "Gmail",
  OUTLOOK: "Outlook",
  PAYPAL: "PayPal",
  PAYDAY_CHECKIN: "Payday check-in",
};
```

- [ ] **Step 2: Add an icon for the new source in `src/components/source-badge.tsx`**

Change the top import and `SOURCE_ICONS` map:
```ts
import {
  CreditCard,
  FileSpreadsheet,
  Mail,
  PenLine,
  ArrowRightLeft,
  CircleSmall,
  Wallet,
} from "lucide-react";
```
```ts
const SOURCE_ICONS: Record<string, LucideIcon> = {
  MANUAL: PenLine,
  CSV: FileSpreadsheet,
  GMAIL: Mail,
  OUTLOOK: Mail,
  PAYPAL: CreditCard,
  PAYDAY_CHECKIN: Wallet,
};
```

- [ ] **Step 3: Add `PAYDAY_CHECKIN` to `common.sourceLabels` in both dictionaries**

In `src/lib/i18n/en.ts`, inside `common.sourceLabels`, add `PAYDAY_CHECKIN: "Payday check-in",`.
In `src/lib/i18n/es.ts`, inside `common.sourceLabels`, add `PAYDAY_CHECKIN: "Chequeo de pago",`.

- [ ] **Step 4: Add the two new `goals` keys to both dictionaries**

In `src/lib/i18n/en.ts`, inside the `goals` section, right after `contributionLogged: "Contribution logged",` add:
```ts
    plannedThisPeriod: (amount: string) => `${amount} planned this period`,
    plannedBehindRoadmap: (amount: string) => `${amount} behind the roadmap`,
```
In `src/lib/i18n/es.ts`, at the matching spot in the `goals` section, add:
```ts
    plannedThisPeriod: (amount: string) => `${amount} planificado este periodo`,
    plannedBehindRoadmap: (amount: string) => `${amount} por detrás de la hoja de ruta`,
```

- [ ] **Step 5: Add the 15 `settingsPage` keys Task 8 uses to both dictionaries**

In `src/lib/i18n/en.ts`, inside `settingsPage`, right after `syncedResult: (...) => ...,` add:
```ts
    planningPreferencesTitle: "Planning preferences",
    planningPreferencesDescription:
      "How the payday planner sizes your protected buffer and carries money forward.",
    bufferPercentLabel: "Buffer percentage",
    bufferPercentHint: "Percent of each check-in's income reserved as a buffer by default.",
    bufferFloorLabel: "Fixed minimum buffer",
    carryoverDefaultLabel: "Include carryover by default",
    carryoverDefaultHint:
      "When on, unspent money from the previous period's budget pre-fills as included carryover in each new check-in.",
    planningPreferencesSaved: "Planning preferences saved",
    essentialCategoriesTitle: "Essential fixed categories",
    essentialCategoriesDescription:
      "Categories marked essential fixed are reserved in the payday plan before flexible category suggestions.",
    noEligibleCategories: "No expense categories available to configure.",
    essentialToggleAria: (name: string) => `Mark ${name} as essential fixed`,
    categoryNoLongerExists: "That category no longer exists",
    categoryMarkedEssential: "Marked as essential fixed",
    categoryUnmarkedEssential: "No longer essential fixed",
```
In `src/lib/i18n/es.ts`, at the matching spot in `settingsPage`, add:
```ts
    planningPreferencesTitle: "Preferencias de planificación",
    planningPreferencesDescription:
      "Cómo el planificador de pago calcula tu colchón protegido y traslada dinero de un periodo a otro.",
    bufferPercentLabel: "Porcentaje de colchón",
    bufferPercentHint: "Porcentaje del ingreso de cada chequeo reservado como colchón por defecto.",
    bufferFloorLabel: "Colchón mínimo fijo",
    carryoverDefaultLabel: "Incluir remanente por defecto",
    carryoverDefaultHint:
      "Si está activo, el dinero sin gastar del presupuesto del periodo anterior se precarga como remanente incluido en cada chequeo nuevo.",
    planningPreferencesSaved: "Preferencias de planificación guardadas",
    essentialCategoriesTitle: "Categorías fijas esenciales",
    essentialCategoriesDescription:
      "Las categorías marcadas como fijas esenciales se reservan en el plan de pago antes de las sugerencias de categorías flexibles.",
    noEligibleCategories: "No hay categorías de gasto disponibles para configurar.",
    essentialToggleAria: (name: string) => `Marcar ${name} como fija esencial`,
    categoryNoLongerExists: "Esa categoría ya no existe",
    categoryMarkedEssential: "Marcada como fija esencial",
    categoryUnmarkedEssential: "Ya no es fija esencial",
```

- [ ] **Step 6: Add the full `payday` section to `src/lib/i18n/en.ts`**

Add this as a new top-level key in the `en` object, right after the `review: { ... }` section's closing `},` and before the object's final `};`:
```ts
  payday: {
    bannerTitle: "Payday check-in ready",
    bannerDescription:
      "Confirm balances, record this period's income, and plan until your next payday.",
    startCheckin: "Start payday check-in",
    planThisPeriod: "Plan this period",
    dismissForToday: "Not now",
    reviewConfirmedPlan: "Review this period's plan",
    wizardTitle: (periodLabel: string) => `Payday check-in - ${periodLabel}`,
    stepOf: (step: number, total: number) => `Step ${step} of ${total}`,
    back: "Back",
    next: "Next",
    cancel: "Cancel",

    step1Title: "Confirm account balances",
    step1Description:
      "This is a reconciliation check only - it never creates income or expenses.",
    ledgerBalance: "Ledger balance",
    reportedBalance: "Reported balance",
    matchesLedger: "Matches ledger",
    aboveLedger: (amount: string) => `${amount} above ledger`,
    belowLedger: (amount: string) => `${amount} below ledger`,
    manageAccountsLink: "Manage accounts",
    noActiveAccountsTitle: "No active accounts",
    noActiveAccountsDescription: "Add or restore an account before starting a check-in.",

    step2Title: "Record income received",
    step2Description: "Optional per account - leave any account at zero if nothing came in.",
    incomeAmount: "Income received",
    incomeNotePlaceholder: "Salary, freelance payment, bonus...",
    totalIncome: "Total income",

    step3Title: "Review commitments and goals",
    subscriptionsDue: "Subscriptions due before next payday",
    contributionsDue: "Recurring contributions due before next payday",
    noSubscriptionsDue: "No subscriptions due before next payday.",
    noContributionsDue: "No recurring contributions due before next payday.",
    goalsHeading: "Goal roadmap",
    noGoalsWithTarget: "No dated goals to reserve for this period.",
    roadmapAmount: "Roadmap amount",
    plannedAmount: "Planned amount",
    goalOnTrack: "On track with the roadmap",
    goalBehind: (amount: string) => `${amount} behind the target roadmap`,
    goalAhead: (amount: string) => `${amount} ahead of the target roadmap`,
    protectedBufferHeading: "Protected buffer",
    bufferSuggested: (amount: string) => `Suggested ${amount}`,
    bufferZeroWarning: "This plan leaves no protected buffer for unexpected spending.",
    bufferBelowFloorWarning: (floor: string) => `This is below your configured floor of ${floor}.`,
    essentialCategoriesHeading: "Essential fixed spending",
    noEssentialCategoriesConfigured:
      "No categories are marked essential fixed yet - configure them in Settings.",
    carryoverHeading: "Carryover from last period",
    carryoverAvailable: (amount: string) => `${amount} unspent from last period's budget`,
    carryoverUnavailable:
      "No prior period budget to measure carryover against - this plan is funded by income only.",
    carryoverIncluded: "Include in this plan",
    summaryIncome: "Income",
    summaryCarryover: "Included carryover",
    summarySubscriptions: "Subscriptions",
    summaryContributions: "Recurring contributions",
    summaryGoals: "Goal plan",
    summaryEssential: "Essential fixed",
    summaryBuffer: "Protected buffer",
    summaryAvailable: "Available for flexible categories",
    deficitWarning: (amount: string) =>
      `This plan is ${amount} short - something above has to give before you can allocate flexible categories.`,

    step4Title: "Plan flexible categories",
    suggested: "Suggested",
    basisLastBudget: "last budget",
    basisAverage: "average",
    basisNone: "not enough history",
    flexibleAllocated: "Allocated",
    flexibleUnallocated: "Unallocated",
    flexibleOverallocated: (amount: string) => `${amount} overallocated`,
    safeToSpendPerDayEstimate: "Estimated safe to spend per day",
    noFlexibleCategoriesConfigured:
      "No flexible categories available - every expense category is either essential fixed or excluded.",
    acknowledgeDeficitLabel:
      "I understand this plan is short and choices above need to change or spending will be tighter than planned.",

    step5Title: "Confirm your plan",
    confirmSnapshotsNote:
      "Balance snapshots are recorded for audit only - they never change account balances.",
    confirmIncomeNote: (count: number, amount: string) =>
      `${count} income transaction${count === 1 ? "" : "s"} totalling ${amount} will be created.`,
    confirmBudgetsNote: (count: number) =>
      `${count} category budget${count === 1 ? "" : "s"} will be created or updated for this period.`,
    confirmReservedNote:
      "Subscriptions, recurring contributions, and goal amounts are reserved in the plan but not logged as actual transactions or contributions.",
    acknowledgeZeroBufferLabel: "I understand this plan leaves no protected buffer.",
    confirmPlan: "Confirm plan",
    checkinConfirmed: "Payday check-in confirmed",
    editConfirmedPlanNote:
      "You already confirmed this period's check-in - saving again updates it in place.",

    couldNotReadPlan: "Could not read the plan - try again",
    noActiveAccounts: "Add at least one active account before checking in",
    acknowledgeDeficitFirst: "Acknowledge the deficit/overallocation warning before confirming",
    acknowledgeZeroBufferFirst: "Acknowledge the zero-buffer warning before confirming",
  },
```

- [ ] **Step 7: Add the matching `payday` section to `src/lib/i18n/es.ts`**

Add this as the matching top-level key in the `es` object, in the same position (right after `review: { ... }`):
```ts
  payday: {
    bannerTitle: "Chequeo de pago listo",
    bannerDescription:
      "Confirma saldos, registra el ingreso de este periodo y planifica hasta tu próximo pago.",
    startCheckin: "Iniciar chequeo de pago",
    planThisPeriod: "Planificar este periodo",
    dismissForToday: "Ahora no",
    reviewConfirmedPlan: "Revisar el plan de este periodo",
    wizardTitle: (periodLabel: string) => `Chequeo de pago - ${periodLabel}`,
    stepOf: (step: number, total: number) => `Paso ${step} de ${total}`,
    back: "Atrás",
    next: "Siguiente",
    cancel: "Cancelar",

    step1Title: "Confirma los saldos de las cuentas",
    step1Description:
      "Esto es solo una verificación de conciliación - nunca crea ingresos ni gastos.",
    ledgerBalance: "Saldo según el libro",
    reportedBalance: "Saldo reportado",
    matchesLedger: "Coincide con el libro",
    aboveLedger: (amount: string) => `${amount} por encima del libro`,
    belowLedger: (amount: string) => `${amount} por debajo del libro`,
    manageAccountsLink: "Administrar cuentas",
    noActiveAccountsTitle: "No hay cuentas activas",
    noActiveAccountsDescription: "Agrega o restaura una cuenta antes de iniciar un chequeo.",

    step2Title: "Registra el ingreso recibido",
    step2Description: "Opcional por cuenta - deja una cuenta en cero si no entró nada.",
    incomeAmount: "Ingreso recibido",
    incomeNotePlaceholder: "Salario, pago freelance, bono...",
    totalIncome: "Ingreso total",

    step3Title: "Revisa compromisos y metas",
    subscriptionsDue: "Suscripciones antes del próximo pago",
    contributionsDue: "Aportes recurrentes antes del próximo pago",
    noSubscriptionsDue: "No hay suscripciones antes del próximo pago.",
    noContributionsDue: "No hay aportes recurrentes antes del próximo pago.",
    goalsHeading: "Hoja de ruta de metas",
    noGoalsWithTarget: "No hay metas con fecha para reservar en este periodo.",
    roadmapAmount: "Monto de la hoja de ruta",
    plannedAmount: "Monto planificado",
    goalOnTrack: "Al día con la hoja de ruta",
    goalBehind: (amount: string) => `${amount} por detrás de la meta trazada`,
    goalAhead: (amount: string) => `${amount} por delante de la meta trazada`,
    protectedBufferHeading: "Colchón protegido",
    bufferSuggested: (amount: string) => `Sugerido ${amount}`,
    bufferZeroWarning: "Este plan no deja colchón protegido para gastos imprevistos.",
    bufferBelowFloorWarning: (floor: string) =>
      `Esto está por debajo de tu mínimo configurado de ${floor}.`,
    essentialCategoriesHeading: "Gastos fijos esenciales",
    noEssentialCategoriesConfigured:
      "Aún no hay categorías marcadas como fijas esenciales - configúralas en Ajustes.",
    carryoverHeading: "Remanente del periodo anterior",
    carryoverAvailable: (amount: string) => `${amount} sin gastar del presupuesto anterior`,
    carryoverUnavailable:
      "No hay presupuesto del periodo anterior para medir el remanente - este plan se financia solo con el ingreso.",
    carryoverIncluded: "Incluir en este plan",
    summaryIncome: "Ingreso",
    summaryCarryover: "Remanente incluido",
    summarySubscriptions: "Suscripciones",
    summaryContributions: "Aportes recurrentes",
    summaryGoals: "Plan de metas",
    summaryEssential: "Fijos esenciales",
    summaryBuffer: "Colchón protegido",
    summaryAvailable: "Disponible para categorías flexibles",
    deficitWarning: (amount: string) =>
      `Este plan queda corto por ${amount} - algo de lo anterior tiene que ceder antes de poder asignar categorías flexibles.`,

    step4Title: "Planifica las categorías flexibles",
    suggested: "Sugerido",
    basisLastBudget: "último presupuesto",
    basisAverage: "promedio",
    basisNone: "sin historial suficiente",
    flexibleAllocated: "Asignado",
    flexibleUnallocated: "Sin asignar",
    flexibleOverallocated: (amount: string) => `${amount} sobreasignado`,
    safeToSpendPerDayEstimate: "Estimado seguro para gastar por día",
    noFlexibleCategoriesConfigured:
      "No hay categorías flexibles disponibles - cada categoría de gasto es fija esencial o está excluida.",
    acknowledgeDeficitLabel:
      "Entiendo que este plan queda corto y algo de lo anterior debe cambiar, o el gasto será más ajustado de lo planeado.",

    step5Title: "Confirma tu plan",
    confirmSnapshotsNote:
      "Los saldos reportados se registran solo para auditoría - nunca cambian el saldo de la cuenta.",
    confirmIncomeNote: (count: number, amount: string) =>
      `Se crearán ${count} transacción${count === 1 ? "" : "es"} de ingreso por un total de ${amount}.`,
    confirmBudgetsNote: (count: number) =>
      `Se crearán o actualizarán ${count} presupuesto${count === 1 ? "" : "s"} de categoría para este periodo.`,
    confirmReservedNote:
      "Las suscripciones, los aportes recurrentes y los montos de metas quedan reservados en el plan, pero no se registran como transacciones o aportes reales.",
    acknowledgeZeroBufferLabel: "Entiendo que este plan no deja colchón protegido.",
    confirmPlan: "Confirmar plan",
    checkinConfirmed: "Chequeo de pago confirmado",
    editConfirmedPlanNote:
      "Ya confirmaste el chequeo de este periodo - guardar de nuevo lo actualiza en su lugar.",

    couldNotReadPlan: "No se pudo leer el plan - intenta de nuevo",
    noActiveAccounts: "Agrega al menos una cuenta activa antes de hacer el chequeo",
    acknowledgeDeficitFirst: "Reconoce la advertencia de déficit o sobreasignación antes de confirmar",
    acknowledgeZeroBufferFirst: "Reconoce la advertencia de colchón en cero antes de confirmar",
  },
```

- [ ] **Step 8: Typecheck**

```bash
npm run typecheck
```
Expected: clean - `es.ts`'s `as const satisfies Dictionary` check now passes for every key added in Tasks 6-9, and Task 7/8's references to `t.<key>` all resolve. This is the first point in the plan where the whole `payday` server action + settings action compile cleanly end to end.

- [ ] **Step 9: Commit**

```bash
git add src/lib/i18n/en.ts src/lib/i18n/es.ts src/lib/labels.ts src/components/source-badge.tsx
git commit -m "feat: add full English/Spanish localization for the payday check-in and planning preferences"
```

---

## Task 10: The payday check-in wizard UI

**Files:**
- Create: `src/components/payday/step-balances.tsx`
- Create: `src/components/payday/step-income.tsx`
- Create: `src/components/payday/step-commitments.tsx`
- Create: `src/components/payday/step-flexible.tsx`
- Create: `src/components/payday/step-confirm.tsx`
- Create: `src/components/payday/payday-checkin-dialog.tsx`

**Interfaces:**
- Consumes: `PaydayCheckinDraft` and its nested types (Task 5), `confirmPaydayCheckinAction` (Task 7), `availableForFlexibleCategories` (Task 2), `Dictionary["payday"]` (Task 9), `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Alert`/`AlertDescription`, `Input`, `Switch`, `Field`, `SubmitButton`, `formatMoney`, `formatDayMonth`, `round2`.
- Produces: `<PaydayCheckinDialog draft plan={...} locale open onOpenChange />` (the only export Tasks 11/12 use - the five `Step*` components are internal to this task, imported only by the dialog).

- [ ] **Step 1: Create `src/components/payday/step-balances.tsx`**

```tsx
"use client";

import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayAccountDraft } from "@/lib/data/payday";

export function StepBalances({
  accounts,
  onChange,
  t,
}: {
  accounts: PaydayAccountDraft[];
  onChange: (accountId: string, reportedBalance: number) => void;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t.step1Description}</p>
        <Link href="/accounts" className="shrink-0 text-xs text-muted-foreground underline">
          {t.manageAccountsLink}
        </Link>
      </div>
      {accounts.map((account) => {
        const difference = round2(account.reportedBalance - account.expectedLedgerBalance);
        return (
          <Card key={account.accountId} size="sm">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{account.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.ledgerBalance}: {formatMoney(account.expectedLedgerBalance, account.currency)}
                </p>
              </div>
              <div className="w-40">
                <Field label={t.reportedBalance} htmlFor={`balance-${account.accountId}`}>
                  <Input
                    id={`balance-${account.accountId}`}
                    inputMode="decimal"
                    className="font-mono text-right"
                    value={account.reportedBalance}
                    onChange={(event) => {
                      const parsed = Number(event.target.value.replace(/,/g, ""));
                      onChange(account.accountId, Number.isFinite(parsed) ? parsed : 0);
                    }}
                  />
                </Field>
              </div>
              <p
                className={
                  difference === 0
                    ? "text-xs text-muted-foreground"
                    : difference > 0
                      ? "text-xs text-[var(--good)]"
                      : "text-xs text-[var(--critical)]"
                }
              >
                {difference === 0
                  ? t.matchesLedger
                  : difference > 0
                    ? t.aboveLedger(formatMoney(difference, account.currency))
                    : t.belowLedger(formatMoney(Math.abs(difference), account.currency))}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/payday/step-income.tsx`**

```tsx
"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayAccountDraft } from "@/lib/data/payday";

export function StepIncome({
  accounts,
  totalIncome,
  displayCurrency,
  onChange,
  t,
}: {
  accounts: PaydayAccountDraft[];
  totalIncome: number;
  displayCurrency: string;
  onChange: (accountId: string, patch: { incomeEntered?: number; incomeNote?: string }) => void;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.step2Description}</p>
      {accounts.map((account) => (
        <Card key={account.accountId} size="sm">
          <CardContent className="grid grid-cols-[1fr_140px_1fr] items-end gap-3">
            <p className="text-sm font-medium">{account.name}</p>
            <Field label={`${t.incomeAmount} (${account.currency})`} htmlFor={`income-${account.accountId}`}>
              <Input
                id={`income-${account.accountId}`}
                inputMode="decimal"
                className="font-mono text-right"
                value={account.incomeEntered}
                onChange={(event) => {
                  const parsed = Number(event.target.value.replace(/,/g, ""));
                  onChange(account.accountId, {
                    incomeEntered: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
                  });
                }}
              />
            </Field>
            <Input
              placeholder={t.incomeNotePlaceholder}
              value={account.incomeNote}
              onChange={(event) => onChange(account.accountId, { incomeNote: event.target.value })}
            />
          </CardContent>
        </Card>
      ))}
      <p className="text-sm">
        {t.totalIncome}:{" "}
        <span className="figure font-medium">{formatMoney(totalIncome, displayCurrency)}</span>
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/payday/step-commitments.tsx`**

```tsx
"use client";

import { Field } from "@/components/form/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMoney } from "@/lib/currency";
import { formatDayMonth } from "@/lib/date";
import { round2 } from "@/lib/money";
import type { Dictionary } from "@/lib/i18n";
import type {
  CarryoverBasis,
  PaydayCategoryDraft,
  PaydayCommittedDraft,
  PaydayGoalDraft,
} from "@/lib/data/payday";

function AmountInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  return (
    <Input
      aria-label={ariaLabel}
      inputMode="decimal"
      className="w-32 font-mono text-right"
      value={value}
      onChange={(event) => {
        const parsed = Number(event.target.value.replace(/,/g, ""));
        onChange(Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
      }}
    />
  );
}

export function StepCommitments({
  subscriptions,
  contributions,
  goals,
  essentialCategories,
  displayCurrency,
  bufferFloor,
  plannedBuffer,
  availableCarryover,
  carryoverBasis,
  includedCarryover,
  totalIncome,
  subscriptionsTotal,
  contributionsTotal,
  goalPlanTotal,
  essentialFixedTotal,
  available,
  onGoalChange,
  onEssentialChange,
  onBufferChange,
  onCarryoverChange,
  t,
}: {
  subscriptions: PaydayCommittedDraft[];
  contributions: PaydayCommittedDraft[];
  goals: PaydayGoalDraft[];
  essentialCategories: PaydayCategoryDraft[];
  displayCurrency: string;
  bufferFloor: number;
  plannedBuffer: number;
  availableCarryover: number;
  carryoverBasis: CarryoverBasis;
  includedCarryover: number;
  totalIncome: number;
  subscriptionsTotal: number;
  contributionsTotal: number;
  goalPlanTotal: number;
  essentialFixedTotal: number;
  available: number;
  onGoalChange: (goalId: string, plannedAmount: number) => void;
  onEssentialChange: (categoryId: string, plannedAmount: number) => void;
  onBufferChange: (value: number) => void;
  onCarryoverChange: (value: number) => void;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.subscriptionsDue}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noSubscriptionsDue}</p>
          ) : (
            subscriptions.map((item) => (
              <div key={item.recurringItemId} className="flex items-center justify-between text-sm">
                <span>
                  {item.name}{" "}
                  <span className="text-xs text-muted-foreground">{formatDayMonth(item.nextDate)}</span>
                </span>
                <span className="figure">{formatMoney(item.amount, displayCurrency)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.contributionsDue}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {contributions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noContributionsDue}</p>
          ) : (
            contributions.map((item) => (
              <div key={item.recurringItemId} className="flex items-center justify-between text-sm">
                <span>
                  {item.name}{" "}
                  <span className="text-xs text-muted-foreground">{formatDayMonth(item.nextDate)}</span>
                </span>
                <span className="figure">{formatMoney(item.amount, displayCurrency)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.goalsHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {goals.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noGoalsWithTarget}</p>
          ) : (
            goals.map((goal) => {
              const variance = round2(goal.plannedAmount - goal.recommendedAmount);
              return (
                <div key={goal.goalId} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{goal.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.roadmapAmount}: {formatMoney(goal.recommendedAmount, goal.currency)}
                      </p>
                    </div>
                    <Field label={t.plannedAmount}>
                      <AmountInput
                        value={goal.plannedAmount}
                        onChange={(value) => onGoalChange(goal.goalId, value)}
                        ariaLabel={`${t.plannedAmount} - ${goal.name}`}
                      />
                    </Field>
                  </div>
                  <p className={variance >= 0 ? "text-xs text-[var(--good)]" : "text-xs text-[var(--critical)]"}>
                    {variance === 0
                      ? t.goalOnTrack
                      : variance > 0
                        ? t.goalAhead(formatMoney(variance, goal.currency))
                        : t.goalBehind(formatMoney(Math.abs(variance), goal.currency))}
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.protectedBufferHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t.bufferSuggested(formatMoney(bufferFloor, displayCurrency))}
            </p>
            <AmountInput value={plannedBuffer} onChange={onBufferChange} ariaLabel={t.protectedBufferHeading} />
          </div>
          {plannedBuffer <= 0 ? (
            <Alert variant="destructive">
              <AlertDescription>{t.bufferZeroWarning}</AlertDescription>
            </Alert>
          ) : plannedBuffer < bufferFloor ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t.bufferBelowFloorWarning(formatMoney(bufferFloor, displayCurrency))}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.essentialCategoriesHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {essentialCategories.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noEssentialCategoriesConfigured}</p>
          ) : (
            essentialCategories.map((category) => (
              <div key={category.categoryId} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm">
                  <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />
                  {category.name}
                </span>
                <AmountInput
                  value={category.plannedAmount}
                  onChange={(value) => onEssentialChange(category.categoryId, value)}
                  ariaLabel={category.name}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.carryoverHeading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {carryoverBasis === "prior_period_budget"
              ? t.carryoverAvailable(formatMoney(availableCarryover, displayCurrency))
              : t.carryoverUnavailable}
          </p>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch
              checked={includedCarryover > 0}
              onCheckedChange={(checked) => onCarryoverChange(checked ? availableCarryover : 0)}
            />
            {t.carryoverIncluded}
          </label>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span>{t.summaryIncome}</span>
            <span className="figure">{formatMoney(totalIncome, displayCurrency)}</span>
          </div>
          <div className="flex justify-between">
            <span>{t.summaryCarryover}</span>
            <span className="figure">{formatMoney(includedCarryover, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summarySubscriptions}</span>
            <span className="figure">-{formatMoney(subscriptionsTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryContributions}</span>
            <span className="figure">-{formatMoney(contributionsTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryGoals}</span>
            <span className="figure">-{formatMoney(goalPlanTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryEssential}</span>
            <span className="figure">-{formatMoney(essentialFixedTotal, displayCurrency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{t.summaryBuffer}</span>
            <span className="figure">-{formatMoney(plannedBuffer, displayCurrency)}</span>
          </div>
          <div className="flex justify-between border-t border-border/70 pt-1.5 font-medium">
            <span>{t.summaryAvailable}</span>
            <span className={available < 0 ? "figure text-[var(--critical)]" : "figure"}>
              {formatMoney(available, displayCurrency)}
            </span>
          </div>
          {available < 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t.deficitWarning(formatMoney(Math.abs(available), displayCurrency))}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/payday/step-flexible.tsx`**

```tsx
"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { round2 } from "@/lib/money";
import type { Dictionary } from "@/lib/i18n";
import type { PaydayCategoryDraft, SuggestionBasis } from "@/lib/data/payday";

function basisLabel(basis: SuggestionBasis, t: Dictionary["payday"]) {
  if (basis === "last_budget") return t.basisLastBudget;
  if (basis === "average") return t.basisAverage;
  return t.basisNone;
}

export function StepFlexible({
  categories,
  displayCurrency,
  available,
  daysRemaining,
  onChange,
  t,
}: {
  categories: PaydayCategoryDraft[];
  displayCurrency: string;
  available: number;
  daysRemaining: number;
  onChange: (categoryId: string, plannedAmount: number) => void;
  t: Dictionary["payday"];
}) {
  const allocated = round2(categories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const remaining = round2(available - allocated);
  const perDay = round2(Math.max(0, remaining) / Math.max(1, daysRemaining));

  return (
    <div className="space-y-3">
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noFlexibleCategoriesConfigured}</p>
      ) : (
        categories.map((category) => (
          <Card key={category.categoryId} size="sm">
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />
                  {category.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.suggested}: {formatMoney(category.suggestedAmount, displayCurrency)} (
                  {basisLabel(category.basis, t)})
                </p>
              </div>
              <Input
                aria-label={category.name}
                inputMode="decimal"
                className="w-32 font-mono text-right"
                value={category.plannedAmount}
                onChange={(event) => {
                  const parsed = Number(event.target.value.replace(/,/g, ""));
                  onChange(category.categoryId, Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
                }}
              />
            </CardContent>
          </Card>
        ))
      )}

      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span>{t.flexibleAllocated}</span>
            <span className="figure">{formatMoney(allocated, displayCurrency)}</span>
          </div>
          <div className="flex justify-between">
            <span>{t.flexibleUnallocated}</span>
            <span className="figure">{formatMoney(Math.max(0, remaining), displayCurrency)}</span>
          </div>
          <div className="flex justify-between border-t border-border/70 pt-1.5 font-medium">
            <span>{t.safeToSpendPerDayEstimate}</span>
            <span className="figure">{formatMoney(perDay, displayCurrency)}</span>
          </div>
          {remaining < 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t.flexibleOverallocated(formatMoney(Math.abs(remaining), displayCurrency))}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/payday/step-confirm.tsx`**

```tsx
"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

export function StepConfirm({
  incomeTransactionCount,
  totalIncome,
  budgetCount,
  displayCurrency,
  needsDeficitAck,
  acknowledgedDeficit,
  onAcknowledgeDeficitChange,
  needsZeroBufferAck,
  acknowledgedZeroBuffer,
  onAcknowledgeZeroBufferChange,
  isEditingConfirmed,
  formError,
  t,
}: {
  incomeTransactionCount: number;
  totalIncome: number;
  budgetCount: number;
  displayCurrency: string;
  needsDeficitAck: boolean;
  acknowledgedDeficit: boolean;
  onAcknowledgeDeficitChange: (value: boolean) => void;
  needsZeroBufferAck: boolean;
  acknowledgedZeroBuffer: boolean;
  onAcknowledgeZeroBufferChange: (value: boolean) => void;
  isEditingConfirmed: boolean;
  formError: string | null;
  t: Dictionary["payday"];
}) {
  return (
    <div className="space-y-3">
      {isEditingConfirmed ? (
        <Alert>
          <AlertDescription>{t.editConfirmedPlanNote}</AlertDescription>
        </Alert>
      ) : null}
      <Card size="sm">
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>{t.confirmSnapshotsNote}</p>
          <p>{t.confirmIncomeNote(incomeTransactionCount, formatMoney(totalIncome, displayCurrency))}</p>
          <p>{t.confirmBudgetsNote(budgetCount)}</p>
          <p>{t.confirmReservedNote}</p>
        </CardContent>
      </Card>

      {needsDeficitAck ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledgedDeficit}
            onChange={(event) => onAcknowledgeDeficitChange(event.target.checked)}
          />
          {t.acknowledgeDeficitLabel}
        </label>
      ) : null}
      {needsZeroBufferAck ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledgedZeroBuffer}
            onChange={(event) => onAcknowledgeZeroBufferChange(event.target.checked)}
          />
          {t.acknowledgeZeroBufferLabel}
        </label>
      ) : null}

      {formError ? (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Create the shell, `src/components/payday/payday-checkin-dialog.tsx`**

```tsx
"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { StepBalances } from "@/components/payday/step-balances";
import { StepCommitments } from "@/components/payday/step-commitments";
import { StepConfirm } from "@/components/payday/step-confirm";
import { StepFlexible } from "@/components/payday/step-flexible";
import { StepIncome } from "@/components/payday/step-income";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { convert, type RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";
import { round2 } from "@/lib/money";
import { availableForFlexibleCategories } from "@/lib/payday";
import { confirmPaydayCheckinAction } from "@/server/actions/payday";

const STEP_COUNT = 5;

export function PaydayCheckinDialog({
  draft,
  rates,
  locale,
  open,
  onOpenChange,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getDictionary(locale).payday;
  const common = getDictionary(locale).common;
  const [step, setStep] = useState(1);
  const [plan, setPlan] = useState<PaydayCheckinDraft>(draft);
  const [acknowledgedDeficit, setAcknowledgedDeficit] = useState(false);
  const [acknowledgedZeroBuffer, setAcknowledgedZeroBuffer] = useState(false);
  const [state, formAction, pending] = useActionState(confirmPaydayCheckinAction, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setPlan(draft);
    setStep(1);
    setAcknowledgedDeficit(false);
    setAcknowledgedZeroBuffer(false);
    // Re-seed from the freshest server-loaded draft every time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? t.checkinConfirmed);
      onOpenChange(false);
    }
  }, [state, onOpenChange, t.checkinConfirmed]);

  const totalIncome = round2(
    plan.accounts.reduce(
      (sum, a) => sum + convert(a.incomeEntered, a.currency, plan.displayCurrency, rates),
      0,
    ),
  );
  const goalPlanTotal = round2(
    plan.goals.reduce(
      (sum, g) => sum + convert(g.plannedAmount, g.currency, plan.displayCurrency, rates),
      0,
    ),
  );
  const essentialFixedTotal = round2(plan.essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const flexibleTotal = round2(plan.flexibleCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover: plan.includedCarryover,
    subscriptions: plan.subscriptionsTotal,
    recurringContributions: plan.contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: plan.plannedBuffer,
  });
  const needsDeficitAck = available < 0 || flexibleTotal > Math.max(0, available);
  const needsZeroBufferAck = plan.plannedBuffer <= 0;
  const incomeTransactionCount = plan.accounts.filter((a) => a.incomeEntered > 0).length;
  const budgetCount = plan.essentialCategories.length + plan.flexibleCategories.length;

  function updateAccount(accountId: string, patch: Partial<PaydayCheckinDraft["accounts"][number]>) {
    setPlan((prev) => ({
      ...prev,
      accounts: prev.accounts.map((a) => (a.accountId === accountId ? { ...a, ...patch } : a)),
    }));
  }
  function updateGoal(goalId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      goals: prev.goals.map((g) => (g.goalId === goalId ? { ...g, plannedAmount } : g)),
    }));
  }
  function updateEssential(categoryId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      essentialCategories: prev.essentialCategories.map((c) =>
        c.categoryId === categoryId ? { ...c, plannedAmount } : c,
      ),
    }));
  }
  function updateFlexible(categoryId: string, plannedAmount: number) {
    setPlan((prev) => ({
      ...prev,
      flexibleCategories: prev.flexibleCategories.map((c) =>
        c.categoryId === categoryId ? { ...c, plannedAmount } : c,
      ),
    }));
  }

  const canConfirm =
    (!needsDeficitAck || acknowledgedDeficit) && (!needsZeroBufferAck || acknowledgedZeroBuffer);

  const payload = JSON.stringify({
    year: plan.periodRef.year,
    month: plan.periodRef.month,
    period: plan.periodRef.period,
    accounts: plan.accounts.map((a) => ({
      accountId: a.accountId,
      reportedBalance: a.reportedBalance,
      incomeEntered: a.incomeEntered,
      incomeNote: a.incomeNote || null,
    })),
    goals: plan.goals.map((g) => ({ goalId: g.goalId, plannedAmount: g.plannedAmount })),
    essentialCategories: plan.essentialCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.plannedAmount,
    })),
    flexibleCategories: plan.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.plannedAmount,
    })),
    buffer: plan.plannedBuffer,
    includedCarryover: plan.includedCarryover,
    acknowledgedDeficit,
    acknowledgedZeroBuffer,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.wizardTitle(plan.periodLabel)}</DialogTitle>
          <DialogDescription>{t.stepOf(step, STEP_COUNT)}</DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex min-h-0 flex-1 flex-col gap-4">
          <input type="hidden" name="payload" value={payload} />
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {step === 1 ? (
              <StepBalances accounts={plan.accounts} onChange={updateAccount} t={t} />
            ) : null}
            {step === 2 ? (
              <StepIncome
                accounts={plan.accounts}
                totalIncome={totalIncome}
                displayCurrency={plan.displayCurrency}
                onChange={updateAccount}
                t={t}
              />
            ) : null}
            {step === 3 ? (
              <StepCommitments
                subscriptions={plan.subscriptions}
                contributions={plan.contributions}
                goals={plan.goals}
                essentialCategories={plan.essentialCategories}
                displayCurrency={plan.displayCurrency}
                bufferFloor={plan.bufferFloor}
                plannedBuffer={plan.plannedBuffer}
                availableCarryover={plan.availableCarryover}
                carryoverBasis={plan.carryoverBasis}
                includedCarryover={plan.includedCarryover}
                totalIncome={totalIncome}
                subscriptionsTotal={plan.subscriptionsTotal}
                contributionsTotal={plan.contributionsTotal}
                goalPlanTotal={goalPlanTotal}
                essentialFixedTotal={essentialFixedTotal}
                available={available}
                onGoalChange={updateGoal}
                onEssentialChange={updateEssential}
                onBufferChange={(value) => setPlan((prev) => ({ ...prev, plannedBuffer: value }))}
                onCarryoverChange={(value) =>
                  setPlan((prev) => ({ ...prev, includedCarryover: value }))
                }
                t={t}
              />
            ) : null}
            {step === 4 ? (
              <StepFlexible
                categories={plan.flexibleCategories}
                displayCurrency={plan.displayCurrency}
                available={available}
                daysRemaining={plan.daysRemainingInPlanPeriod}
                onChange={updateFlexible}
                t={t}
              />
            ) : null}
            {step === 5 ? (
              <StepConfirm
                incomeTransactionCount={incomeTransactionCount}
                totalIncome={totalIncome}
                budgetCount={budgetCount}
                displayCurrency={plan.displayCurrency}
                needsDeficitAck={needsDeficitAck}
                acknowledgedDeficit={acknowledgedDeficit}
                onAcknowledgeDeficitChange={setAcknowledgedDeficit}
                needsZeroBufferAck={needsZeroBufferAck}
                acknowledgedZeroBuffer={acknowledgedZeroBuffer}
                onAcknowledgeZeroBufferChange={setAcknowledgedZeroBuffer}
                isEditingConfirmed={plan.isEditingConfirmed}
                formError={state?.error ?? null}
                t={t}
              />
            ) : null}
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <div className="flex gap-2">
              {step > 1 ? (
                <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)}>
                  {t.back}
                </Button>
              ) : (
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {common.cancel}
                </Button>
              )}
            </div>
            {step < STEP_COUNT ? (
              <Button type="button" onClick={() => setStep((s) => s + 1)}>
                {t.next}
              </Button>
            ) : (
              <SubmitButton pending={pending} disabled={!canConfirm}>
                {t.confirmPlan}
              </SubmitButton>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

Note: `SubmitButton` doesn't currently accept a `disabled` prop (check `src/components/form/submit-button.tsx` from earlier research - it only spreads `pending`/`variant`/`size`/`className`/`children` onto `<Button disabled={pending} .../>`). Add a `disabled?: boolean` prop to `SubmitButton` in this step so `disabled={!canConfirm}` actually gates the button (combine it with `pending`: `disabled={pending || disabled}`):

Modify `src/components/form/submit-button.tsx`:
```tsx
"use client";

import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SubmitButton({
  children,
  pending,
  disabled,
  className,
  variant,
  size,
}: {
  children: React.ReactNode;
  pending: boolean;
  disabled?: boolean;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  return (
    <Button
      type="submit"
      disabled={pending || disabled}
      variant={variant}
      size={size}
      className={cn(className)}
    >
      {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      {children}
    </Button>
  );
}
```
This is additive (`disabled` is optional, defaults to `undefined` -> falsy) so every other existing call site of `SubmitButton` is unaffected.

- [ ] **Step 7: Manual check**

```bash
npm run dev
```
This component isn't wired into any page yet (Task 11 does that) - defer the actual click-through check to Task 11's manual check step, but run `npm run typecheck` now to catch structural issues early:
```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/components/payday src/components/form/submit-button.tsx
git commit -m "feat: add the payday check-in wizard (5-step dialog: balances, income, commitments/goals, flexible categories, confirm)"
```

---

## Task 11: Dashboard integration — banner card, auto-open, and post-confirmation summary

**Files:**
- Create: `src/components/dashboard/payday-checkin-card.tsx`
- Modify: `src/app/(app)/page.tsx`

**Interfaces:**
- Consumes: `PaydayCheckinDialog` (Task 10), `getPaydayCheckinDraft` (Task 5), `dismissPaydayPromptAction` (Task 7), `isPaydayDate` (Task 2), `isSameDay` (existing, `@/lib/date`), `getSettings` (existing, `@/lib/auth`).
- Produces: `<PaydayCheckinCard draft rates locale shouldAutoOpen />` rendered at the top of the Dashboard.

- [ ] **Step 1: Create `src/components/dashboard/payday-checkin-card.tsx`**

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";

import { PaydayCheckinDialog } from "@/components/payday/payday-checkin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { convert, formatMoney, type RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";
import { round2 } from "@/lib/money";
import { availableForFlexibleCategories } from "@/lib/payday";
import { dismissPaydayPromptAction } from "@/server/actions/payday";

/**
 * Shows either the "not confirmed yet" prompt (with a dismiss that only
 * suppresses today's auto-open, never the card itself) or, once this period's
 * check-in is confirmed, a compact read-only summary with a way to reopen and
 * revise the plan - the dialog pre-fills from the confirmed check-in either way.
 */
export function PaydayCheckinCard({
  draft,
  rates,
  locale,
  shouldAutoOpen,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  shouldAutoOpen: boolean;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(shouldAutoOpen);

  if (draft.isEditingConfirmed) {
    const totalIncome = round2(
      draft.accounts.reduce(
        (sum, a) => sum + convert(a.incomeEntered, a.currency, draft.displayCurrency, rates),
        0,
      ),
    );
    const goalPlanTotal = round2(
      draft.goals.reduce(
        (sum, g) => sum + convert(g.plannedAmount, g.currency, draft.displayCurrency, rates),
        0,
      ),
    );
    const essentialFixedTotal = round2(
      draft.essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0),
    );
    const flexibleTotal = round2(draft.flexibleCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
    const available = availableForFlexibleCategories({
      income: totalIncome,
      includedCarryover: draft.includedCarryover,
      subscriptions: draft.subscriptionsTotal,
      recurringContributions: draft.contributionsTotal,
      goalPlan: goalPlanTotal,
      essentialFixed: essentialFixedTotal,
      buffer: draft.plannedBuffer,
    });

    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.wizardTitle(draft.periodLabel)}</CardTitle>
          <CardDescription>
            {t.summaryIncome}: {formatMoney(totalIncome, draft.displayCurrency)} · {t.summaryBuffer}:{" "}
            {formatMoney(draft.plannedBuffer, draft.displayCurrency)} · {t.summaryAvailable}:{" "}
            {formatMoney(available, draft.displayCurrency)} · {t.flexibleAllocated}:{" "}
            {formatMoney(flexibleTotal, draft.displayCurrency)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {t.reviewConfirmedPlan}
          </Button>
        </CardContent>
        <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t.bannerTitle}</CardTitle>
        <CardDescription>{t.bannerDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t.startCheckin}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const result = await dismissPaydayPromptAction(null);
            if (result?.error) toast.error(result.error);
          }}
        >
          {t.dismissForToday}
        </Button>
      </CardContent>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
```

- [ ] **Step 2: Wire it into `src/app/(app)/page.tsx`**

Change the top of the file from:
```tsx
import Link from "next/link";

import { GoalCard } from "@/components/dashboard/goal-card";
import { MonthlyPaceCard } from "@/components/dashboard/monthly-pace-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { getMonthlyPace } from "@/lib/data/monthly";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const dictionary = getDictionary(context.language);
  const t = dictionary.dashboard;
  const [{ summary, upcoming, goals }, monthlyPace] = await Promise.all([
    getDashboardData(context),
    getMonthlyPace(context),
  ]);
  const elapsed = daysElapsedInPeriod(context.today, context.currentPeriod);
  const activeGoals = goals.filter((goal) => !goal.achievedAt);
  const shownGoals = activeGoals.length > 0 ? activeGoals : goals;

  return (
    <div className="space-y-6">
      <PeriodHero summary={summary} elapsed={elapsed} t={t} />
```
to:
```tsx
import Link from "next/link";

import { GoalCard } from "@/components/dashboard/goal-card";
import { MonthlyPaceCard } from "@/components/dashboard/monthly-pace-card";
import { PaydayCheckinCard } from "@/components/dashboard/payday-checkin-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSettings } from "@/lib/auth";
import { isSameDay } from "@/lib/date";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { getMonthlyPace } from "@/lib/data/monthly";
import { getPaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod, isPaydayDate } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const dictionary = getDictionary(context.language);
  const t = dictionary.dashboard;
  const [{ summary, upcoming, goals }, monthlyPace, paydayDraft, settings] = await Promise.all([
    getDashboardData(context),
    getMonthlyPace(context),
    getPaydayCheckinDraft(context),
    getSettings(),
  ]);
  const elapsed = daysElapsedInPeriod(context.today, context.currentPeriod);
  const activeGoals = goals.filter((goal) => !goal.achievedAt);
  const shownGoals = activeGoals.length > 0 ? activeGoals : goals;
  const dismissedToday = settings.checkinPromptDismissedOn
    ? isSameDay(settings.checkinPromptDismissedOn, context.today)
    : false;
  const shouldAutoOpenCheckin =
    isPaydayDate(context.today) && !paydayDraft.isEditingConfirmed && !dismissedToday;

  return (
    <div className="space-y-6">
      <PaydayCheckinCard
        draft={paydayDraft}
        rates={context.rates}
        locale={context.language}
        shouldAutoOpen={shouldAutoOpenCheckin}
      />
      <PeriodHero summary={summary} elapsed={elapsed} t={t} />
```
(Only the imports, the destructured `Promise.all` result, the two new `const` computations, and the new `<PaydayCheckinCard .../>` line change - everything from `<PeriodHero .../>` onward in the existing JSX is unchanged.)

- [ ] **Step 3: Manual check**

```bash
npm run dev
```
Visit `/`: confirm the "Payday check-in ready" card appears, "Start payday check-in" opens the 5-step dialog pre-filled with your real active accounts/ledger balances/subscriptions/goals, "Not now" dismisses without error, and stepping through Balances → Income → Commitments/Goals → Flexible → Confirm and clicking "Confirm plan" succeeds, closes the dialog, and the dashboard card switches to the confirmed summary variant with a working "Review this period's plan" reopen button. Also manually set your system date (or temporarily hardcode `isPaydayDate` to return `true` for a quick check, then revert) to confirm the dialog auto-opens on a payday when nothing is confirmed yet.

- [ ] **Step 4: Typecheck, lint, and commit**

```bash
npm run typecheck
npm run lint
git add src/components/dashboard/payday-checkin-card.tsx "src/app/(app)/page.tsx"
git commit -m "feat: surface the payday check-in on the Dashboard with payday auto-open and a post-confirmation summary"
```

---

## Task 12: Budgets page — "Plan this period" entry point

**Files:**
- Create: `src/components/payday/plan-this-period-button.tsx`
- Modify: `src/app/(app)/budgets/page.tsx`

**Interfaces:**
- Consumes: `PaydayCheckinDialog` (Task 10), `getPaydayCheckinDraft` (Task 5).
- Produces: `<PlanThisPeriodButton draft rates locale />`, shown on the Budgets page only while viewing the actual current pay period (`isCurrent`).

- [ ] **Step 1: Create `src/components/payday/plan-this-period-button.tsx`**

```tsx
"use client";

import { useState } from "react";

import { PaydayCheckinDialog } from "@/components/payday/payday-checkin-dialog";
import { Button } from "@/components/ui/button";
import type { RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";

export function PlanThisPeriodButton({
  draft,
  rates,
  locale,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t.planThisPeriod}
      </Button>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </>
  );
}
```

- [ ] **Step 2: Wire it into `src/app/(app)/budgets/page.tsx`**

Add to the imports:
```ts
import { PlanThisPeriodButton } from "@/components/payday/plan-this-period-button";
import { getPaydayCheckinDraft } from "@/lib/data/payday";
```

Change:
```ts
  const [summary, categories, budgetRows] = await Promise.all([
    getPeriodSummary(period, context),
    prisma.category.findMany({
      where: { kind: "EXPENSE" },
      orderBy: { name: "asc" },
    }),
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
  ]);
```
to:
```ts
  const [summary, categories, budgetRows, paydayDraft] = await Promise.all([
    getPeriodSummary(period, context),
    prisma.category.findMany({
      where: { kind: "EXPENSE" },
      orderBy: { name: "asc" },
    }),
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
    isCurrent ? getPaydayCheckinDraft(context) : Promise.resolve(null),
  ]);
```
(`isCurrent` is already computed above this block in the existing file, from `period.key === context.currentPeriod.key` - only fetch the draft when it's actually needed.)

Change the `actions` prop of `<PageHeader>` from:
```tsx
        actions={
          <ActionButton
            action={copyPreviousBudgetsAction}
            fields={{
              year: period.year,
              month: period.month,
              period: period.period,
            }}
            size="sm"
          >
            <Copy className="size-3.5" />
            {t.copyLastPeriod}
          </ActionButton>
        }
```
to:
```tsx
        actions={
          <>
            {paydayDraft ? (
              <PlanThisPeriodButton draft={paydayDraft} rates={context.rates} locale={context.language} />
            ) : null}
            <ActionButton
              action={copyPreviousBudgetsAction}
              fields={{
                year: period.year,
                month: period.month,
                period: period.period,
              }}
              size="sm"
            >
              <Copy className="size-3.5" />
              {t.copyLastPeriod}
            </ActionButton>
          </>
        }
```

- [ ] **Step 3: Manual check**

```bash
npm run dev
```
Visit `/budgets`: confirm "Plan this period" appears next to "Copy last period" while viewing the current period, opens the same wizard, and disappears when navigating to a past/future period via the period arrows.

- [ ] **Step 4: Typecheck, lint, and commit**

```bash
npm run typecheck
npm run lint
git add src/components/payday/plan-this-period-button.tsx "src/app/(app)/budgets/page.tsx"
git commit -m "feat: add a Plan this period entry point to the Budgets page"
```

---

## Task 13: Goals pages — show the confirmed plan's allocation alongside actual progress

**Files:**
- Modify: `src/app/(app)/goals/page.tsx`
- Modify: `src/app/(app)/goals/[id]/page.tsx`

**Interfaces:**
- Consumes: `planPeriodRef` (Task 5), `t.plannedThisPeriod`/`t.plannedBehindRoadmap` (Task 9).
- Produces: no new exports - both pages read the confirmed `PaydayPlanAllocation` (type `GOAL`) for the current plan period directly via `prisma`, matching the read pattern every other page in this codebase already uses for one-off queries (e.g. `budgets/page.tsx`'s direct `prisma.budget.findMany`).

- [ ] **Step 1: Show it on the goals list, `src/app/(app)/goals/page.tsx`**

Add to the imports:
```ts
import { planPeriodRef } from "@/lib/data/payday";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
```

After `const common = getDictionary(context.language).common;`, add:
```ts
  const planRef = planPeriodRef(context);
  const confirmedCheckin = await prisma.paydayCheckin.findFirst({
    where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
    include: { allocations: { where: { type: "GOAL" } } },
  });
  const plannedByGoalId = new Map(
    (confirmedCheckin?.allocations ?? []).map((allocation) => [allocation.goalId as string, allocation]),
  );
```

Inside the `goals.map((goal) => ( <Card key={goal.id}> <CardContent className="space-y-4"> ... `, right after the closing `</div>` of the `<div className="flex items-end justify-between gap-3">` block (the one containing the per-period/pace text and the `ContributionDialog` trigger) and still inside `CardContent`, add:
```tsx
                {plannedByGoalId.has(goal.id) ? (
                  <p className="text-xs text-muted-foreground">
                    {t.plannedThisPeriod(
                      formatMoney(num(plannedByGoalId.get(goal.id)!.plannedAmount), goal.currency),
                    )}
                  </p>
                ) : null}
```

- [ ] **Step 2: Show it on the goal detail page, `src/app/(app)/goals/[id]/page.tsx`**

Add to the imports:
```ts
import { planPeriodRef } from "@/lib/data/payday";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
```

After `const detail = await getGoalDetail(id, context); if (!detail) notFound();`, add:
```ts
  const planRef = planPeriodRef(context);
  const confirmedCheckin = await prisma.paydayCheckin.findFirst({
    where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
    include: { allocations: { where: { type: "GOAL", goalId: id } } },
  });
  const plannedAllocation = confirmedCheckin?.allocations[0] ?? null;
```

Right after the `{drifted ? ( <p className="text-xs text-[var(--warning)]"> ... </p> ) : null}` block, still inside the same `<CardContent className="space-y-6">`, add:
```tsx
          {plannedAllocation ? (
            <p className="text-xs text-muted-foreground">
              {t.plannedThisPeriod(formatMoney(num(plannedAllocation.plannedAmount), summary.currency))}
              {num(plannedAllocation.recommendedAmount) - num(plannedAllocation.plannedAmount) > 0.005
                ? ` · ${t.plannedBehindRoadmap(
                    formatMoney(
                      num(plannedAllocation.recommendedAmount) - num(plannedAllocation.plannedAmount),
                      summary.currency,
                    ),
                  )}`
                : ""}
            </p>
          ) : null}
```

- [ ] **Step 3: Manual check**

```bash
npm run dev
```
Confirm a dated goal, after being included in a confirmed payday check-in, shows "X planned this period" on both `/goals` and its detail page - and, if you lower the planned amount below the roadmap recommendation during the check-in, the "behind the roadmap" note appears too.

- [ ] **Step 4: Typecheck, lint, and commit**

```bash
npm run typecheck
npm run lint
git add "src/app/(app)/goals/page.tsx" "src/app/(app)/goals/[id]/page.tsx"
git commit -m "feat: show the confirmed payday plan's goal allocation on the Goals pages"
```

---

## Task 14: End-to-end payday check-in verification in `scripts/verify-domain.ts`

**Files:**
- Modify: `scripts/verify-domain.ts`

**Interfaces:**
- Consumes: `getPaydayCheckinDraft` (Task 5), `confirmPaydayCheckinAction` (Task 7), `getAccountBalances` (already imported earlier in the script by Task 3 - reuse that same binding, don't re-import it), `num` (new top-level import from `@/lib/money`).

This is the largest single test block in the script - it exercises the full confirm flow against real database writes, covering testing checklist items 4-9, 15-21, and 23 from the spec that aren't already covered by Task 2's pure assertions or Task 3's account-lifecycle assertions.

- [ ] **Step 1: Add `num` to the top-level imports**

Change:
```ts
import {
  appTimeZone,
  civilDate,
  civilDateInZone,
  DEFAULT_APP_TIMEZONE,
  formatDate,
  toISODate,
} from "../src/lib/date";
```
Leave that block as-is, and add a new import line right after the `import { advanceDate } from "../src/lib/recurring";` line (and after the `isPaydayDate`/`payday` imports Task 2 already added):
```ts
import { num } from "../src/lib/money";
```

- [ ] **Step 2: Add the payday check-in section**

Add this new section right before `console.log("\n== cleanup ==")` (after every section added by Tasks 2 and 3):

```ts
  console.log("\n== payday check-in (database) ==");
  const { getPaydayCheckinDraft } = await import("../src/lib/data/payday");
  const { confirmPaydayCheckinAction } = await import("../src/server/actions/payday");

  function buildFormData(payload: unknown): FormData {
    const form = new FormData();
    form.set("payload", JSON.stringify(payload));
    return form;
  }

  const paydayContext = {
    displayCurrency: "USD" as const,
    language: "en" as const,
    rates,
    today: civilDate(2026, 8, 15),
    currentPeriod: periodForDate(civilDate(2026, 8, 15)),
  };

  const paydayChecking = await prisma.account.create({
    data: { name: "Verify Payday Checking", currency: "USD", type: "CHECKING" },
  });
  const paydayEuro = await prisma.account.create({
    data: { name: "Verify Payday Euro", currency: "EUR", type: "CHECKING" },
  });
  await prisma.transaction.createMany({
    data: [
      { date: civilDate(2026, 8, 1), amount: 1000, currency: "USD", type: "INCOME", accountId: paydayChecking.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 5), amount: 200, currency: "USD", type: "EXPENSE", accountId: paydayChecking.id, source: "MANUAL" },
      { date: civilDate(2026, 8, 2), amount: 100, currency: "EUR", type: "INCOME", accountId: paydayEuro.id, source: "MANUAL" },
    ],
  });

  const billsCategory = await prisma.category.findFirstOrThrow({ where: { name: "Bills" } });
  await prisma.category.update({ where: { id: billsCategory.id }, data: { isEssentialFixed: true } });
  const groceriesForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
  const subsCategoryForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Subscriptions" } });
  const savingsCategoryForPayday = await prisma.category.findFirstOrThrow({ where: { name: "Savings/Investment" } });

  const paydaySub = await prisma.recurringItem.create({
    data: { name: "Verify Payday Netflix", amount: 15, currency: "USD", frequency: "MONTHLY", kind: "SUBSCRIPTION", nextDate: civilDate(2026, 8, 20), active: true, categoryId: subsCategoryForPayday.id },
  });
  const paydayContribution = await prisma.recurringItem.create({
    data: { name: "Verify Payday Auto-Invest", amount: 100, currency: "USD", frequency: "MONTHLY", kind: "CONTRIBUTION", nextDate: civilDate(2026, 8, 20), active: true },
  });

  const datedGoal = await prisma.goal.create({
    data: { name: "Verify Payday Dated Goal", targetAmount: 1000, currency: "USD", targetDate: civilDate(2026, 10, 15) },
  });
  const undatedGoal = await prisma.goal.create({
    data: { name: "Verify Payday Undated Goal", targetAmount: 1000, currency: "USD" },
  });

  console.log("\n-- draft assembly --");
  const draft = await getPaydayCheckinDraft(paydayContext);
  eq(
    "opened exactly on a payday, the plan targets the next period, not the one ending today",
    `${draft.periodRef.year}-${draft.periodRef.month}-${draft.periodRef.period}`,
    "2026-8-B",
  );
  check(
    "dynamic active accounts include a newly created account",
    draft.accounts.some((a) => a.accountId === paydayChecking.id),
  );
  eq(
    "the draft's ledger balance is transaction-derived, matching getAccountBalances",
    draft.accounts.find((a) => a.accountId === paydayChecking.id)?.expectedLedgerBalance,
    800,
  );
  check(
    "a subscription due in the plan period is reserved separately from contributions",
    draft.subscriptions.some((s) => s.recurringItemId === paydaySub.id) &&
      !draft.contributions.some((c) => c.recurringItemId === paydaySub.id),
  );
  check(
    "a recurring contribution due in the plan period is reserved separately from subscriptions",
    draft.contributions.some((c) => c.recurringItemId === paydayContribution.id) &&
      !draft.subscriptions.some((s) => s.recurringItemId === paydayContribution.id),
  );
  check(
    "only the dated goal is reserved - the undated goal is not automatically included",
    draft.goals.some((g) => g.goalId === datedGoal.id) && !draft.goals.some((g) => g.goalId === undatedGoal.id),
  );
  check(
    "a category marked essential fixed appears in essentialCategories, not flexibleCategories",
    draft.essentialCategories.some((c) => c.categoryId === billsCategory.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === billsCategory.id),
  );
  check(
    "the Subscriptions category is never offered as an essential or flexible suggestion",
    !draft.essentialCategories.some((c) => c.categoryId === subsCategoryForPayday.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === subsCategoryForPayday.id),
  );
  check(
    "the Savings/Investment category is never offered as an essential or flexible suggestion",
    !draft.essentialCategories.some((c) => c.categoryId === savingsCategoryForPayday.id) &&
      !draft.flexibleCategories.some((c) => c.categoryId === savingsCategoryForPayday.id),
  );
  check(
    "a non-essential expense category appears as a flexible suggestion",
    draft.flexibleCategories.some((c) => c.categoryId === groceriesForPayday.id),
  );

  await prisma.account.update({
    where: { id: paydayEuro.id },
    data: { status: "ARCHIVED", archivedAt: paydayContext.today },
  });
  const draftAfterArchive = await getPaydayCheckinDraft(paydayContext);
  check(
    "archiving an account removes it from the next check-in's active list",
    !draftAfterArchive.accounts.some((a) => a.accountId === paydayEuro.id),
  );
  await prisma.account.update({ where: { id: paydayEuro.id }, data: { status: "ACTIVE", archivedAt: null } });

  console.log("\n-- confirming a plan --");
  const draftForConfirm = await getPaydayCheckinDraft(paydayContext);
  const initialPayload = {
    year: draftForConfirm.periodRef.year,
    month: draftForConfirm.periodRef.month,
    period: draftForConfirm.periodRef.period,
    accounts: draftForConfirm.accounts.map((a) => ({
      accountId: a.accountId,
      reportedBalance: a.expectedLedgerBalance + (a.accountId === paydayChecking.id ? 50 : 0),
      incomeEntered: a.accountId === paydayChecking.id ? 500 : 0,
      incomeNote: a.accountId === paydayChecking.id ? "Salary" : null,
    })),
    goals: draftForConfirm.goals.map((g) => ({ goalId: g.goalId, plannedAmount: g.recommendedAmount })),
    essentialCategories: draftForConfirm.essentialCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    flexibleCategories: draftForConfirm.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount,
    })),
    buffer: draftForConfirm.suggestedBuffer,
    includedCarryover: 0,
    acknowledgedDeficit: true,
    acknowledgedZeroBuffer: true,
  };

  const confirmResult = await confirmPaydayCheckinAction(null, buildFormData(initialPayload));
  check("confirming a payday check-in succeeds", confirmResult?.ok === true);

  const checkinRow = await prisma.paydayCheckin.findFirst({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  check("exactly one confirmed PaydayCheckin row exists for the period", Boolean(checkinRow) && checkinRow!.status === "CONFIRMED");

  const checkingSnapshot = await prisma.paydayAccountSnapshot.findFirst({
    where: { paydayCheckinId: checkinRow!.id, accountId: paydayChecking.id },
  });
  eq("the snapshot stores the expected ledger balance for audit", num(checkingSnapshot!.expectedLedgerBalance), 800);
  eq("the snapshot stores the reported balance separately from the ledger balance", num(checkingSnapshot!.reportedBalance), 850);
  eq("the difference is reported minus expected - a diagnostic figure only", num(checkingSnapshot!.difference), 50);

  const balancesAfterConfirm = await getAccountBalances(paydayContext, { status: "ACTIVE" });
  const checkingBalanceAfterConfirm = balancesAfterConfirm.find((a) => a.id === paydayChecking.id)!;
  eq(
    "the reconciliation difference never changes the transaction-derived ledger balance - only the new income transaction does",
    checkingBalanceAfterConfirm.balance,
    1350,
  );

  const incomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  check("a confirmed check-in creates an INCOME transaction sourced as PAYDAY_CHECKIN", Boolean(incomeTransaction));
  eq("the income transaction amount matches what was entered", num(incomeTransaction!.amount), 500);
  eq(
    "the income transaction is dated with today's business date",
    toISODate(incomeTransaction!.date),
    toISODate(paydayContext.today),
  );

  const euroIncomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayEuro.id, source: "PAYDAY_CHECKIN" } });
  check("zero/blank income for an active account is valid and creates no income transaction", euroIncomeTransaction === null);

  const goalContributionsAfterConfirm = await prisma.goalContribution.count({ where: { goalId: datedGoal.id } });
  eq("confirming a plan never creates an actual GoalContribution row", goalContributionsAfterConfirm, 0);

  const subscriptionExpenseAfterConfirm = await prisma.transaction.count({
    where: { accountId: paydayChecking.id, type: "EXPENSE", note: { contains: "Netflix" } },
  });
  eq("confirming a plan never creates an actual expense transaction for a reserved subscription", subscriptionExpenseAfterConfirm, 0);

  const goalAllocation = await prisma.paydayPlanAllocation.findFirst({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
  });
  check(
    "the goal's roadmap recommendation is recorded in the allocation audit trail",
    Boolean(goalAllocation) && num(goalAllocation!.recommendedAmount) > 0,
  );

  const essentialAndFlexibleIds = [
    ...draftForConfirm.essentialCategories.map((c) => c.categoryId),
    ...draftForConfirm.flexibleCategories.map((c) => c.categoryId),
  ];
  const budgetRowsAfterConfirm = await prisma.budget.count({
    where: {
      year: draftForConfirm.periodRef.year,
      month: draftForConfirm.periodRef.month,
      period: draftForConfirm.periodRef.period,
      categoryId: { in: essentialAndFlexibleIds },
    },
  });
  eq(
    "an essential/flexible category Budget row is created for every reserved category",
    budgetRowsAfterConfirm,
    essentialAndFlexibleIds.length,
  );

  console.log("\n-- revisiting a confirmed check-in --");
  const updatedPayload = {
    ...initialPayload,
    accounts: initialPayload.accounts.map((a) =>
      a.accountId === paydayChecking.id ? { ...a, incomeEntered: 750, incomeNote: "Salary + bonus" } : a,
    ),
  };
  const reconfirmResult = await confirmPaydayCheckinAction(null, buildFormData(updatedPayload));
  check("re-confirming the same period succeeds", reconfirmResult?.ok === true);

  const checkinCountAfterReconfirm = await prisma.paydayCheckin.count({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  eq("re-confirming the same period never creates a second PaydayCheckin row", checkinCountAfterReconfirm, 1);

  const snapshotCountAfterReconfirm = await prisma.paydayAccountSnapshot.count({
    where: { paydayCheckinId: checkinRow!.id, accountId: paydayChecking.id },
  });
  eq("re-confirming never creates a duplicate snapshot for the same account", snapshotCountAfterReconfirm, 1);

  const incomeTransactionCountAfterReconfirm = await prisma.transaction.count({
    where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" },
  });
  eq("re-confirming updates the existing income transaction instead of creating another", incomeTransactionCountAfterReconfirm, 1);

  const updatedIncomeTransaction = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  eq("the updated income transaction reflects the newly entered amount", num(updatedIncomeTransaction!.amount), 750);

  console.log("\n-- zeroing income removes the transaction, never leaves a stale one --");
  const zeroedPayload = {
    ...initialPayload,
    accounts: initialPayload.accounts.map((a) =>
      a.accountId === paydayChecking.id ? { ...a, incomeEntered: 0, incomeNote: null } : a,
    ),
  };
  await confirmPaydayCheckinAction(null, buildFormData(zeroedPayload));
  const incomeTransactionAfterZeroing = await prisma.transaction.findFirst({ where: { accountId: paydayChecking.id, source: "PAYDAY_CHECKIN" } });
  check("zeroing income on re-confirm removes the previously created income transaction", incomeTransactionAfterZeroing === null);

  console.log("\n-- deficit and zero-buffer acknowledgement gates --");
  const deficitPayload = {
    ...zeroedPayload,
    flexibleCategories: draftForConfirm.flexibleCategories.map((c) => ({
      categoryId: c.categoryId,
      plannedAmount: c.suggestedAmount + 100000,
    })),
    acknowledgedDeficit: false,
  };
  const deficitResult = await confirmPaydayCheckinAction(null, buildFormData(deficitPayload));
  check("confirming an overallocated plan without acknowledging the deficit is rejected", deficitResult?.ok === false);
  const deficitResultAcknowledged = await confirmPaydayCheckinAction(
    null,
    buildFormData({ ...deficitPayload, acknowledgedDeficit: true }),
  );
  check("acknowledging the deficit allows the same overallocated plan through", deficitResultAcknowledged?.ok === true);

  const zeroBufferPayload = { ...zeroedPayload, buffer: 0, acknowledgedDeficit: true, acknowledgedZeroBuffer: false };
  const zeroBufferResult = await confirmPaydayCheckinAction(null, buildFormData(zeroBufferPayload));
  check("confirming a zero-buffer plan without acknowledging it is rejected", zeroBufferResult?.ok === false);

  console.log("\n-- multi-currency income totals --");
  const eurIncomePayload = {
    ...zeroedPayload,
    accounts: zeroedPayload.accounts.map((a) => (a.accountId === paydayEuro.id ? { ...a, incomeEntered: 20 } : a)),
  };
  await confirmPaydayCheckinAction(null, buildFormData(eurIncomePayload));
  const checkinAfterEur = await prisma.paydayCheckin.findFirst({
    where: { year: draftForConfirm.periodRef.year, month: draftForConfirm.periodRef.month, period: draftForConfirm.periodRef.period },
  });
  eq(
    "multi-currency income is converted through USD before summing into the check-in total",
    num(checkinAfterEur!.totalIncome),
    40,
  );

  console.log("\n-- a lowered goal amount is preserved, never silently raised back --");
  const lowGoalPayload = {
    ...zeroedPayload,
    goals: draftForConfirm.goals.map((g) => ({ goalId: g.goalId, plannedAmount: 5 })),
    acknowledgedDeficit: true,
  };
  await confirmPaydayCheckinAction(null, buildFormData(lowGoalPayload));
  const lowGoalAllocation = await prisma.paydayPlanAllocation.findFirst({
    where: { paydayCheckinId: checkinRow!.id, type: "GOAL", goalId: datedGoal.id },
  });
  eq(
    "a user-lowered goal planned amount is stored exactly as entered",
    num(lowGoalAllocation!.plannedAmount),
    5,
  );
  check(
    "the roadmap recommendation stays recorded alongside it, never overwritten to match",
    Boolean(lowGoalAllocation) && num(lowGoalAllocation!.recommendedAmount) > 5,
  );

  console.log("\n-- payday check-in cleanup --");
  await prisma.paydayPlanAllocation.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
  await prisma.paydayAccountSnapshot.deleteMany({ where: { paydayCheckinId: checkinRow!.id } });
  await prisma.paydayCheckin.deleteMany({ where: { id: checkinRow!.id } });
  await prisma.transaction.deleteMany({ where: { accountId: { in: [paydayChecking.id, paydayEuro.id] } } });
  await prisma.account.deleteMany({ where: { id: { in: [paydayChecking.id, paydayEuro.id] } } });
  await prisma.recurringItem.deleteMany({ where: { name: { startsWith: "Verify Payday" } } });
  await prisma.goal.deleteMany({ where: { name: { startsWith: "Verify Payday" } } });
  await prisma.category.update({ where: { id: billsCategory.id }, data: { isEssentialFixed: false } });
  console.log("  ok   payday fixtures removed");
```

- [ ] **Step 3: Run the full verification script**

```bash
DATABASE_URL="<your scratch db url>" npx tsx scripts/verify-domain.ts
```
Expected: every line from `== payday check-in (database) ==` through the cleanup prints `ok`, and the script's final line reads `All checks passed.` If anything fails, re-read the failing assertion's neighboring code in `src/lib/data/payday.ts` or `src/server/actions/payday.ts` rather than adjusting the test's expected numbers to match broken behavior.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add scripts/verify-domain.ts
git commit -m "test: add end-to-end payday check-in coverage to verify-domain.ts"
```

---

## Task 15: Full-project verification and wrap-up

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck, lint, and build**

```bash
npm run typecheck
npm run lint
npm run build
```
Expected: all three succeed with no errors. `npm run build` also runs `prisma generate` first (per its script definition), so this doubles as a final confirmation that the Prisma client and every query in the new code agree with the schema from Task 1.

- [ ] **Step 2: Prisma migration status sanity check**

```bash
npx prisma migrate status
```
Expected: reports the local database is up to date with all migrations in `prisma/migrations/`, including the one from Task 1 - confirms nothing was hand-edited out of sync between the schema and the migration folder.

- [ ] **Step 3: Full verification script run**

```bash
DATABASE_URL="<your scratch db url>" npx tsx scripts/verify-domain.ts
```
Expected: `All checks passed.` - this is the full regression pass covering every existing domain check (pay periods, safe-to-spend, transfers, currency conversion, CSV parsing, goal caching, monthly pace) alongside every new payday/archive check added in Tasks 2, 3, and 14. If anything here fails, it means a change in this plan regressed existing behavior - fix the regression, don't touch the pre-existing assertions.

- [ ] **Step 4: Manual click-through**

```bash
npm run dev
```
Walk through, in order:
1. `/accounts` - Active/Archived tabs, archive an account, confirm it disappears from Active and its history still reads correctly on its detail page, restore it.
2. `/` (Dashboard) - the payday card appears, "Start payday check-in" opens the wizard pre-filled with real data, step through all 5 steps, confirm a plan, see the dashboard card switch to the confirmed summary.
3. `/budgets` - "Plan this period" opens the same wizard on the current period only; the category budgets just confirmed show up in the budgets table.
4. `/goals` and a goal detail page - the confirmed plan's "planned this period" line appears under a dated goal that was part of the plan.
5. `/settings` - Planning preferences save; toggling a category's essential-fixed switch persists after reload.
6. Switch the language to Spanish (existing language switcher in the header) and repeat a quick pass through the wizard and the new Settings cards - confirm no English text is visible anywhere.
7. Switch the display currency (existing currency switcher) and confirm every amount in the wizard and the dashboard summary re-renders in the new currency.

- [ ] **Step 5: Confirm no regressions to preserved functionality**

Spot-check, per the task's scope requirements, that these are all unaffected: manual transaction entry, CSV import, the Gmail/Outlook review queue, transfers, half-month budgets and safe-to-spend, monthly spending pace, and recurring items. (The verification script in Step 3 already covers the domain logic for all of these; this step is the corresponding UI spot-check.)

---

## Delivery Notes (for the final summary to the user)

When this plan is fully executed, the final report to the user should cover:

1. **What was built:** payday check-in + smart budget planner (5-step wizard: balances, income, commitments/goals/buffer, flexible categories, confirm), account archive/restore, essential-fixed category configuration, and planning preferences in Settings.
2. **The formula table**, exactly as specified: `availableForFlexibleCategories = income + includedCarryover - subscriptions - recurringContributions - goalPlan - essentialFixed - buffer`.
3. **Active/archived accounts:** `Account.status` (`ACTIVE`/`ARCHIVED`) with `archivedAt`; archived accounts are excluded from `getAccountBalances`'s default (active-only) list used everywhere a new record needs an account, but remain fully readable by id everywhere historical data is shown; permanent delete is blocked while any transaction/staged-transaction/snapshot history exists.
4. **What's recorded as what:** INCOME transactions (source `PAYDAY_CHECKIN`) only on confirm, for entered amounts > 0; `PaydayAccountSnapshot` rows for reconciliation only (never touch the ledger); `PaydayPlanAllocation` rows as an audit trail of every recommended-vs-planned figure; `Budget` rows for essential + flexible categories only; explicitly **never** an actual `GoalContribution` or an actual subscription/contribution expense transaction.
5. **Migrations required:** one new additive migration from Task 1 (`add_payday_checkin_and_account_archive`). Note explicitly that production Supabase is **not** migrated automatically - the user must run the documented `DEPLOY.md` flow (`npm run db:migrate` against `.env.supabase`) before this ships to production, the same manual step every prior migration in this repo has required.
6. **Files changed:** list every file touched across all 15 tasks.
7. **Test coverage:** the pure-logic assertions from Task 2, the account-lifecycle assertions from Task 3, and the full end-to-end payday check-in assertions from Task 14, all inside `scripts/verify-domain.ts` - report the actual `npx tsx scripts/verify-domain.ts` output, not a paraphrase.
8. **Deliberate simplifications to disclose:**
   - No automated test framework was introduced (per the task's own constraint) - `scripts/verify-domain.ts` is the sole verification tool, run manually against a scratch database.
   - `PaydayCheckin.status` supports `DRAFT` in the schema for forward-compatibility, but this implementation only ever writes `CONFIRMED` rows - nothing is persisted until the final "Confirm plan" step, so there is no separate mid-wizard draft-saving feature.
   - The transactions-page "filter by account" dropdown was narrowed to active accounts only, alongside the "pick an account for a new record" selectors - filtering existing transaction history by an archived account's name specifically was treated as out of scope.
   - Category suggestion history looks back over the previous 6 same-letter pay periods (roughly 3 months) - a fixed, undocumented-by-the-spec window chosen to mirror the existing monthly-pace feature's own 6-month lookback constant.
   - Settings does not have a dedicated "Categories" page (none existed before this feature) - essential-fixed configuration was added to the existing Settings page instead of a new page, to avoid an unrequested new area of the app.
9. Keep the final answer concise, per the task's own `<delivery>` instructions.
