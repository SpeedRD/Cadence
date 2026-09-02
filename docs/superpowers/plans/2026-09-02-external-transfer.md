# External Transfer Transaction Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth `TransactionType`, `EXTERNAL_TRANSFER`, so Cadence can correctly represent money that leaves (or arrives in) a tracked account without a Cadence-side counterparty — the real BSC "Debito Por Transferencia" case — without inventing a destination account, without counting it as income/spending, and without breaking the existing internal-transfer, budget, or ledger invariants.

**Architecture:** A single-row transaction type (no paired leg, `transferId` stays null) reusing the existing `transferDirection` enum (`OUT`/`IN`) to mean "money left/arrived at this account." It plugs into the existing `balanceSign()`/`isCashflow()` choke point exactly like `OPENING_BALANCE` did, so budgets/reports/period-summary need zero changes (they already query `type: {in: ["EXPENSE","INCOME"]}` directly). The CSV import reviewer gets a third action ("Record as external transfer") alongside today's two, and the batch Import button is gated until every detected transfer-shaped group is explicitly resolved.

**Tech Stack:** Next.js (App Router, Server Actions), Prisma 7 (Postgres), Zod, `scripts/verify-domain.ts` (the repo's only test harness — plain `check()`/`eq()` assertions against a real Postgres DB, no Jest/Vitest).

**Spec:** `docs/superpowers/specs/2026-09-02-external-transfer-design.md`

## Global Constraints

- Amounts are always stored positive; sign comes from `type` (+ `transferDirection`) via `balanceSign()` in `src/lib/transactions.ts` — never store a negative amount.
- `isCashflow()` in the same file is the single gate for "counts as income/spending" — every budget/report query already filters `type: {in: ["EXPENSE","INCOME"]}` directly, so a correctly-typed row is automatically excluded everywhere without touching those queries.
- `EXTERNAL_TRANSFER` rows must always have `transferId: null` (never paired) and `categoryId: null` (categories are `CategoryKind` EXPENSE/INCOME only — never invent one).
- Never auto-select a destination/source account for a transfer-shaped CSV row — the existing `buildTransferPrefill()` behavior (leaving the unknown side `""`, never falling back to `accounts[0]`) must not regress.
- No historical data is migrated, reclassified, or backfilled. No BSC CSV is imported into production. This plan only changes application behavior for transactions created after it ships.
- `scripts/verify-domain.ts` is the only test suite — it runs against `DATABASE_URL` (local dev Postgres, not production; see the "Cadence local dev environment" note below), creates its own fixtures, and must clean them up even on the happy path. New fixtures use the `Verify` name prefix, matching every existing fixture in the file.
- `saveTransactionAction`/`deleteTransactionAction` (`src/server/actions/transactions.ts`) are `"use server"` functions gated by `requireAuth()` (`next/headers` `cookies()`), which only works inside a real Next.js request — `scripts/verify-domain.ts` cannot call them directly. Task 4 instead exercises the exact same two steps those actions perform (validate via `transactionSchema`, then the identical `prisma.transaction.create`/`update`/`delete` calls) directly against the database, which covers every data invariant; the auth/redirect wrapper itself is covered by the manual QA checklist in Task 9.
- Run `DATABASE_URL="<local dev postgres>" npx tsx scripts/verify-domain.ts` after every task. All ~300 existing checks must still print `ok`; zero `FAIL` lines anywhere in the output, including the new ones you add.

---

## Task 1: Schema migration — add `EXTERNAL_TRANSFER`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260902193918_add_external_transfer_transaction_type/migration.sql`
- Test: inline in `scripts/verify-domain.ts` (new tiny section, see Step 5)

**Interfaces:**
- Produces: the Postgres enum value `EXTERNAL_TRANSFER` on `TransactionType`, and the regenerated Prisma Client type `TransactionType = "EXPENSE" | "INCOME" | "TRANSFER" | "OPENING_BALANCE" | "EXTERNAL_TRANSFER"` that every later task's TypeScript code depends on.

- [ ] **Step 1: Add the enum value to the Prisma schema**

In `prisma/schema.prisma`, change:

```prisma
enum TransactionType {
  EXPENSE
  INCOME
  TRANSFER
  OPENING_BALANCE
}
```

to:

```prisma
enum TransactionType {
  EXPENSE
  INCOME
  TRANSFER
  OPENING_BALANCE
  EXTERNAL_TRANSFER
}
```

Also update the `TransferDirection` doc comment just above it, since the field now has a second meaning:

```prisma
/// Which leg of a transfer a row is (OUT on the source leg, IN on the
/// destination leg), or, for an EXTERNAL_TRANSFER row (no paired leg), simply
/// whether money left (OUT) or arrived (IN). Null for every other type.
enum TransferDirection {
  OUT
  IN
}
```

- [ ] **Step 2: Write the migration file by hand**

Create `prisma/migrations/20260902193918_add_external_transfer_transaction_type/migration.sql` with exactly:

```sql
-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'EXTERNAL_TRANSFER';
```

This follows the exact precedent of `prisma/migrations/20260902032302_add_opening_balance_transaction_type/migration.sql` — adding one enum value, nothing else. It only adds a new allowed value; it cannot fail against existing data and touches no existing row.

- [ ] **Step 3: Apply the migration and regenerate the client**

```bash
npm run db:migrate
npx prisma generate
```

`db:migrate` runs `prisma migrate deploy`, which applies the new migration file against `DATABASE_URL`/`DIRECT_URL` (per `prisma7.config.ts`). `prisma generate` regenerates `src/generated/prisma` so TypeScript knows about the new enum value.

- [ ] **Step 4: Confirm the generated type includes the new value**

```bash
grep -n "EXTERNAL_TRANSFER" src/generated/prisma/enums.ts
```

Expected: a match inside the `TransactionType` export.

- [ ] **Step 5: Add a tiny DB-level smoke check to `scripts/verify-domain.ts`**

Add this new section right after the existing `console.log("\n== currency conversion through USD ==")` block and before `console.log("\n== database invariants ==")` (so it runs early, catching a migration problem before any later section depends on the enum value):

```ts
  console.log("\n== external transfer: schema ==");
  {
    const smokeAccount = await prisma.account.create({
      data: { name: "Verify Schema Smoke", currency: "USD", type: "CHECKING" },
    });
    const smokeRow = await prisma.transaction.create({
      data: {
        date: civilDate(2026, 8, 1),
        amount: 1,
        currency: "USD",
        type: "EXTERNAL_TRANSFER",
        transferDirection: "OUT",
        accountId: smokeAccount.id,
        source: "MANUAL",
      },
    });
    eq("Postgres accepts the EXTERNAL_TRANSFER enum value", smokeRow.type, "EXTERNAL_TRANSFER");
    await prisma.transaction.delete({ where: { id: smokeRow.id } });
    await prisma.account.delete({ where: { id: smokeAccount.id } });
  }
```

- [ ] **Step 6: Run the full suite and confirm the new check passes with zero regressions**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: `ok   Postgres accepts the EXTERNAL_TRANSFER enum value` appears, and the final line reads `All checks passed.` with no `FAIL` lines.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260902193918_add_external_transfer_transaction_type scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Add EXTERNAL_TRANSFER transaction type to the schema

Same shape as the existing OPENING_BALANCE precedent: a fourth
TransactionType that is neither income, expense, nor an internal
transfer. Enables representing money that leaves (or arrives in) a
tracked account with no Cadence-side counterparty, e.g. bank
"Debito Por Transferencia" rows to accounts outside Cadence.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 2: Domain logic — `balanceSign` and edit-guard coverage

**Files:**
- Modify: `src/lib/transactions.ts`
- Test: `scripts/verify-domain.ts`

**Interfaces:**
- Consumes: `TransactionType` including `"EXTERNAL_TRANSFER"` (Task 1).
- Produces: `balanceSign(type: string, transferDirection: string | null | undefined): number` returning `-1`/`+1` for `EXTERNAL_TRANSFER` by direction; `isCashflow(type: string): boolean` unchanged (still `false` for `EXTERNAL_TRANSFER`, no code change needed); `transactionEditBlock(row): TransactionEditBlock` unchanged (still `null`/editable for `EXTERNAL_TRANSFER`, no code change needed — it only blocks on `transferId` or `OPENING_BALANCE`).

- [ ] **Step 1: Add failing checks to `scripts/verify-domain.ts`**

In the existing `"\n== transaction edit guard =="` section (currently lines ~226-231), add two lines right after the existing `eq(...)` calls, and widen the existing dynamic import to also pull in `balanceSign`/`isCashflow`:

```ts
  console.log("\n== transaction edit guard ==");
  const { transactionEditBlock, balanceSign, isCashflow } = await import("../src/lib/transactions");
  eq("an opening balance can't be edited through the transaction form", transactionEditBlock({ type: "OPENING_BALANCE", transferId: null }), "opening_balance");
  eq("a transfer leg can't be edited through the transaction form", transactionEditBlock({ type: "TRANSFER", transferId: "t1" }), "transfer");
  eq("an ordinary expense can be edited", transactionEditBlock({ type: "EXPENSE", transferId: null }), null);
  eq("an ordinary income can be edited", transactionEditBlock({ type: "INCOME", transferId: null }), null);
  eq("an outgoing external transfer can be edited (single row, never paired)", transactionEditBlock({ type: "EXTERNAL_TRANSFER", transferId: null }), null);
  eq("an incoming external transfer can be edited (single row, never paired)", transactionEditBlock({ type: "EXTERNAL_TRANSFER", transferId: null }), null);
  eq("balanceSign(EXTERNAL_TRANSFER, OUT) is -1, same shape as an outgoing internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "OUT"), -1);
  eq("balanceSign(EXTERNAL_TRANSFER, IN) is +1, same shape as an incoming internal transfer leg", balanceSign("EXTERNAL_TRANSFER", "IN"), 1);
  eq("isCashflow(EXTERNAL_TRANSFER) is false - it never counts as income or spending", isCashflow("EXTERNAL_TRANSFER"), false);
```

(The later `"\n== database invariants =="` section already does `const { getAccountBalances } = await import(...)` etc. separately — this change only touches the edit-guard section's own import line and the new `eq()` calls after it.)

- [ ] **Step 2: Run and confirm the new `balanceSign`/`isCashflow` checks fail**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: `FAIL balanceSign(EXTERNAL_TRANSFER, OUT) is -1...` and the `IN` case (both currently return `0`, since `balanceSign` has no `EXTERNAL_TRANSFER` branch yet). The `isCashflow` and `transactionEditBlock` checks already pass (no code change needed for those two).

- [ ] **Step 3: Implement `balanceSign`**

In `src/lib/transactions.ts`:

```ts
/**
 * Sign convention: amounts are always stored positive and the row's type
 * decides the direction. Transfers move value between two of the user's own
 * accounts, so they affect balances but are never income or spending. An
 * opening balance raises the ledger balance like income but is excluded from
 * isCashflow, so it never counts as income, spending, or budget activity. An
 * external transfer moves value out of (or into) a tracked account with no
 * Cadence-side counterparty - it affects the balance exactly like a transfer
 * leg, using the same OUT/IN direction convention, but is a single row (no
 * paired leg) and is likewise excluded from isCashflow.
 */
export function balanceSign(
  type: string,
  transferDirection: string | null | undefined,
): number {
  if (type === "INCOME") return 1;
  if (type === "EXPENSE") return -1;
  if (type === "TRANSFER") return transferDirection === "IN" ? 1 : -1;
  if (type === "OPENING_BALANCE") return 1;
  if (type === "EXTERNAL_TRANSFER") return transferDirection === "IN" ? 1 : -1;
  return 0;
}
```

`isCashflow` and `transactionEditBlock` need no changes — leave them as-is.

- [ ] **Step 4: Run and confirm all checks pass**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: every new `eq()`/`check()` from Step 1 prints `ok`, `All checks passed.`, zero `FAIL` lines.

- [ ] **Step 5: Commit**

```bash
git add src/lib/transactions.ts scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Give EXTERNAL_TRANSFER rows a balance sign

balanceSign() now treats EXTERNAL_TRANSFER the same as a TRANSFER
leg (direction-based sign). isCashflow() and transactionEditBlock()
needed no changes - they already default to excluding/allowing
unrecognized-as-cashflow types correctly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 3: Validation schema — `transactionSchema`

**Files:**
- Modify: `src/lib/validation.ts`
- Test: `scripts/verify-domain.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (pure Zod, no Prisma).
- Produces: `transactionSchema` now parses `type: "EXPENSE" | "INCOME" | "EXTERNAL_TRANSFER"` and an optional `transferDirection` field. Parsed output shape: `{ ..., type, categoryId: string | null, transferDirection: "OUT" | "IN" | null }` where `categoryId` is always `null` when `type === "EXTERNAL_TRANSFER"` and `transferDirection` is always `null` when `type !== "EXTERNAL_TRANSFER"` (both regardless of what was submitted). Every later task that builds a `saveTransactionAction`/`saveTransactionAction`-equivalent payload relies on this normalization.

- [ ] **Step 1: Add failing pure-validation checks to `scripts/verify-domain.ts`**

Add a new subsection right after the existing amount-parsing block that already does `const { transactionSchema } = await import("../src/lib/validation");` (the block ending around the "the decimal-places message is translated to Spanish" check, just before `console.log("\n== transaction edit guard ==")`):

```ts
  console.log("\n-- transactionSchema: EXTERNAL_TRANSFER invariants --");
  {
    const base = { date: "2026-08-20", currency: "DOP", accountId: "acct", note: "" };

    const missingDirection = transactionSchema.safeParse({
      ...base, amount: "100", type: "EXTERNAL_TRANSFER", categoryId: "",
    });
    check("EXTERNAL_TRANSFER without a direction is rejected", !missingDirection.success);

    const outParsed = transactionSchema.safeParse({
      ...base, amount: "5000", type: "EXTERNAL_TRANSFER", categoryId: "some-category-id", transferDirection: "OUT",
    });
    check("EXTERNAL_TRANSFER with an OUT direction validates", outParsed.success);
    eq(
      "categoryId is forced null even though one was submitted",
      outParsed.success ? outParsed.data.categoryId : "n/a",
      null,
    );
    eq(
      "transferDirection OUT survives validation",
      outParsed.success ? outParsed.data.transferDirection : "n/a",
      "OUT",
    );

    const inParsed = transactionSchema.safeParse({
      ...base, amount: "2000", type: "EXTERNAL_TRANSFER", categoryId: "", transferDirection: "IN",
    });
    check("EXTERNAL_TRANSFER with an IN direction validates", inParsed.success);
    eq(
      "transferDirection IN survives validation",
      inParsed.success ? inParsed.data.transferDirection : "n/a",
      "IN",
    );

    const garbageDirection = transactionSchema.safeParse({
      ...base, amount: "100", type: "EXTERNAL_TRANSFER", categoryId: "", transferDirection: "SIDEWAYS",
    });
    check("an unrecognized transferDirection value is rejected for EXTERNAL_TRANSFER", !garbageDirection.success);

    const expenseWithStaleDirection = transactionSchema.safeParse({
      ...base, amount: "50", type: "EXPENSE", categoryId: "", transferDirection: "OUT",
    });
    check("an ordinary EXPENSE still validates even if transferDirection is present", expenseWithStaleDirection.success);
    eq(
      "a stale transferDirection is dropped for a non-EXTERNAL_TRANSFER type",
      expenseWithStaleDirection.success ? expenseWithStaleDirection.data.transferDirection : "n/a",
      null,
    );

    const incomeNoDirection = transactionSchema.safeParse({
      ...base, amount: "50", type: "INCOME", categoryId: "",
    });
    check("an ordinary INCOME with no transferDirection field at all still validates", incomeNoDirection.success);
  }
```

- [ ] **Step 2: Run and confirm these new checks fail**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: every check in this new subsection fails — `transactionSchema`'s `type` enum doesn't accept `"EXTERNAL_TRANSFER"` yet, so every `safeParse` above returns `success: false` for reasons unrelated to direction, and the two "still validates" checks (`expenseWithStaleDirection`, `incomeNoDirection`) also fail because `transferDirection` isn't a recognized field yet (extra keys are fine under default Zod behavior, so those two might already pass by accident — don't rely on that; the direction-specific checks are the ones that must fail here).

- [ ] **Step 3: Implement the schema change**

In `src/lib/validation.ts`, replace:

```ts
export const transactionSchema = z.object({
  id: z.string().trim().optional(),
  date: isoDate,
  amount: positiveAmount,
  currency,
  type: z.enum(["EXPENSE", "INCOME"]),
  accountId: z.string().trim().min(1, "Pick an account"),
  categoryId: optionalId,
  note: optionalText,
});
```

with:

```ts
export const transactionSchema = z
  .object({
    id: z.string().trim().optional(),
    date: isoDate,
    amount: positiveAmount,
    currency,
    type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
    accountId: z.string().trim().min(1, "Pick an account"),
    categoryId: optionalId,
    note: optionalText,
    /** OUT/IN direction for an EXTERNAL_TRANSFER row - no paired leg, so this
     *  is the only place the direction is recorded. Absent/empty for every
     *  other type; normalized to null below regardless of what was
     *  submitted, so a stale value left over from switching the type field
     *  back to EXPENSE/INCOME in the form never survives into the database. */
    transferDirection: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === "OUT" || value === "IN" ? value : null)),
  })
  .transform((value, ctx) => {
    if (value.type === "EXTERNAL_TRANSFER") {
      if (value.transferDirection === null) {
        ctx.addIssue({
          code: "custom",
          message: "Pick a direction",
          path: ["transferDirection"],
        });
        return z.NEVER;
      }
      return { ...value, categoryId: null };
    }
    return { ...value, transferDirection: null };
  });
```

Add the matching Spanish message to `VALIDATION_MESSAGES_ES`:

```ts
  "Pick a direction": "Elige una dirección",
```

- [ ] **Step 4: Run and confirm all checks pass**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: every check from Step 1 passes, plus all pre-existing `transactionSchema` checks (the comma-decimal/dot-decimal/three-decimals/zero-amount ones just above) still pass unchanged - confirming the `.transform()` wrapping didn't break the base field validation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation.ts scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Validate EXTERNAL_TRANSFER transactions in transactionSchema

Requires a transferDirection (OUT/IN) when type is
EXTERNAL_TRANSFER, and normalizes categoryId to null for that type
and transferDirection to null for every other type - regardless of
what the client submits - so a stale field value from a prior type
selection in the form can never reach the database.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 4: Manual create/update/delete invariants

This is the task the user explicitly asked to see covered end-to-end. `saveTransactionAction`/`deleteTransactionAction` (`src/server/actions/transactions.ts`) need **no code changes** — they already do `const { id, ...values } = parsed.data; prisma.transaction.create({ data: { ...values, source: "MANUAL" } })` / `update({ data: values })`, and since `values` now includes the correctly-normalized `transferDirection`/`categoryId` from Task 3's schema, every invariant below already holds. This task proves it with real database assertions, replicating the action's exact two-step logic (validate, then the identical Prisma calls) since the action itself can't run outside a Next.js request (see Global Constraints).

**Files:**
- Test: `scripts/verify-domain.ts` (no production code changes in this task)

**Interfaces:**
- Consumes: `transactionSchema` (Task 3), `balanceSign`/`transactionEditBlock` (Task 2), `getAccountBalances` (existing, `src/lib/data/accounts.ts`).

- [ ] **Step 1: Add the new section to `scripts/verify-domain.ts`**

Add this as its own top-level section, placed after `console.log("\n== database invariants ==")`'s block ends (i.e. after the existing goal/budget checks in that section, before `console.log("\n== the display currency drives goal and budget presentation ==")`):

```ts
  console.log("\n== external transfer: manual create/update/delete invariants ==");
  {
    // saveTransactionAction/deleteTransactionAction are "use server" actions
    // gated by requireAuth() (next/headers cookies()), which only works
    // inside a real Next.js request - this script can't call them directly.
    // Every check below instead exercises the exact same two steps those
    // actions perform - validate via transactionSchema, then the identical
    // prisma.transaction calls - so each assertion is a real database
    // assertion, just without the auth/redirect wrapper (covered by manual
    // QA instead - see the plan's final task).
    const extAccount = await prisma.account.create({
      data: { name: "Verify External Transfer", currency: "DOP", type: "CHECKING" },
    });
    const otherAccount = await prisma.account.create({
      data: { name: "Verify External Transfer Other", currency: "DOP", type: "CHECKING" },
    });
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
    const incomeCat = await prisma.category.findFirstOrThrow({ where: { name: "Income" } });

    const extContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: civilDate(2026, 8, 20),
      currentPeriod: periodForDate(civilDate(2026, 8, 20)),
    };
    const balanceOf = async (accountId: string) => {
      const balances = await getAccountBalances(extContext, { status: "ALL" });
      return balances.find((a) => a.id === accountId)?.balance ?? 0;
    };

    // -- create: EXTERNAL_TRANSFER OUT, categoryId forced null even if submitted --
    const createOutParsed = transactionSchema.safeParse({
      date: "2026-08-20",
      amount: "5000",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: groceriesCat.id, // deliberately submitted - must be dropped
      note: "Sent to Mom",
      transferDirection: "OUT",
    });
    check("create: EXTERNAL_TRANSFER OUT validates", createOutParsed.success);
    if (!createOutParsed.success) throw new Error("fixture setup failed: createOutParsed");
    eq("create: categoryId is forced null even though one was submitted", createOutParsed.data.categoryId, null);
    eq("create: transferDirection OUT survives validation", createOutParsed.data.transferDirection, "OUT");

    const { id: _createOutId, ...outValues } = createOutParsed.data;
    const outRow = await prisma.transaction.create({ data: { ...outValues, source: "MANUAL" } });
    eq("create: transferId stays null - never paired like an internal transfer", outRow.transferId, null);
    eq("create: type is EXTERNAL_TRANSFER", outRow.type, "EXTERNAL_TRANSFER");
    eq("create: categoryId is null in the database", outRow.categoryId, null);
    eq("create: transactionEditBlock allows editing it (unlike a TRANSFER leg)", transactionEditBlock(outRow), null);
    eq("create: account balance drops by the full amount", await balanceOf(extAccount.id), -5000);

    // -- create: EXTERNAL_TRANSFER IN --
    const createInParsed = transactionSchema.safeParse({
      date: "2026-08-21",
      amount: "2000",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: "",
      note: "Dad's pass-through funds",
      transferDirection: "IN",
    });
    check("create: EXTERNAL_TRANSFER IN validates", createInParsed.success);
    if (!createInParsed.success) throw new Error("fixture setup failed: createInParsed");
    const { id: _createInId, ...inValues } = createInParsed.data;
    const inRow = await prisma.transaction.create({ data: { ...inValues, source: "MANUAL" } });
    eq("create: account balance reflects both rows (-5000 + 2000)", await balanceOf(extAccount.id), -3000);

    // -- update: EXPENSE -> EXTERNAL_TRANSFER clears category, sets direction --
    const expenseRow = await prisma.transaction.create({
      data: { date: civilDate(2026, 8, 22), amount: 300, currency: "DOP", type: "EXPENSE", accountId: extAccount.id, categoryId: groceriesCat.id, source: "MANUAL" },
    });
    const toExternalParsed = transactionSchema.safeParse({
      id: expenseRow.id,
      date: "2026-08-22",
      amount: "300",
      currency: "DOP",
      type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id,
      categoryId: groceriesCat.id, // still submitted by a form that hasn't cleared its own field yet
      note: "Actually a pass-through",
      transferDirection: "OUT",
    });
    check("update EXPENSE->EXTERNAL_TRANSFER validates", toExternalParsed.success);
    if (!toExternalParsed.success) throw new Error("fixture setup failed: toExternalParsed");
    const { id: updateId1, ...toExternalValues } = toExternalParsed.data;
    await prisma.transaction.update({ where: { id: updateId1! }, data: toExternalValues });
    const afterToExternal = await prisma.transaction.findUniqueOrThrow({ where: { id: expenseRow.id } });
    eq("update EXPENSE->EXTERNAL_TRANSFER: categoryId clears to null", afterToExternal.categoryId, null);
    eq("update EXPENSE->EXTERNAL_TRANSFER: transferDirection is set", afterToExternal.transferDirection, "OUT");
    eq("update EXPENSE->EXTERNAL_TRANSFER: transferId remains null", afterToExternal.transferId, null);
    eq("update EXPENSE->EXTERNAL_TRANSFER: still editable", transactionEditBlock(afterToExternal), null);

    // -- update: EXTERNAL_TRANSFER -> INCOME clears direction, category settable again --
    const backToIncomeParsed = transactionSchema.safeParse({
      id: expenseRow.id,
      date: "2026-08-22",
      amount: "300",
      currency: "DOP",
      type: "INCOME",
      accountId: extAccount.id,
      categoryId: incomeCat.id,
      note: "Turned out to be real income",
      transferDirection: "OUT", // stale client state from before switching the type back - must be dropped
    });
    check("update EXTERNAL_TRANSFER->INCOME validates", backToIncomeParsed.success);
    if (!backToIncomeParsed.success) throw new Error("fixture setup failed: backToIncomeParsed");
    eq("update EXTERNAL_TRANSFER->INCOME: stale transferDirection is dropped by validation", backToIncomeParsed.data.transferDirection, null);
    const { id: updateId2, ...backToIncomeValues } = backToIncomeParsed.data;
    await prisma.transaction.update({ where: { id: updateId2! }, data: backToIncomeValues });
    const afterBackToIncome = await prisma.transaction.findUniqueOrThrow({ where: { id: expenseRow.id } });
    eq("update EXTERNAL_TRANSFER->INCOME: transferDirection clears to null in the database", afterBackToIncome.transferDirection, null);
    eq("update EXTERNAL_TRANSFER->INCOME: categoryId is settable again", afterBackToIncome.categoryId, incomeCat.id);
    eq("update EXTERNAL_TRANSFER->INCOME: transferId still null", afterBackToIncome.transferId, null);

    // -- update: direction change OUT -> IN on an existing EXTERNAL_TRANSFER row --
    const balanceBeforeFlip = await balanceOf(extAccount.id);
    const flipParsed = transactionSchema.safeParse({
      id: outRow.id, date: "2026-08-20", amount: "5000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Sent to Mom", transferDirection: "IN",
    });
    check("update: flipping EXTERNAL_TRANSFER direction validates", flipParsed.success);
    if (!flipParsed.success) throw new Error("fixture setup failed: flipParsed");
    const { id: flipId, ...flipValues } = flipParsed.data;
    await prisma.transaction.update({ where: { id: flipId! }, data: flipValues });
    const balanceAfterFlip = await balanceOf(extAccount.id);
    eq(
      "update: flipping OUT->IN on a 5000 row moves the balance by 10000 (removes the -5000 effect, adds +5000)",
      round2(balanceAfterFlip - balanceBeforeFlip),
      10000,
    );

    // flip it back OUT so the rest of this block's balance math stays predictable
    const flipBackParsed = transactionSchema.safeParse({
      id: outRow.id, date: "2026-08-20", amount: "5000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Sent to Mom", transferDirection: "OUT",
    });
    if (flipBackParsed.success) {
      const { id: flipBackId, ...flipBackValues } = flipBackParsed.data;
      await prisma.transaction.update({ where: { id: flipBackId! }, data: flipBackValues });
    }

    // -- update: reassigning accountId moves the effect to the new account --
    const balanceOldBefore = await balanceOf(extAccount.id);
    const balanceNewBefore = await balanceOf(otherAccount.id);
    const reassignParsed = transactionSchema.safeParse({
      id: inRow.id, date: "2026-08-21", amount: "2000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: otherAccount.id, categoryId: "", note: "Dad's pass-through funds", transferDirection: "IN",
    });
    check("update: reassigning accountId validates", reassignParsed.success);
    if (!reassignParsed.success) throw new Error("fixture setup failed: reassignParsed");
    const { id: reassignId, ...reassignValues } = reassignParsed.data;
    await prisma.transaction.update({ where: { id: reassignId! }, data: reassignValues });
    eq("update: old account balance drops by the reassigned row's effect", round2((await balanceOf(extAccount.id)) - balanceOldBefore), -2000);
    eq("update: new account balance picks up the reassigned row's effect", round2((await balanceOf(otherAccount.id)) - balanceNewBefore), 2000);

    // move it back so the delete check below only has to look in one place
    const moveBackParsed = transactionSchema.safeParse({
      id: inRow.id, date: "2026-08-21", amount: "2000", currency: "DOP", type: "EXTERNAL_TRANSFER",
      accountId: extAccount.id, categoryId: "", note: "Dad's pass-through funds", transferDirection: "IN",
    });
    if (moveBackParsed.success) {
      const { id: moveBackId, ...moveBackValues } = moveBackParsed.data;
      await prisma.transaction.update({ where: { id: moveBackId! }, data: moveBackValues });
    }

    // -- delete: an EXTERNAL_TRANSFER row is a single row, never a paired delete --
    const beforeDeleteCount = await prisma.transaction.count({ where: { accountId: extAccount.id } });
    const balanceBeforeDelete = await balanceOf(extAccount.id);
    const toDelete = await prisma.transaction.findUniqueOrThrow({ where: { id: outRow.id } });
    // Mirrors deleteTransactionAction exactly: transferId is null, so it
    // takes the single-row `else` branch, never the multi-row
    // `deleteMany({ transferId })` branch used for internal transfer legs.
    if (toDelete.transferId) {
      await prisma.transaction.deleteMany({ where: { transferId: toDelete.transferId } });
    } else {
      await prisma.transaction.delete({ where: { id: toDelete.id } });
    }
    const afterDeleteCount = await prisma.transaction.count({ where: { accountId: extAccount.id } });
    eq("delete: exactly one row is removed, not a paired transfer delete", beforeDeleteCount - afterDeleteCount, 1);
    const stillThere = await prisma.transaction.findUnique({ where: { id: inRow.id } });
    check("delete: the other EXTERNAL_TRANSFER row on the same account is untouched", stillThere !== null);
    eq(
      "delete: deleting the 5000 OUT row raises the account balance by exactly 5000",
      round2((await balanceOf(extAccount.id)) - balanceBeforeDelete),
      5000,
    );

    await prisma.transaction.deleteMany({ where: { accountId: { in: [extAccount.id, otherAccount.id] } } });
    await prisma.account.deleteMany({ where: { id: { in: [extAccount.id, otherAccount.id] } } });
    console.log("  ok   external transfer manual CRUD fixtures removed");
  }
```

- [ ] **Step 2: Run and confirm every check passes**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: all new checks print `ok` (no red/green cycle here in the usual sense - Tasks 2/3 already implemented everything this task needs; this task is pure verification that the combination works end-to-end). If anything fails, it points at a gap in Task 2 or 3, not new code to write here.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Cover EXTERNAL_TRANSFER manual create/update/delete invariants

Exercises every transition explicitly: create (both directions),
EXPENSE<->EXTERNAL_TRANSFER<->INCOME type transitions (categoryId
clears/becomes settable, transferDirection sets/clears, transferId
always stays null), direction flips, account reassignment, and
single-row (never paired) deletion - replicating exactly what
saveTransactionAction/deleteTransactionAction do, since those "use
server" actions require a real Next.js request to invoke directly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 5: Manual entry UI — `TransactionDialog`

**Files:**
- Modify: `src/components/form/selects.tsx` (add `onValueChange` to `EnumSelect`)
- Modify: `src/components/transactions/transaction-dialog.tsx`
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts`

**Interfaces:**
- Consumes: `transactionSchema` (Task 3, via `saveTransactionAction` unchanged).
- Produces: `TransactionFormValues` gains `transferDirection?: string | null`. `EnumSelect` gains an optional `onValueChange?: (value: string) => void` prop, backward-compatible with every existing caller.

- [ ] **Step 1: Add `onValueChange` to `EnumSelect`**

In `src/components/form/selects.tsx`:

```tsx
export function EnumSelect({
  id,
  name,
  options,
  labels,
  defaultValue,
  placeholder,
  onValueChange,
}: {
  id?: string;
  name: string;
  options: readonly string[];
  labels: Record<string, string>;
  defaultValue?: string;
  placeholder?: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <Select name={name} defaultValue={defaultValue} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option] ?? option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 2: Add i18n strings**

In `src/lib/i18n/en.ts`, `common.transactionTypeLabels`:

```ts
    transactionTypeLabels: {
      EXPENSE: "Expense",
      INCOME: "Income",
      TRANSFER: "Transfer",
      OPENING_BALANCE: "Opening balance",
      EXTERNAL_TRANSFER: "External transfer",
    } as Record<string, string>,
```

In `src/lib/i18n/en.ts`, inside the `transactions` section, right after `notePlaceholder`:

```ts
    notePlaceholder: "What was it for?",
    direction: "Direction",
    directionOut: "Outgoing - money left this account",
    directionIn: "Incoming - money arrived, to be forwarded",
```

Mirror in `src/lib/i18n/es.ts`, `common.transactionTypeLabels`:

```ts
    transactionTypeLabels: {
      EXPENSE: "Gasto",
      INCOME: "Ingreso",
      TRANSFER: "Transferencia",
      OPENING_BALANCE: "Saldo inicial",
      EXTERNAL_TRANSFER: "Transferencia externa",
    } as Record<string, string>,
```

And in `es.ts`'s `transactions` section, right after `notePlaceholder`:

```ts
    notePlaceholder: "¿Para qué fue?",
    direction: "Dirección",
    directionOut: "Saliente - el dinero salió de esta cuenta",
    directionIn: "Entrante - el dinero llegó, para reenviarlo",
```

- [ ] **Step 3: Update `TransactionDialog`**

In `src/components/transactions/transaction-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";

import { FormDialog } from "@/components/form/form-dialog";
import { Field } from "@/components/form/field";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  type Option,
} from "@/components/form/selects";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getDictionary, type Locale } from "@/lib/i18n";
import { saveTransactionAction } from "@/server/actions/transactions";

export interface TransactionFormValues {
  id?: string;
  date: string;
  amount?: number;
  currency?: string;
  type?: string;
  accountId?: string;
  categoryId?: string | null;
  note?: string | null;
  transferDirection?: string | null;
}

export function TransactionDialog({
  accounts,
  categories,
  values,
  trigger,
  open,
  onOpenChange,
  locale,
}: {
  accounts: Option[];
  categories: Option[];
  values: TransactionFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const editing = Boolean(values.id);
  const [type, setType] = useState(values.type ?? "EXPENSE");
  const isExternalTransfer = type === "EXTERNAL_TRANSFER";

  return (
    <FormDialog
      title={editing ? t.editTransaction : t.newTransaction}
      description={
        editing ? undefined : t.manualDescription
      }
      action={saveTransactionAction}
      submitLabel={editing ? t.saveChanges : t.addTransaction}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.transactionUpdated : t.transactionAdded}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.type} htmlFor="transaction-type">
          <EnumSelect
            id="transaction-type"
            name="type"
            options={["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]}
            labels={common.transactionTypeLabels}
            defaultValue={values.type ?? "EXPENSE"}
            onValueChange={setType}
          />
        </Field>
        <Field label={common.date} htmlFor="transaction-date">
          <Input
            id="transaction-date"
            type="date"
            name="date"
            defaultValue={values.date}
            required
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={common.amount} htmlFor="transaction-amount">
          <Input
            id="transaction-amount"
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            className="font-mono"
            defaultValue={values.amount ?? ""}
            required
          />
        </Field>
        <Field label={common.currency} htmlFor="transaction-currency">
          <CurrencySelect id="transaction-currency" name="currency" defaultValue={values.currency} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.account} htmlFor="transaction-account">
          <AccountSelect
            id="transaction-account"
            name="accountId"
            accounts={accounts}
            defaultValue={values.accountId ?? accounts[0]?.id}
            common={common}
          />
        </Field>
        {isExternalTransfer ? (
          <Field label={t.direction} htmlFor="transaction-direction">
            <EnumSelect
              id="transaction-direction"
              name="transferDirection"
              options={["OUT", "IN"]}
              labels={{ OUT: t.directionOut, IN: t.directionIn }}
              defaultValue={values.transferDirection ?? "OUT"}
            />
          </Field>
        ) : (
          <Field label={common.category} htmlFor="transaction-category">
            <CategorySelect
              id="transaction-category"
              name="categoryId"
              categories={categories}
              defaultValue={values.categoryId ?? "none"}
              common={common}
            />
          </Field>
        )}
      </div>

      {/* categoryId is always submitted, even when the category field is
          hidden for EXTERNAL_TRANSFER - transactionSchema forces it to null
          for that type either way, but the field must still be present in
          the FormData or validation rejects the row as missing categoryId. */}
      {isExternalTransfer ? <input type="hidden" name="categoryId" value="none" /> : null}

      <Field label={common.note} htmlFor="transaction-note">
        <Textarea
          id="transaction-note"
          name="note"
          rows={2}
          placeholder={t.notePlaceholder}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
```

- [ ] **Step 4: Manual UI check (no automated test - see Task 9 for the full checklist)**

```bash
npm run dev
```

Open the transaction dialog (New transaction), select "External transfer" as the type, confirm the category field is replaced by a Direction field (Outgoing/Incoming) and the amount/date/account/note fields are unchanged. Switch back to Expense and confirm the category field returns.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/form/selects.tsx src/components/transactions/transaction-dialog.tsx src/lib/i18n/en.ts src/lib/i18n/es.ts
git commit -m "$(cat <<'EOF'
Add External transfer to the manual transaction dialog

Selecting External transfer swaps the category field for a
direction picker (Outgoing/Incoming) instead of hiding it outright -
categoryId is still submitted via a hidden "none" input so
transactionSchema's non-optional categoryId field always has a
value, and the schema itself forces it to null server-side either
way.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 6: Account ledger totals + BSC end-to-end scenario

**Files:**
- Modify: `src/lib/data/accounts.ts`
- Modify: `src/app/(app)/accounts/[id]/page.tsx`
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts`
- Test: `scripts/verify-domain.ts`

**Interfaces:**
- Consumes: `balanceSign` (Task 2), `getAccountBalances`/`getPeriodSummary` (existing, unchanged).
- Produces: `getAccountLedger()`'s `totals` object gains `externalIn: number` and `externalOut: number` alongside the existing four fields. Every caller of `getAccountLedger` (currently only the account detail page) must be updated to not break on the wider return type — there's exactly one caller.

- [ ] **Step 1: Add failing checks to `scripts/verify-domain.ts` — the real BSC scenario**

Add this as a new top-level section, placed right after Task 4's `"== external transfer: manual create/update/delete invariants =="` block:

```ts
  console.log("\n== external transfer: BSC import scenario ==");
  {
    // Reproduces the real production-data edge case this feature exists for:
    // a BSC bank CSV account with "Debito Por Transferencia" rows that are
    // NOT internal Cadence transfers (the destination is outside Cadence
    // entirely) and must not inflate spending. Amounts match the actual BSC
    // CSV cited in the task: several DOP 5,000 rows plus two large ones
    // (134,422 and 115,000).
    const bsc = await prisma.account.create({
      data: { name: "Verify BSC", currency: "DOP", type: "CHECKING" },
    });
    const bscContext = {
      displayCurrency: "USD" as const,
      language: "en" as const,
      rates,
      today: civilDate(2026, 8, 20),
      currentPeriod: periodForDate(civilDate(2026, 8, 20)),
    };

    const bscExternalRows = [
      { date: civilDate(2026, 4, 16), amount: 134422, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 5, 3), amount: 5000, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 6, 12), amount: 5000, note: "Debito Por Transferencia" },
      { date: civilDate(2026, 8, 21), amount: 115000, note: "Debito Por Transferencia" },
    ];
    // A real, unrelated expense in the same account/period, to prove it's
    // still counted normally once the external-transfer rows are excluded.
    const realExpense = { date: civilDate(2026, 8, 18), amount: 1200, note: "Supermercado Nacional" };

    // Mirrors exactly what importTransactionsAction writes for a row whose
    // CSV-review decision was "Record as external transfer": categoryId
    // null, transferDirection carried through, source CSV.
    await prisma.transaction.createMany({
      data: bscExternalRows.map((row) => ({
        date: row.date,
        amount: row.amount,
        currency: "DOP",
        type: "EXTERNAL_TRANSFER" as const,
        transferDirection: "OUT" as const,
        accountId: bsc.id,
        categoryId: null,
        note: row.note,
        source: "CSV" as const,
      })),
    });
    const groceriesForBsc = await prisma.category.findFirstOrThrow({ where: { name: "Groceries" } });
    await prisma.transaction.create({
      data: {
        date: realExpense.date,
        amount: realExpense.amount,
        currency: "DOP",
        type: "EXPENSE",
        accountId: bsc.id,
        categoryId: groceriesForBsc.id,
        note: realExpense.note,
        source: "CSV",
      },
    });

    const bscBalances = await getAccountBalances(bscContext, { status: "ALL" });
    const bscBalance = bscBalances.find((a) => a.id === bsc.id)!;
    const totalExternal = bscExternalRows.reduce((sum, row) => sum + row.amount, 0);
    eq(
      "BSC account balance reflects the full reduction from every external-transfer row plus the real expense",
      bscBalance.balance,
      -(totalExternal + realExpense.amount),
    );

    const { getPeriodSummary } = await import("../src/lib/data/period-summary");
    const augPeriodB = periodForDate(civilDate(2026, 8, 20));
    const augSummary = await getPeriodSummary(augPeriodB, bscContext);
    eq(
      "period spend for the covering period counts only the real expense, not the 115,000 external transfer landing in the same period",
      augSummary.spent,
      1200,
    );

    const { getAccountLedger } = await import("../src/lib/data/accounts");
    const bscLedger = await getAccountLedger(bsc.id, bscContext);
    eq("ledger externalOut totals every external-transfer row", bscLedger!.totals.externalOut, totalExternal);
    eq("ledger outflow only counts the real expense, not the external transfers", bscLedger!.totals.outflow, 1200);

    const anyExternalRow = await prisma.transaction.findFirstOrThrow({ where: { accountId: bsc.id, type: "EXTERNAL_TRANSFER" } });
    eq("each external-transfer row remains individually editable", transactionEditBlock(anyExternalRow), null);
    eq("each external-transfer row is still a single row, never paired", anyExternalRow.transferId, null);

    await prisma.transaction.deleteMany({ where: { accountId: bsc.id } });
    await prisma.account.delete({ where: { id: bsc.id } });
    console.log("  ok   BSC scenario fixtures removed");
  }
