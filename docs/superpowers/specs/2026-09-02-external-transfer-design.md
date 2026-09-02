# External transfers: a first-class representation for pass-through money movements

## Problem

Cadence's transaction model assumes every money movement is exactly one of:
`EXPENSE`, `INCOME`, `TRANSFER` (two rows, both legs anchored to a real
tracked `Account`), or `OPENING_BALANCE`.

Real BSC bank CSV data breaks this assumption. Rows like "Debito Por
Transferencia" (DOP 5,000 to a family member's account, DOP 134,422 on
2026-04-16, DOP 115,000 on 2026-08-21) and "Transferencia Recibida..." are
bank-description "transfers" that:

1. Reduce (or raise) the BSC account balance.
2. Are not personal spending or income.
3. Are not internal Cadence transfers — the counterparty is not a tracked
   Cadence account, and Cadence must never invent one to make the existing
   `TRANSFER` model fit.

Today the CSV import review flow only offers two outcomes for a
transfer-shaped row: record it as an internal `TRANSFER` (forcing the user to
pick some tracked account as the other side, even when none exists) or leave
it as a plain `EXPENSE`/`INCOME` (which silently inflates spending/income —
the actual bug). There is no correct third option, and nothing changes if the
user ignores the "possible transfer" review card entirely — the row still
imports as ordinary EXPENSE/INCOME.

## Decision: a fourth `TransactionType`, `EXTERNAL_TRANSFER`

Add `EXTERNAL_TRANSFER` to the `TransactionType` enum. It is a **single row**
(no paired leg — `transferId` stays null), anchored to exactly one tracked
`Account`, using the existing (nullable) `transferDirection` field (`OUT` /
`IN`) to mean "money left this account" / "money arrived in this account,"
rather than "which leg of a paired transfer."

This is the same shape of fix as the existing `OPENING_BALANCE` type: a
transaction kind that is neither income, expense, nor an internal transfer,
excluded from budgets/income/spending via `isCashflow()`, but still affects
the account balance via `balanceSign()`.

`categoryId` is always forced to `null` for `EXTERNAL_TRANSFER` rows —
`CategoryKind` only has `EXPENSE`/`INCOME`, and inventing a category would be
as wrong as inventing a destination account. The transaction's `note` field
remains available for the user's own free-text context ("Sent to Mom"), same
as any other transaction.

### Alternatives considered and rejected

- **A boolean `excludeFromBudget` flag on EXPENSE/INCOME rows.** Rejected:
  `period-summary.ts` and `reports.ts` filter `type: {in: ["EXPENSE",
  "INCOME"]}` directly in their Prisma queries, not through `isCashflow()`. A
  flag would need to be threaded into every such query individually and is
  easy to miss in a future one. A distinct type is excluded automatically by
  the same type filters that already exist — no call site needs to change to
  stay correct.
- **A one-legged `TRANSFER` row** (reuse `TRANSFER`, skip the second leg).
  Rejected: breaks the tested invariant that a transfer is always exactly two
  rows sharing `transferId`, enforced in `saveTransferAction`,
  `deleteTransactionAction`, and asserted in `scripts/verify-domain.ts`.
  Cheaper and clearer to add one enum value than special-case that invariant
  everywhere it's checked.

## Schema change

```prisma
enum TransactionType {
  EXPENSE
  INCOME
  TRANSFER
  OPENING_BALANCE
  EXTERNAL_TRANSFER
}
```

Migration (new `prisma/migrations/<timestamp>_add_external_transfer_type/migration.sql`),
following the exact precedent of `20260902032302_add_opening_balance_transaction_type`:

```sql
-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'EXTERNAL_TRANSFER';
```

No other schema change. `transferDirection`'s doc comment is updated to
reflect its dual meaning (transfer leg, or external-transfer direction).

This migration only adds an enum value — it does not touch any existing row.
No historical data is migrated, reclassified, or backfilled as part of this
work; that is explicitly out of scope (see "Out of scope" below).

## Domain logic

`src/lib/transactions.ts`:

- `balanceSign(type, transferDirection)`: add
  `if (type === "EXTERNAL_TRANSFER") return transferDirection === "IN" ? 1 : -1;`
  (identical shape to the existing `TRANSFER` case).
- `isCashflow(type)`: **no change** — already `type === "INCOME" || type === "EXPENSE"`,
  so `EXTERNAL_TRANSFER` is excluded by default, same as `TRANSFER` and
  `OPENING_BALANCE`.
- `transactionEditBlock(row)`: **no change** — `EXTERNAL_TRANSFER` rows have
  `transferId: null`, so they are not blocked; they're edited through the
  normal transaction form/dialog like an expense or income row.