```

- [ ] **Step 2: Run and confirm the new checks fail**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: the `bscLedger!.totals.externalOut`/`externalIn` checks fail (TypeScript will actually refuse to compile until `totals` has those fields, since this is all one script — expect a compile error naming `externalOut`, not a graceful `FAIL` line). The balance and period-summary checks should already pass, since Tasks 2-4 already made `balanceSign`/`isCashflow` correct.

- [ ] **Step 3: Implement `getAccountLedger`'s external totals**

In `src/lib/data/accounts.ts`, after the existing `transfersOut` computation and before the `return`:

```ts
  const externalIn = rows
    .filter((row) => row.type === "EXTERNAL_TRANSFER" && row.effect > 0)
    .reduce((total, row) => total + row.effect, 0);
  const externalOut = rows
    .filter((row) => row.type === "EXTERNAL_TRANSFER" && row.effect < 0)
    .reduce((total, row) => total + Math.abs(row.effect), 0);

  return {
    account,
    rows: rows.reverse(),
    balance: round2(running),
    displayBalance: round2(
      convert(running, account.currency, context.displayCurrency, context.rates),
    ),
    totals: {
      inflow: round2(inflow),
      outflow: round2(outflow),
      transfersIn: round2(transfersIn),
      transfersOut: round2(transfersOut),
      externalIn: round2(externalIn),
      externalOut: round2(externalOut),
    },
  };
```

- [ ] **Step 4: Run and confirm the ledger checks pass**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: all Step 1 checks pass now.

- [ ] **Step 5: Add i18n strings for the account detail page**

In `src/lib/i18n/en.ts`, `accounts` section, right after `inOut`:

```ts
    inOut: (inAmount: string, outAmount: string) => `${inAmount} in · ${outAmount} out`,
    netExternal: "Net external",
```

In `src/lib/i18n/es.ts`, `accounts` section, right after `inOut`:

```ts
    inOut: (inAmount: string, outAmount: string) => `${inAmount} entrada · ${outAmount} salida`,
    netExternal: "Externas netas",
```

- [ ] **Step 6: Render the new stat on the account detail page**

In `src/app/(app)/accounts/[id]/page.tsx`, change the stat grid from 4 to 5 columns and add the new tile:

```tsx
      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label={t.balance}
            value={formatMoney(ledger.balance, account.currency)}
            hint={
              account.currency !== context.displayCurrency
                ? formatMoney(ledger.displayBalance, context.displayCurrency)
                : t.transactionCount(rows.length)
            }
          />
          <Stat
            label={t.incomeIn}
            value={formatMoney(totals.inflow, account.currency)}
          />
          <Stat
            label={t.spendingOut}
            value={formatMoney(totals.outflow, account.currency)}
          />
          <Stat
            label={t.netTransfers}
            value={formatMoney(
              totals.transfersIn - totals.transfersOut,
              account.currency,
              { signDisplay: "always" },
            )}
            hint={t.inOut(
              formatMoney(totals.transfersIn, account.currency),
              formatMoney(totals.transfersOut, account.currency),
            )}
          />
          <Stat
            label={t.netExternal}
            value={formatMoney(
              totals.externalIn - totals.externalOut,
              account.currency,
              { signDisplay: "always" },
            )}
            hint={t.inOut(
              formatMoney(totals.externalIn, account.currency),
              formatMoney(totals.externalOut, account.currency),
            )}
          />
        </CardContent>
      </Card>