## Call sites confirmed unaffected (verified during investigation)

- `getPeriodSummary`, `getMonthlyPace`, `classifyCompletedMonth`,
  `getSpendingTrend` — all query `type: {in: ["EXPENSE","INCOME"]}` directly;
  `EXTERNAL_TRANSFER` rows are excluded by construction.
- `getAccountBalances` — loops over `balanceSign(group.type, group.transferDirection)`
  generically; no change needed.
- Payday check-in / `getCategorySuggestions` — reads only `getPeriodSummary`
  category spend (EXPENSE) and `Budget` rows; unaffected.

## Call sites that need changes

### `src/lib/data/accounts.ts` — `getAccountLedger`

Add `externalIn` / `externalOut` totals alongside the existing `inflow` /
`outflow` / `transfersIn` / `transfersOut`, filtering on
`row.type === "EXTERNAL_TRANSFER"` and `row.effect > 0` / `< 0` respectively
(same pattern as the existing `transfersIn`/`transfersOut` computation). The
account detail view renders these as a distinct line so external movements
don't vanish from the account's totals or get miscounted as internal
transfers.

### `src/lib/validation.ts` — `transactionSchema`

- `type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"])`.
- Add `transferDirection: z.enum(["OUT", "IN"]).optional()`.
- `superRefine`: require `transferDirection` when `type === "EXTERNAL_TRANSFER"`;
  force `categoryId` to `null` and `transferDirection` to `null`/undefined
  when `type !== "EXTERNAL_TRANSFER"`.

### `src/components/transactions/transaction-dialog.tsx`

- Add `"EXTERNAL_TRANSFER"` to the type `EnumSelect` options.
- When `type === "EXTERNAL_TRANSFER"`: hide the category field, show a
  direction control (Outgoing / Incoming) mapped to `transferDirection`.
  This is client-side conditional rendering in an existing client component
  — no new dialog.

### `src/components/transactions/transaction-table.tsx`

- `AmountCell`: extend the existing `TRANSFER`/`OPENING_BALANCE` branches to
  include `EXTERNAL_TRANSFER` — no leading `+`/`-`, muted tone (per your
  "neutral, transfer-family styling" choice).