```

- [ ] **Step 7: Manual UI check and typecheck**

```bash
npm run typecheck
npm run dev
```

Open any account detail page and confirm 5 stat tiles render without layout breakage (Balance, Income in, Spending out, Net transfers, Net external), with "Net external" reading `+$0.00`/`0 in · 0 out` for an account with no external-transfer rows yet.

- [ ] **Step 8: Commit**

```bash
git add src/lib/data/accounts.ts src/app/\(app\)/accounts/\[id\]/page.tsx src/lib/i18n/en.ts src/lib/i18n/es.ts scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Show external-transfer totals on the account ledger

getAccountLedger() now reports externalIn/externalOut alongside the
existing inflow/outflow/transfersIn/transfersOut, rendered as a
fifth "Net external" stat tile on the account detail page. Also adds
the end-to-end BSC scenario test with the real production amounts
(134,422 and 115,000 DOP "Debito Por Transferencia" rows), proving
the account balance, period spend, and ledger totals are all
correct together.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 7: Transaction table, filters, and labels

**Files:**
- Modify: `src/components/transactions/transaction-table.tsx`
- Modify: `src/lib/labels.ts`
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts`

**Interfaces:**
- Consumes: `TransactionRow.type`/`transferDirection` (existing, `src/lib/data/transactions.ts` — no change needed, `type: string` already accepts the new value).
- Produces: no new exported interfaces; purely rendering.

- [ ] **Step 1: Add i18n strings**

In `src/lib/i18n/en.ts`, `transactions` section, right after `openingBalance`:

```ts
    openingBalance: "Opening balance",
    externalTransferOut: "External transfer out",
    externalTransferIn: "External transfer in",
    externalTransferBadge: "External",
```

In `src/lib/i18n/es.ts`, `transactions` section, right after `openingBalance`:

```ts
    openingBalance: "Saldo inicial",
    externalTransferOut: "Transferencia externa saliente",
    externalTransferIn: "Transferencia externa entrante",
    externalTransferBadge: "Externa",
```

- [ ] **Step 2: Update `labels.ts`**

In `src/lib/labels.ts`:

```ts
export const TRANSACTION_TYPES = ["EXPENSE", "INCOME", "TRANSFER", "EXTERNAL_TRANSFER"] as const;
export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  EXPENSE: "Expense",
  INCOME: "Income",
  TRANSFER: "Transfer",
  OPENING_BALANCE: "Opening balance",
  EXTERNAL_TRANSFER: "External transfer",
};
```

- [ ] **Step 3: Update `AmountCell` and the description/badge rendering in `transaction-table.tsx`**

```tsx
function AmountCell({
  row,
  displayCurrency,
}: {
  row: TransactionRow;
  displayCurrency: string;
}) {
  const sign =
    row.type === "INCOME" || row.type === "OPENING_BALANCE"
      ? "+"
      : row.type === "EXPENSE"
        ? "-"
        : "";
  // An opening balance raises the account like income but is not income, and
  // an external transfer moves value like an internal transfer leg but has
  // no Cadence-side counterparty - both get the neutral transfer tone rather
  // than the income green or a directional sign.
  const tone =
    row.type === "INCOME"
      ? "text-[var(--good)]"
      : row.type === "TRANSFER" || row.type === "OPENING_BALANCE" || row.type === "EXTERNAL_TRANSFER"
        ? "text-muted-foreground"
        : "";

  return (
    <div className="text-right">
      <span className={cn("figure text-sm", tone)}>
        {sign}
        {formatMoney(row.displayAmount, displayCurrency)}
      </span>
      {row.currency !== displayCurrency ? (
        <p className="figure text-[0.6875rem] text-muted-foreground">
          {formatMoney(row.amount, row.currency)}
        </p>
      ) : null}
    </div>
  );
}
```

Update the description cell:

```tsx
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm">
                      {row.note ??
                        (row.type === "TRANSFER"
                          ? (row.transferDirection === "OUT"
                              ? t.transferTo(row.counterpartAccountName ?? t.anotherAccount)
                              : t.transferFrom(row.counterpartAccountName ?? t.anotherAccount))
                          : row.type === "EXTERNAL_TRANSFER"
                            ? (row.transferDirection === "OUT" ? t.externalTransferOut : t.externalTransferIn)
                            : row.type === "OPENING_BALANCE"
                              ? t.openingBalance
                              : (row.categoryName ?? t.uncategorized))}
                    </span>