- Description fallback: when `type === "EXTERNAL_TRANSFER"` and no `note`,
  show a new localized label ("External transfer out" / "External transfer
  in") instead of falling through to "Uncategorized."
- No counterpart-account rendering for `EXTERNAL_TRANSFER` (there isn't one)
  — the existing `row.type === "TRANSFER" && row.counterpartAccountName`
  branch is unaffected since it's already gated on `TRANSFER` specifically.
- `SourceBadge`'s `isTransfer` prop: extend to true for `EXTERNAL_TRANSFER`
  too, so it gets the same transfer-family icon; badge text distinguishes
  "External" from internal transfer (implementation detail, follow existing
  `SourceBadge` API).

### `src/lib/labels.ts`

- `TRANSACTION_TYPES`: add `"EXTERNAL_TRANSFER"` so it's filterable in
  `transaction-filters.tsx`.
- `TRANSACTION_TYPE_LABELS`: add the entry for completeness, even though the
  live UI reads labels from `dictionary.common.transactionTypeLabels`
  (confirmed this constant currently has no consumers — pre-existing, not
  touched further).

### `src/lib/i18n/en.ts` / `es.ts`

New strings needed: `common.transactionTypeLabels.EXTERNAL_TRANSFER`,
`transactions.externalTransferOut`, `transactions.externalTransferIn`,
`transactions.recordAsExternalTransfer`, `transactions.appliedExternalTransfer`,
plus the direction-toggle labels in the transaction dialog. Added to both
`en.ts` and `es.ts` in the same section, mirroring the existing key layout.

## CSV import review (the actual BSC fix)

`src/lib/import-grouping.ts`'s `isTransferShapedDescription()` and
`detectImportGroups()` are unchanged — detection stays "flag for review,
never decide," which is already correct and already excludes an
auto-selected destination account (fixed same-day in commit `31c84a2`).

`src/components/import/import-review.tsx`'s `GroupCard` gains a third action
for both transfer directions, alongside the existing two:

- **Outgoing group** ("Debito Por Transferencia"): `Review as internal
  transfer` | **`Record as external transfer`** (new) | `Leave as expense`
- **Incoming group** ("Transferencia Recibida"): `Review as internal
  transfer` | **`Record as external transfer`** (new) | `Mark as income`

"Record as external transfer" needs no dialog: the group already knows its
direction (`group.transferDirection`), so it's a one-click decision reusing
the existing `typeDecisions` channel (today only carries `"INCOME"` for
incoming groups; extended to also carry `"EXTERNAL_TRANSFER"` for both
directions). `resolved` in `GroupCard` is generalized from
`isIncomingTransfer ? typeDecision !== undefined : decision !== undefined` to
`group.kind === "transfer" ? (typeDecision !== undefined || decision !== undefined) : decision !== undefined`,
since outgoing groups can now resolve via either channel.

`src/components/import/csv-importer.tsx`: when building the payload, a row
whose group decision is `"EXTERNAL_TRANSFER"` gets `type: "EXTERNAL_TRANSFER"`
and `transferDirection` taken from `group.transferDirection` (already known —
`OUT` groups are outgoing, `IN` groups are incoming); `categoryId` forced to
`null` regardless of any "category for every row" default set in step 2.

`src/server/actions/import.ts`:

- `importPayloadSchema`: `type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"])`,
  add `transferDirection: z.enum(["OUT", "IN"]).nullable()`, refined to
  require non-null iff `type === "EXTERNAL_TRANSFER"`.
- `importTransactionsAction`: pass `transferDirection` through to
  `prisma.transaction.createMany`; skip `resolveImportCategoryId` entirely
  for `EXTERNAL_TRANSFER` rows (`categoryId: null` unconditionally).

### Submit-time guard (behavior change, explicitly approved)

Today, ignoring a "possible transfer" review card is silent: the row still
imports as plain EXPENSE/INCOME. Per your answer ("default to needs-review,
excluded until confirmed"), the batch **Import** button becomes disabled
while any detected transfer-shaped group is unresolved (no `decision` and no
`typeDecision` set for that group), with an inline hint: "Resolve N possible
transfer(s) before importing." Only transfer-shaped groups are gated —
ordinary expense/income rows (including unreviewed merchant groups and
"unknown" rows) import exactly as they do today, with no new blocking
behavior. This is a client-side submit guard in `csv-importer.tsx`, not a new
staged-review pipeline — Phase 2A's `StagedTransaction`/`PENDING` model
already exists for email ingestion and is not reused or extended here.

## Testing

No Jest/Vitest — `scripts/verify-domain.ts` against a scratch Postgres DB
(`DATABASE_URL=postgres://.../scratch_db npx tsx scripts/verify-domain.ts`)
is the only test harness, structured as `console.log` sections with
`check()`/`eq()` assertions. Extending existing sections:

- **transaction edit guard** (existing section, ~line 226): add
  `transactionEditBlock` cases for `EXTERNAL_TRANSFER` OUT and IN — both
  expect `null` (editable), unlike `TRANSFER`/`OPENING_BALANCE`.
- **database invariants** (existing section, ~line 241): add `balanceSign`
  cases for `EXTERNAL_TRANSFER` OUT (`-1`) and IN (`+1`); add `isCashflow("EXTERNAL_TRANSFER")`
  expecting `false`.
- **CSV import review: transfer direction** (existing subsection, ~line
  1987): add cases building the external-transfer payload row (type,
  direction, forced-null category) for both an outgoing and an incoming
  group, and a case confirming the submit-guard's "unresolved transfer
  groups" computation.
- **New end-to-end case reproducing the actual BSC numbers**: create a
  scratch account, insert `EXTERNAL_TRANSFER` OUT rows matching the real
  scenario (DOP 5,000 × several, 134,422 on 2026-04-16, 115,000 on
  2026-08-21), and assert: account balance reflects the full reduction via
  `getAccountBalances`; `getPeriodSummary` spend for the covering periods
  excludes them entirely; the rows remain individually editable
  (`transactionEditBlock` returns `null`); `getAccountLedger`'s `externalOut`
  total reflects them and `outflow` does not.
- Existing normal-expense, normal-income, internal-transfer, categorized-import,
  uncategorized-import, display-currency, and opening-balance sections are
  re-run unmodified to confirm no regression.

## Out of scope (flagged, not fixed)

- **Category-kind filtering gap**: the manual transaction form offers every
  category regardless of the selected type or the category's own
  `CategoryKind` (pre-existing, confirmed during investigation, unrelated to
  this task). Not touched beyond hiding the category field entirely for
  `EXTERNAL_TRANSFER`.
- **Phase 2A email ingestion** (`approveStagedAction`) hardcodes
  `type: "EXPENSE"` since every current source (Gmail/Outlook receipts) is
  expense-shaped by definition. Not extended to support `EXTERNAL_TRANSFER`
  — no current source could produce one. The type is available for that
  pipeline to opt into later with no further schema change.
- **No historical data migration.** This change only affects transactions
  created after it ships. Existing imported BSC-like rows (if any were
  already imported) are not reclassified as part of this task.
- **No BSC CSV import.** This task does not import the real BSC CSV into
  production or modify production financial data.