```

Update the source badge:

```tsx
                <TableCell className="hidden md:table-cell">
                  <SourceBadge
                    source={row.source}
                    isTransfer={row.type === "TRANSFER" || row.type === "EXTERNAL_TRANSFER"}
                    labels={common.sourceLabels}
                    transferLabel={row.type === "EXTERNAL_TRANSFER" ? t.externalTransferBadge : t.transfer}
                  />
                </TableCell>
```

The counterpart-account cell (`row.type === "TRANSFER" && row.counterpartAccountName`) and the edit/delete dropdown logic need no changes — `EXTERNAL_TRANSFER` rows have `transferId: null`, so `editingTransfer`/`editingPlain` already route them to `TransactionDialog` correctly (Task 5), and `transactionEditBlock` already returns `null` for them (Task 2).

- [ ] **Step 4: Manual UI check and typecheck**

```bash
npm run typecheck
npm run dev
```

In the transactions list, filter by Type and confirm "External transfer" appears as an option; create one manually (Task 5's dialog) and confirm it renders with a muted amount, no leading sign, "External" source badge, and the correct out/in description text.

- [ ] **Step 5: Commit**

```bash
git add src/components/transactions/transaction-table.tsx src/lib/labels.ts src/lib/i18n/en.ts src/lib/i18n/es.ts
git commit -m "$(cat <<'EOF'
Render EXTERNAL_TRANSFER rows in the transaction table and filters

Neutral transfer-family styling (muted tone, no leading sign, same
icon family as an internal transfer) with an "External" badge and a
direction-aware fallback description, matching how OPENING_BALANCE
and TRANSFER already render. Added to the type filter list.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 8: CSV import review — the BSC fix

**Files:**
- Modify: `src/components/import/import-review.tsx`
- Modify: `src/components/import/csv-importer.tsx`
- Modify: `src/server/actions/import.ts`
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/es.ts`
- Test: `scripts/verify-domain.ts`

**Interfaces:**
- Consumes: `DetectedGroup.transferDirection` (existing, `src/lib/import-grouping.ts` — unchanged), `buildRowCategoryOverrides` (existing, unchanged).
- Produces: the CSV import payload row shape gains `transferDirection: "OUT" | "IN" | null`; `type` can now be `"EXTERNAL_TRANSFER"`.

- [ ] **Step 1: Add i18n strings**

In `src/lib/i18n/en.ts`, `transactions` section, right after `markAsIncome`/`appliedMarkedAsIncome`:

```ts
    markAsIncome: "Mark as income",
    appliedMarkedAsIncome: "Marked as income",
    recordAsExternalTransfer: "Record as external transfer",
    appliedExternalTransfer: "Recorded as external transfer",
    resolveTransfersHint: (n: number) =>
      `Resolve ${n} possible transfer${n === 1 ? "" : "s"} before importing`,
```

In `src/lib/i18n/es.ts`, `transactions` section, right after `markAsIncome`/`appliedMarkedAsIncome`:

```ts
    markAsIncome: "Marcar como ingreso",
    appliedMarkedAsIncome: "Marcado como ingreso",
    recordAsExternalTransfer: "Registrar como transferencia externa",
    appliedExternalTransfer: "Registrado como transferencia externa",
    resolveTransfersHint: (n: number) =>
      `Resuelve ${n} posible${n === 1 ? "" : "s"} transferencia${n === 1 ? "" : "s"} antes de importar`,
```

- [ ] **Step 2: Add a third review action to `GroupCard` in `import-review.tsx`**

Generalize the `resolved` computation:

```tsx
  const isTransferGroup = group.kind === "transfer";
  const resolved = isTransferGroup
    ? typeDecision !== undefined || decision !== undefined
    : decision !== undefined;
```

Replace the applied-state block:

```tsx
      {resolved ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            {typeDecision === "INCOME"
              ? t.appliedMarkedAsIncome
              : typeDecision === "EXTERNAL_TRANSFER"
                ? t.appliedExternalTransfer
                : decision === EXPLICIT_NO_CATEGORY
                  ? group.kind === "transfer"
                    ? t.appliedLeaveAsExpense
                    : t.appliedUncategorized
                  : t.appliedCategory(
                      categories.find((category) => category.id === decision)?.name ?? "",
                    )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => (typeDecision !== undefined ? onDecideTypeAction(undefined) : onDecideAction(undefined))}
          >
            {t.changeDecision}
          </Button>
        </div>
      ) : (
```

Add the new button to both the outgoing and incoming branches:

```tsx
          {isOutgoingTransfer ? (
            <>
              <TransferDialog
                accounts={accounts}
                values={transferValues!}
                locale={locale}
                trigger={
                  <Button type="button" variant="outline" size="xs">
                    {t.reviewGroup}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("EXTERNAL_TRANSFER")}
              >
                {t.recordAsExternalTransfer}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideAction(EXPLICIT_NO_CATEGORY)}
              >
                {t.leaveAsExpense}
              </Button>
            </>
          ) : isIncomingTransfer ? (
            <>
              <TransferDialog
                accounts={accounts}
                values={transferValues!}
                locale={locale}
                trigger={
                  <Button type="button" variant="outline" size="xs">
                    {t.reviewGroup}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("EXTERNAL_TRANSFER")}
              >
                {t.recordAsExternalTransfer}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("INCOME")}
              >
                {t.markAsIncome}
              </Button>
            </>
          ) : (
```

(The rest of the non-transfer branch is unchanged.)

- [ ] **Step 3: Wire direction overrides and the submit gate into `csv-importer.tsx`**

Add a direction-overrides map right after the existing `rowTypeOverrides`:

```tsx
  // A row whose type override is EXTERNAL_TRANSFER needs a direction too -
  // taken from the group's own detected direction (OUT groups are outgoing,
  // IN groups incoming), never invented independently of the group.
  const rowDirectionOverrides = useMemo(() => {
    const decisions: RowCategoryDecision[] = groups
      .filter((group) => groupTypeDecisions[group.id] === "EXTERNAL_TRANSFER" && group.transferDirection)
      .map((group) => ({ rowIndexes: group.rowIndexes, categoryId: group.transferDirection as string }));
    return buildRowCategoryOverrides(decisions);
  }, [groups, groupTypeDecisions]);

  // The Import button stays disabled while any detected transfer-shaped
  // group has neither a category decision (leave as expense/uncategorized)
  // nor a type decision (mark as income / record as external transfer) -
  // a transfer-shaped description alone must never silently import as
  // ordinary income or spending.
  const unresolvedTransferGroups = groups.filter(
    (group) =>
      group.kind === "transfer" &&
      groupDecisions[group.id] === undefined &&
      groupTypeDecisions[group.id] === undefined,
  );
```

Update payload building:

```tsx
  const payload = JSON.stringify({
    accountId,
    currency,
    rows: validRows.map((row, index) => {
      const type = rowTypeOverrides.get(index) ?? row.type;
      return {
        date: toISODate(row.date as Date),
        amount: row.amount as number,
        type,
        transferDirection: type === "EXTERNAL_TRANSFER" ? (rowDirectionOverrides.get(index) ?? null) : null,
        note: row.note || null,
        categoryId:
          type === "EXTERNAL_TRANSFER"
            ? null
            : (rowCategoryOverrides.get(index) ?? (categoryId === "none" ? null : categoryId)),
      };
    }),
  });
```

Update the submit form:

```tsx
              <form action={formAction} className="flex items-center gap-3">
                <input type="hidden" name="payload" value={payload} />
                <SubmitButton pending={pending} disabled={unresolvedTransferGroups.length > 0}>
                  {t.importCount(validRows.length)}
                </SubmitButton>
                {unresolvedTransferGroups.length > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {t.resolveTransfersHint(unresolvedTransferGroups.length)}
                  </span>
                ) : state?.error ? (
                  <span className="text-sm text-destructive">{state.error}</span>
                ) : null}
              </form>
```

- [ ] **Step 4: Add failing pure checks to `scripts/verify-domain.ts`**

Add this right before `console.log("\n== cleanup ==")`, inside the existing `"CSV import review: transfer direction"` block's closing brace (after the existing "7/8/9" checks, still inside the same `{ ... }` block so `groups`, `outgoing`, `incoming`, `shoppingGroups` are in scope):

```ts
    // 10/11/12: "Record as external transfer" is a distinct decision from
    // both "mark as income" and "leave as expense" - same channel
    // (typeDecisions) as income, but resolves to EXTERNAL_TRANSFER with the
    // group's own direction, never invented independently.
    const externalOverrides = buildRowCategoryOverrides([
      { rowIndexes: outgoing.rowIndexes, categoryId: "EXTERNAL_TRANSFER" },
    ]);
    eq(
      "10. recording an outgoing transfer group as external overrides exactly its own row",
      externalOverrides.get(0),
      "EXTERNAL_TRANSFER",
    );
    const simulatedPayloadRow = (
      originalType: "EXPENSE" | "INCOME",
      group: (typeof groups)[number],
      typeOverride: string | undefined,
    ) => {
      const type = typeOverride ?? originalType;
      return {
        type,
        transferDirection: type === "EXTERNAL_TRANSFER" ? group.transferDirection : null,
        categoryId: type === "EXTERNAL_TRANSFER" ? null : "would-be-resolved-category-id",
      };
    };
    const outgoingExternalRow = simulatedPayloadRow("EXPENSE", outgoing, externalOverrides.get(0));
    eq("11. an outgoing external-transfer row gets the group's own OUT direction", outgoingExternalRow.transferDirection, "OUT");
    eq("12. an outgoing external-transfer row forces categoryId null even if a default category was set", outgoingExternalRow.categoryId, null);

    const incomingExternalOverrides = buildRowCategoryOverrides([
      { rowIndexes: incoming.rowIndexes, categoryId: "EXTERNAL_TRANSFER" },
    ]);
    const incomingExternalRow = simulatedPayloadRow("INCOME", incoming, incomingExternalOverrides.get(1));
    eq("11. an incoming external-transfer row gets the group's own IN direction", incomingExternalRow.transferDirection, "IN");
    eq("12. an incoming external-transfer row forces categoryId null too", incomingExternalRow.categoryId, null);

    const ordinaryOutgoingRow = simulatedPayloadRow("EXPENSE", outgoing, undefined);
    eq("13. a row with no type decision keeps direction null - it's not an external transfer", ordinaryOutgoingRow.transferDirection, null);

    // 14: the submit-time guard - the Import button stays disabled while any
    // detected transfer-shaped group has neither a category nor a type decision.
    const unresolvedTransferGroups = (
      allGroups: typeof groups,
      categoryDecisions: Record<string, string>,
      typeDecisions: Record<string, string>,
    ) =>
      allGroups.filter(
        (group) =>
          group.kind === "transfer" &&
          categoryDecisions[group.id] === undefined &&
          typeDecisions[group.id] === undefined,
      );
    eq(
      "14. with no decisions at all, every transfer group is unresolved and blocks import",
      unresolvedTransferGroups(groups, {}, {}).length,
      groups.filter((g) => g.kind === "transfer").length,
    );
    eq(
      "14. resolving the outgoing group via a type decision (external transfer) clears it from the unresolved list",
      unresolvedTransferGroups(groups, {}, { [outgoing.id]: "EXTERNAL_TRANSFER" }).some((g) => g.id === outgoing.id),
      false,
    );
    eq(
      "14. resolving the outgoing group via a category decision (leave as expense) also clears it",
      unresolvedTransferGroups(groups, { [outgoing.id]: EXPLICIT_NO_CATEGORY }, {}).some((g) => g.id === outgoing.id),
      false,
    );
    check(
      "14. an ordinary (non-transfer) group never blocks import even with zero decisions",
      unresolvedTransferGroups(shoppingGroups, {}, {}).length === 0,
    );
```

- [ ] **Step 5: Run and confirm the new checks pass (pure logic, no implementation gap expected)**

```bash
npx tsx scripts/verify-domain.ts
```

Since `buildRowCategoryOverrides` and the group's own `transferDirection` are unchanged (Task 8 only adds UI wiring, not new pure-lib functions), these checks validate the *simulation* of the logic the UI will use — they should pass immediately, proving the approach is sound before wiring it into the actual client component in Steps 2-3.

- [ ] **Step 6: Update `import.ts`'s payload schema and action**

In `src/server/actions/import.ts`:

```ts
const importPayloadSchema = z.object({
  accountId: z.string().trim().min(1, "Pick an account for these rows"),
  currency: z.enum(CURRENCIES),
  rows: z
    .array(
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Row has an invalid date"),
          amount: z.number().positive("Row amount must be greater than 0"),
          type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
          transferDirection: z.enum(["OUT", "IN"]).nullable(),
          note: z.string().max(500).nullable(),
          categoryId: z.string().nullable(),
        })
        .refine((row) => (row.type === "EXTERNAL_TRANSFER") === (row.transferDirection !== null), {
          message: "External transfer rows need a direction",
          path: ["transferDirection"],
        }),
    )
    .min(1, "Nothing to import")
    .max(MAX_ROWS, `Import at most ${MAX_ROWS} rows at a time`),
});
```

And the row-mapping in `importTransactionsAction`:

```ts
  const data = parsed.data.rows.map((row) => ({
    date: fromISODate(row.date) as Date,
    amount: row.amount,
    currency: parsed.data.currency,
    type: row.type,
    transferDirection: row.transferDirection,
    accountId: account.id,
    categoryId:
      row.type === "EXTERNAL_TRANSFER"
        ? null
        : resolveImportCategoryId({
            explicitCategoryId: row.categoryId,
            note: row.note,
            type: row.type,
            knownCategoryIds,
            categoryIdByName,
          }),
    note: row.note,
    source: "CSV" as const,
  }));
```

- [ ] **Step 7: Typecheck and manual UI check**

```bash
npm run typecheck
npm run dev
```

Import a small CSV with a "Debito Por Transferencia"-style row. Confirm: the possible-transfer card now shows three actions (Review, Record as external transfer, Leave as expense) for an outgoing row and (Review, Record as external transfer, Mark as income) for an incoming row; clicking "Record as external transfer" marks the group resolved with the right applied label; the Import button is disabled with the "Resolve N possible transfer(s)" hint until every transfer-shaped group is resolved; after resolving and importing, the resulting transaction shows up as an External transfer with the correct direction and no category.

- [ ] **Step 8: Run the full suite one more time**

```bash
npx tsx scripts/verify-domain.ts
```

Expected: `All checks passed.`, zero `FAIL` lines, all ~320+ checks (existing ~300 plus everything added in Tasks 1-8) print `ok`.

- [ ] **Step 9: Commit**

```bash
git add src/components/import/import-review.tsx src/components/import/csv-importer.tsx src/server/actions/import.ts src/lib/i18n/en.ts src/lib/i18n/es.ts scripts/verify-domain.ts
git commit -m "$(cat <<'EOF'
Add "Record as external transfer" to CSV import review

Detected transfer-shaped groups (both outgoing "Debito Por
Transferencia" and incoming "Transferencia Recibida" shapes) now
offer a third action alongside Review-as-internal-transfer and
Leave-as-expense/Mark-as-income: Record as external transfer. It
needs no dialog - the group already knows its own direction - and
forces categoryId null. The batch Import button is now disabled
until every detected transfer-shaped group has an explicit decision,
so a transfer-shaped row can no longer silently import as ordinary
income/spending just because it was never reviewed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TP7jGZ83U2c1KceuiWiDUg
EOF
)"
```

---

## Task 9: Full regression, manual QA, wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Full automated regression**

```bash
npm run typecheck
npm run lint
npx tsx scripts/verify-domain.ts
```

Expected: no type errors, no lint errors, `All checks passed.` with zero `FAIL` lines across the entire suite (existing ~300 checks plus everything added in Tasks 1-8).

- [ ] **Step 2: Manual browser QA checklist**

Everything below requires a real authenticated session, since `saveTransactionAction`, `deleteTransactionAction`, and `importTransactionsAction` are gated by `requireAuth()` and can't be driven by `scripts/verify-domain.ts` (see Task 4). Use the session-cookie-minting approach documented for this repo's local dev setup rather than the PIN.

- [ ] Create a manual External transfer (Outgoing) on a real account; confirm the account balance and the account detail page's "Net external" tile both update.
- [ ] Create a manual External transfer (Incoming); confirm the balance and ledger tile move the other way.
- [ ] Edit an existing Expense, switch its type to External transfer, save; confirm its category disappears from the row and the ledger totals update.
- [ ] Edit that same row back to Income; confirm the direction field disappears and a category can be picked again.
- [ ] Edit an External transfer's direction (Outgoing → Incoming) without changing anything else; confirm the balance swing is double the amount.
- [ ] Delete an External transfer; confirm only that one row disappears (no other row vanishes) and the balance returns to its prior value.
- [ ] Confirm an internal Transfer (via "Move money") still works exactly as before — both legs created, edit blocked from the generic form, delete removes both legs.
- [ ] Import a small CSV containing at least one outgoing transfer-shaped row and one incoming transfer-shaped row (e.g. reuse the BSC-style descriptions from the spec). Confirm: the Import button is disabled until both groups are resolved; choosing "Record as external transfer" on each resolves them; the imported rows land as External transfer with the correct direction and no category; a normal expense/income row in the same file imports unaffected.
- [ ] Confirm the transaction list's Type filter includes "External transfer" and filtering by it shows only those rows.
- [ ] Switch the display currency in Settings and confirm External transfer amounts convert for display the same way any other transaction does (native currency/amount unchanged in the database).

- [ ] **Step 3: Final wrap-up commit if any QA step required a fix**

If manual QA in Step 2 surfaces an issue, fix it, re-run Step 1's automated regression, and commit the fix with a message describing exactly what QA step caught it. If everything in Step 2 passes as designed, no further commit is needed — the feature is complete as of Task 8's commit.
