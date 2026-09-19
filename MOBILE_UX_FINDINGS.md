# Cadence — Mobile UX Audit

Standard: the `mobile-app-ui-design` skill (ceorkm/mobile-app-ui-design) for **structural
and UX** principles only — thumb zone, F-pattern, tap targets, information density,
state design, user-stage personalisation, anti-patterns — cross-referenced against
`apple-design` §16 (wayfinding, familiarity, simplicity) and against what this app has
already decided about itself: `globals.css:7-14` (the palette contract), the closed
`DESIGN_FINDINGS.md` (no Liquid Glass, no new translucent surfaces, teal is wayfinding
only, the type system is deliberate) and `ANIMATION_FINDINGS.md` (no count-ups, no
confetti, motion only where it carries meaning). Where the skill's *aesthetic* guidance
disagrees with Cadence's identity, Cadence wins and the disagreement is named in
Part 2. Read-only pass; no code changed.

**Summary up front:** on a phone Cadence is the desktop layout shrunk, and the shrink
fails in four specific places — the 11-item nav, every `<table>`, every centred dialog,
and the payday wizard. The content, palette and voice all survive the phone perfectly
well; it is the *containers* that do not. Sixteen findings proposed (three high-leverage
structural ones, the rest are consequences and small breakages), eleven candidates
rejected, and nine places where the skill's advice was deliberately not taken.

---

## Method

- **Data.** A throwaway Postgres database (`cadence_mobile_scratch`), migrated and
  seeded with fictional data — three accounts (two USD, one DOP), 136 transactions over
  May–Sep 2026 including recurring posts, a shared expense with a reimbursement, one
  extraordinary purchase and one internal transfer; ten recurring items including one
  "From Afford" plan and one paused; four goals (one debt, one achieved); Sep A/B
  budgets; four staged Gmail rows. Created, used and dropped in one session; the
  working tree stayed clean; `cadence_dev` was never connected to.
- **Rendering.** `next dev` on :3100 with `DATABASE_URL` overridden in the process env,
  driven by Playwright Chromium with mobile emulation (`isMobile`, `hasTouch`), dark
  scheme with a light-scheme spot check. Two viewports, per the skill's own
  convention: **375×667 @2x** (iPhone SE 2nd/3rd gen — the baseline) and
  **430×932 @3x** (iPhone 15 Pro Max). Portrait only.
- **Screens.** Login, Dashboard, the nav strip in three states, Transactions (+ row
  menu, new dialog, filtered-empty), Payday check-in steps 1–5, Afford (before and
  after evaluation), Goals (+ contribution dialog), Recurring (+ new dialog), Inbox,
  Review, Accounts, Budgets, Reports, Settings.
- **Measurement.** Every figure below is a DOM measurement (`getBoundingClientRect`,
  `scrollWidth`/`clientWidth`, computed styles) taken at the stated viewport, not an
  estimate from a screenshot. Where a number is only given once it was the same at
  both widths.

The headline numbers, 375×667 unless stated:

| What | Measured |
|---|---|
| Sticky header + nav strip | **106px** (56 + 50) — 16% of the viewport, on every screen |
| Nav strip | 1,150px wide, 375 visible → **3 of 11 items** on screen; on `/settings` the active item sits at x = 1038–1134 with `scrollLeft` 0 — **no current-page indicator is visible** |
| Every `Button` in `main`, every nav link, every header control | **32px tall** (`h-8`); row menus 32×32 |
| Transactions table | `scrollWidth` 515 in 343 → **Amount column off-screen**; still off-screen at 430 (515 in 398) |
| Review table | 1,004 in 343 → Amount, Account, Category **and Actions** off-screen |
| Budgets table | 415 in 343 → Budget input clipped, save button off-screen |
| Afford verdict table | 845 in 311 → Amount, both checks and **Verdict** off-screen; projection table 685 in 319 |
| Payday wizard, Step 3 | scroller shows 422px of **3,049px** (7.2 screens inside a modal); 703 of 2,641 at 430 |
| Payday wizard footer | `Next` **53×32px**, centred; `Confirm plan` 107×32; footer y moves from 563 (steps 1–4) to 473 (step 5) |
| New-transaction dialog | footer top at y = **724** in a 667px viewport — Save starts below the fold (fits at 430) |
| New-recurring dialog | content 1,055px in a 635px box; footer at 966 (and at 950 vs 932 at 430) |
| Inbox insight row | **363px tall**; title container **18px wide** (73 at 430); evidence wraps one word per line |
| Recurring "From Afford" row | name truncated at **80px** ("Laptop - 6…"); pills 58×47 and 42×47 (three lines each) |
| Transactions filters | 7 controls between title and list; the table begins at y = **438** |
| Page-header "New" action | y = 202 (top third), 67×32 |
| Dashboard hero figure | top at y = **443** of 667 (428 of 932) — on the first screen, barely |
| Dashboard length | 1,974px = 3.0 screens; Upcoming list at 1,804 |
| Afford verdict after evaluation | alert at y = 1,478; "I bought this" at the bottom of a 3,889px page |
| Font sizes in use on the Dashboard | 10 distinct (10, 11, 12, 12.8, 14, 16, 18, 20, 24, 48px); Inbox: 22 of 27 text nodes are 11px |
| `<meta>` | viewport is Next's default; no `theme-color`, no manifest, no `apple-touch-icon` |
| Loading | 0 `loading.tsx`, `Skeleton` primitive unused, layout is `force-dynamic` |

What already works and was left alone: `Input` is `h-9` and `text-base` on a phone
(`ui/input.tsx:11` — 16px, so iOS does not zoom the field), `PaydayAmountInput` and
`BudgetAmountForm` use `inputMode="decimal"`, the Goals grid stacks cleanly, the
Reports charts are already lists and CSS bars rather than a shrunk desktop chart, the
Accounts table fits (343 in 343), the Recurring lists are lists, light and dark render
identically apart from the tokens, `error.tsx` exists with a retry, and the login screen
is a numeric keypad away from correct.

---

## Part 1 — Findings

### M1 · The nav is a horizontal strip of 11 items: three visible, no current-page indicator, out of thumb reach — **high conviction, highest leverage**

| | |
|---|---|
| **Where** | `src/components/shell/nav-links.tsx:85-109` (bar variant: `flex gap-1 overflow-x-auto px-4 py-2`, links `px-2.5 py-1.5`), mounted at `src/components/shell/app-shell.tsx:89-91` inside the sticky header |
| **Today** | 1,150px of links in a 375px strip. On any page past Transactions the active pill is off-screen and the strip does not scroll it into view (measured on `/settings`: active at x 1038, `scrollLeft` 0), so the screen answers "where am I?" only through the `h1`. Nothing marks that the strip scrolls — no fade, no partial item at 375 (the fourth item starts at x 364 and is clipped to 11px). Links are 32px tall at the top of the screen. |
| **Principle** | Skill: primary actions and navigation in the thumb zone (bottom third); anti-pattern "hiding key content behind extra taps" — eight of eleven destinations need a horizontal swipe first. `apple-design` §16 wayfinding ("Where am I? Where can I go?"), §16.4 familiarity (a bottom tab bar is what every finance app on the user's phone does), §16.5 flexibility ("adapt to the platform: iPhone = quick touch"). |

This is the one place where "different structure on mobile" is not optional. Eleven
flat items cannot be a tab bar (five is the platform ceiling), and "make it scroll" is
what exists today. The nav needs a hierarchy, and the app already has one implicit in
how often each page is opened:

| Cadence | Job | Frequency |
|---|---|---|
| Dashboard, Transactions, Inbox | read today's number, log spending, act on signals | daily |
| Budgets (+ the payday check-in), Recurring, Goals, Afford | plan the period | at payday, and when a bill or purchase changes |
| Accounts, Reports, Review, Settings | maintain the ledger, look back, configure | occasional |

**Recommendation — a five-tab bar with one hub tab and one "More" tab, derived from
the same `NAV` array the sidebar uses.**

```
[ Dashboard ] [ Transactions ] [ Plan ] [ Inbox ● ] [ More ]
```

- **Dashboard**, **Transactions**, **Inbox** keep their names, icons and hrefs. Inbox
  earns a tab because it is the app's one badged surface — an attention count belongs
  on a tab, which is exactly the platform convention it borrows (`CountBadge` moves onto
  the tab unchanged).
- **Plan** is a hub whose screen is a segmented control — `ui/tabs.tsx` already exists —
  over **Budgets · Recurring · Goals · Afford**, each segment rendering the existing page
  unchanged. The payday check-in launches from Budgets and the Dashboard as today. This
  is the grouping with the least certainty in it: Afford is a calculator, but its output
  lands in Recurring's "From Afford" section and its verdict is a planning decision, so it
  sits with the plan rather than in More.
- **More** is a plain list screen (the iOS "More" tab idiom): **Accounts · Reports ·
  Review · Settings**. If the review queue's pending count is wired into `NavBadges`
  (the layout computes only `/inbox` today, `src/app/(app)/layout.tsx:18`), the More tab
  shows it.
- Labels stay the dictionary's own (`en.ts:152-163`, `es.ts:145-156`); the Spanish
  "Transacciones" is the longest at 13 characters and fits a 75px tab at 11px. Deep pages
  (goal detail, CSV import, categories) already carry back links
  (`goals/[id]/page.tsx:80-84`, `transactions/import/page.tsx:32`,
  `settings/categories/page.tsx:22`), so wayfinding inside a tab holds.
- Tap targets: tabs are 49px tall plus `env(safe-area-inset-bottom)`; the whole tab is
  the target, not the icon.
- Toasts: `Toaster` (`src/app/layout.tsx:45`) gets sonner's `mobileOffset` so a
  bottom toast clears the bar; sonner already goes full-width below 600px.

**Material — the same as the header, and explicitly not glass.** The bar is a floating
layer with content scrolling under it, which is the *same class* of surface as the
header, not a new class: `bg-background/85 supports-backdrop-filter:backdrop-blur`, the
`prefers-reduced-transparency` rule at `globals.css:368-372` extended to cover it
(rename the `.app-header` hook to a shared `.app-chrome`), and no overlap with the header
so the "never stack light translucent surfaces" rule holds. Active state: label and icon
go `text-muted-foreground → text-foreground` with the sidebar's 2px `bg-primary` marker
(`nav-links.tsx:128-133`) laid along the tab's top edge — teal stays wayfinding-only per
`globals.css:10-11`. No pill per tab (five pills is noise), no fill, no shadow.

**Structure or visual?** Structural — a new component built from tokens already in
`globals.css`; the desktop sidebar is untouched. The vertical budget is neutral: 50px of
nav leaves the top and 49px arrives at the bottom. What changes is reach and wayfinding.

---

### M2 · Four tables shrink instead of restructuring, and the column that goes off-screen is always the money — **high conviction**

| | |
|---|---|
| **Where** | `src/components/ui/table.tsx:11` (`overflow-x-auto` wrapper, so every table silently scrolls sideways) used by `transactions/transaction-table.tsx:151-162`, `review/review-table.tsx:37-47` + `review-row.tsx:132-148`, `app/(app)/budgets/page.tsx:234-301`, `afford/afford-results.tsx:127-211` and `:256-316` |
| **Today** | Transactions: Date (104px fixed) and Description fill the width; **Amount** is off-screen at 375 *and* 430. Review: only Date and Description are visible; Amount, Account, Category and the Approve/Reject column — the page's only purpose — are 400–1,000px to the right. Budgets: Category and Spent visible, the Budget input clipped mid-field and its save button off-screen; the Progress meter is already hidden below `sm` (`:238`, `:256`). Afford: the verdict table shows Payment and Date and hides Amount, both checks and **Verdict**; the projection table hides everything but the period label and the first two figures. |
| **Principle** | Skill, Structure step: "expose content directly instead of hiding behind taps"; anti-patterns "hiding key content" and "emphasising labels over values" — at 375 the Transactions page shows the label column (Date) and hides the value column (Amount). F-pattern: the eye lands top-left and scans right; there is nothing at the right. `apple-design` §16.6: hierarchy through order and contrast so the most important thing is the most obvious. |

The Accounts table is the control case: three columns, 343 in 343, correct as built
(`accounts/page.tsx`). Every other table carries more columns than a phone has, and a
`<table>` cannot reflow. The Recurring page already shows the right answer — it is a
`<ul>` of two-line rows (`recurring-list.tsx:114-234`) and it translates to a phone with
one small defect (M7). Each of the four needs its own mobile shape, not a generic card:

**Transactions → a two-line ledger row, grouped by day.** One DOM, two layouts: the
`<table>` becomes a list whose row is a CSS grid, `grid-cols-[minmax(0,1fr)_auto]` on a
phone and the current columns from `sm`. Line 1: description ‖ signed amount
(`AmountCell` unchanged, tabular, right-aligned); line 2: `● Category · Account` ‖ the
native-currency figure when it differs. The Date column becomes a day header
(`figure figure-sm`, the existing `eyebrow` treatment) above each day's rows, which is
how every bank app and Apple Wallet lay out a ledger and costs one row per day instead of
104px per transaction. Source badge and the transfer counterpart name stay in line 2.
Tapping the row opens the edit dialog (the whole 56px+ row is the target); the `⋯` menu
keeps one-off and delete. Pagination stays.

**Review → one card per staged row, actions on the bottom edge.** Description and amount
on line 1, date and source on line 2, the Account and Category pickers full-width
underneath (they are already `w-full` `Select`s, `review-row.tsx:97,117`), and
`Reject` / `Approve` as a two-button row at the card's foot — the card's thumb side. The
grouping by source (`Gmail (4)`) stays as the section heading.

**Budgets → category row with the meter restored.** Line 1: `● Category` ‖ spent figure;
line 2: the `Meter` (hidden today, and it is the point of the page) with the % beside it;
line 3: the `BudgetAmountForm` input at full width with its save button — a 44px target
instead of a clipped `w-32` (`budget-amount-form.tsx:82`).

**Afford → verdict cards, projection kept as a table with an honest scroll.** The
verdict table (`afford-results.tsx:127-211`) is one row per installment with per-period
checks spanning rows; on a phone it becomes one card per pay period: period label and
`VerdictBadge` on line 1, the installment(s) with dates and amounts, then the two checks
as labelled `BeforeAfter` lines ("Everyday Checking above its buffer: $13,988.82 →
$13,868.82"). The projection table (`:256-316`) is a genuine 7-column matrix of
secondary figures; keep it a table but give the wrapper a scroll-edge affordance (a
`mask-image` fade on the overflowing edge) so the user knows it scrolls — today nothing
says so.

**Structure or visual?** Structural. Every figure, badge and menu item that exists today
survives; the change is the container. The only visual addition is the day header in
Transactions, set in the existing `eyebrow`/`figure-sm` classes.

---

### M3 · The payday check-in is a centred modal with seven screens of scroll inside Step 3 and a 53×32px "Next" — **high conviction**

| | |
|---|---|
| **Where** | `src/components/payday/payday-checkin-dialog.tsx:333` (`DialogContent className="flex flex-col overflow-hidden sm:max-w-2xl"`), `:334-339` header, `:356-362` step scroller, `:442-463` footer; `ui/dialog.tsx:64` (centred, `max-h-[calc(100dvh-2rem)]`), `:116` (`DialogFooter`: `flex-col-reverse ... sm:flex-row sm:justify-end`); `step-commitments.tsx:249-609`; `step-balances.tsx:24-34` |
| **Today** | At 375 the dialog is 635px tall; header and footer take 213 of them, leaving a 422px window. Step 3's content is 3,049px — the user scrolls 7.2 windows inside a box inside a phone, and the summary card that every edit changes (`step-commitments.tsx:557-609`, "Available") is 2,600px below the first input. The title `Payday check-in - September 16-30, 2026` wraps to two lines at 375 and its second half runs under the `×` close button. The footer stacks its two buttons centred: **Next is 53×32px**, Back 54×32 under it. Between steps 1–4 and step 5 the dialog re-centres because step 5 is short, so `Confirm plan` sits 90px higher than `Next` did. Progress is the text "Step 3 of 5". Step 1 opens with two paragraphs of copy (170px) before the first input. |
| **Principle** | Skill: "place primary actions in the thumb zone", "ensure all tap targets are at least 44×44pt", "reduce interaction cost", "what's the one thing they should notice first?" (in Step 3 it is `Available`, and it is off-screen). `apple-design` §7 spatial consistency — the primary button should not move between steps; §16 wayfinding; §16.6 "sometimes adding context simplifies" (the running total). |

The five steps are the right five steps — each one asks a different question and the
prior audits already fixed the transitions (`.step-enter`). The count is not the
problem; the *container* and Step 3's height are.

**Recommendation.**

1. **Full-screen sheet below `sm`.** `DialogContent` for the wizard takes `inset-0
   h-dvh max-h-none rounded-none translate-none` on a phone, so the step window grows
   from 422px to roughly 540px (+28%), and the header and footer stop consuming a third
   of the viewport. Enter from the bottom edge, exit the same way (`apple-design` §7),
   200ms `var(--ease-out)` — the same duration the steps already use; reduced motion
   falls back to the global cross-fade.
2. **A fixed footer with a real button.** One row: `Back` as a ghost text button at the
   left, `Next` / `Confirm plan` as a full-width primary at 44px (`h-11`), the row padded
   by `env(safe-area-inset-bottom)`. Because the sheet is full-height the row never
   moves between steps — the step-5 jump disappears for free.
3. **Progress as a rail, not a sentence.** Five segments in the header using the
   `PeriodRail` idiom the app already owns — `bg-primary` for the current step,
   `bg-foreground/25` done, `bg-foreground/10` ahead — with the step title as the
   description line. On a phone drop the period from the `DialogTitle` (it becomes the
   first line of the description), which also ends the collision with the close button.
4. **Step 3: keep the running total in view, collapse what is stable.** Pin a one-line
   `Available for flexible categories: $1,234.56` strip directly above the footer while
   steps 3 and 4 are open — the number every edit moves, always visible. Each per-account
   buffer block (`step-commitments.tsx:263-357`) collapses to its header and status line
   (name, suggested buffer, "above its buffer by…" / the red shortfall) and expands on
   tap to the subscription rows and pickers; goals blocks likewise collapse to name and
   planned total. The status line is what the user is checking; the rows are what they
   change when it is wrong. This is a deliberate trade against the skill's "don't hide
   content behind taps" — the alternative is seven screens, and the collapsed row keeps
   the *verdict* visible, only the *controls* fold. Named in Part 2.
5. **Step 1: one sentence, then the inputs.** Keep `step1Description` visible and fold
   the long `step1BalanceMeaning` paragraph (`step-balances.tsx:34`) behind a
   "What counts as the reported balance?" disclosure on a phone. The paragraph was added
   deliberately to stop a double-count on reopen and must stay reachable; it does not
   need to sit between the user and the first field every time.

Inputs are already right: `inputMode="decimal"`, 36px tall, `.`/`,` both accepted.

**Structure or visual?** Structural, plus one visual element: the progress rail, made of
the same blocks and tokens as `PeriodRail`. No new colour. **Conflict flagged:** the
skill's Peak-End step wants the confirm moment celebrated (sparkle, badge, "you showed
up today"). Not adopted — see Part 2; the ending Cadence already has is the Dashboard's
confirmed-plan card and the hero updating, which is the skill's own "summary card"
ending without the confetti.

---

### M4 · Every dialog is a centred modal; on a phone the Save button starts below the fold — **medium-high conviction**

| | |
|---|---|
| **Where** | `src/components/ui/dialog.tsx:64` (`fixed top-1/2 left-1/2 ... -translate-y-1/2 ... overflow-y-auto ... sm:max-w-sm`), `:116` footer; `form/form-dialog.tsx:78-101` (every create/edit form), `form/confirm-delete.tsx` |
| **Today** | New transaction at 375: dialog spans y 16–651, footer top at **724** — Save and Cancel are below the viewport until the dialog itself is scrolled, and nothing hints they exist. New recurring item: 1,055px of content in a 635px box, footer at 966 at 375 and 950 at 430 — off-screen at both widths. Log contribution fits (footer 510–615) and stacks two full-width 32px buttons, which is the closest thing in the app to the right shape. The `DialogDescription` "Logged manually - source stays as Manual." spends 40px at the top of the smallest screen. |
| **Principle** | Skill: CTAs in the thumb zone; 44pt targets; "reduce interaction cost". `apple-design` §7 (a sheet emerges from and returns to the edge it belongs to), §12 (dim to focus), §16.4 familiarity — on iPhone, forms present as sheets from the bottom. |

**Recommendation — one change in `ui/dialog.tsx` covers every form in the app.** Below
`sm`, `DialogContent` anchors to the bottom edge instead of the centre:

```
bottom-0 top-auto left-0 right-0 translate-none w-full max-w-none
max-h-[92dvh] rounded-b-none rounded-t-xl
```

…and adopts the wizard's own internal structure (`payday-checkin-dialog.tsx:329-362`):
`flex flex-col overflow-hidden`, the form body as the single scroller, `DialogFooter`
fixed at the bottom with `env(safe-area-inset-bottom)` and its buttons at 44px — primary
full-width, cancel as a ghost beside it in one row rather than stacked. Enter from the
bottom, exit to the bottom, 100ms as today (`ANIMATION_FINDINGS` was explicit that the
100ms open on these must not lengthen; a bottom-anchored `slide-in-from-bottom` at 100ms
is short enough to read as placement, not animation). The overlay's `bg-black/10` +
2px blur stays. `ConfirmDelete` takes the same sheet — a destructive confirmation from
the bottom edge is the platform's action-sheet shape, and consistency beats a special
case.

**No grabber, no drag-to-dismiss** unless it is built properly: a grabber promises 1:1
tracking, velocity hand-off and rubber-banding (`apple-design` §2–§6, §9), and a grabber
that only responds to a tap is an affordance that lies. Swipe-to-dismiss is a separate,
later piece of work; the sheet does not need it to be correct.

A smaller note inside the same finding: in `TransactionDialog` the field order is Type,
Date, Amount, Currency, Account, Category. On a phone the amount is what the user knows
when they open the sheet — receipt in hand — and Date is nearly always today. Amount
first, then Account/Category, then Type, then Date, with the description line dropped on
mobile, would make the common path one field long. Low conviction, reorder only, no
autofocus (an auto-raised keyboard covers the sheet it just opened).

**Structure or visual?** Structural. Same `bg-popover ring-1 ring-foreground/10`, same
radius (`--radius-xl` ≈ 13px — the skill's `rounded-2xl/3xl` is not adopted, see
Part 2). The only visual change is where the box sits.

---

### M5 · Primary actions sit in the top third of every page, and nothing the thumb lands on is 44pt — **medium-high conviction**

| | |
|---|---|
| **Where** | `src/components/page-header.tsx:15-28` (actions wrap under the title, top of page) used by Transactions, Goals, Recurring, Accounts, Budgets; `ui/button.tsx:24-34` (`h-8` at all widths; `sm`/`xs`/`icon-xs` are `h-8`/`size-8` on a phone and *smaller* from `sm` up); `ui/select.tsx:58` (`h-8`); `nav-links.tsx:96`; `app-shell.tsx:82-87` (four 32px header controls) |
| **Today** | "New" (Transactions) at y 202, 67×32. "New goal", "New item", "New account" the same. "Start payday check-in" at y 217, 151×32. Every button inside `main` is 32px tall on every page measured (59 of 59 on Transactions, 21 of 21 on Review, 14 of 14 on Budgets). Row `⋯` menus are 32×32 (`icon-xs`). The nav links are 32px. Afford's "Check affordability" is 2.1 screens down and "I bought this" 5.8 screens down (M11). |
| **Principle** | Skill: "place primary actions in the thumb zone (bottom 1/3)", "ensure all tap targets are at least 44×44pt", anti-pattern "placing CTAs outside the thumb zone". `apple-design` §10: hit padding around the target, highlight on touch-down — the press feedback already exists (`.btn-press`), the area under it does not. |

The design system already has the right instinct in the wrong direction: `h-8 sm:h-6`
and `size-8 sm:size-6` (`button.tsx:26,31`) mean someone made phone targets *bigger
than desktop* and stopped at 32. The desktop density is right for a pointer and should
not change; the phone needs one more step.

**Recommendation.**

1. **Targets.** Below `sm`: `default`/`sm`/`lg` → `h-11` (44px); `xs` → `h-10`;
   `icon-xs`/`icon-sm` → `size-10` with the glyph unchanged (the hit area grows through
   padding, the icon does not — a 40px `⋯` glyph would be a different design). Select
   triggers follow `Input` to `h-11`. Nav links (or M1's tabs) 44–49px. Header controls
   40px. All of this is `sm:`-gated; nothing above the breakpoint moves.
2. **A docked action row on the pages that create things.** Transactions, Goals,
   Recurring and Accounts each have exactly one primary action and it lives at the top
   of the page. On a phone, render that one action in a row docked above the tab bar —
   full-width primary at 44px, `bg-muted/50 border-t` (the `DialogFooter`/`CardFooter`
   treatment the app already uses for a footer band). Secondary actions (Import CSV,
   Transfer, Copy last period) stay in the header or move into one `⋯`. Budgets docks
   `Plan this period` / `Review this period's plan` — the page's real primary action.
   The Dashboard's `Start payday check-in` stays in its card (it *is* the card's
   content; see M10 for making that card cheaper). **Not a FAB**: a round floating
   button with a drop shadow is the skill's consumer idiom and the loudest element it
   would introduce; a docked toolbar row is the platform's quieter equivalent and uses
   surfaces Cadence already has.

Cost: 56px more bottom chrome on four list pages. With M1 the total bottom chrome there
is ~105px + safe area on a 667px screen, which is what Mail and Notes spend for the same
reason. On the Dashboard and Reports there is no dock.

**Structure or visual?** Structural (placement) plus sizes. No colour, no new surface
beyond the footer band already in the system.

---

### M6 · Inbox rows collapse at phone width: an 18px-wide title and one word per line — **high conviction, small fix**

| | |
|---|---|
| **Where** | `src/components/inbox/insight-list.tsx:79-128` — `li` is `flex flex-wrap items-start gap-x-4 gap-y-2`; the text column is `min-w-0 flex-1` (`:85`); the actions are `flex shrink-0` (`:108`) |
| **Today** | The two buttons are 277px wide and cannot shrink; the text column can shrink to nothing, so it does: title container **18px** at 375 (73 at 430), the title truncated to "(", the `dl` evidence broken one token per line ("5, / May / 8, / 2026 / to / Sep …"), each insight **363px tall**. The page that exists to be glanced at is unreadable on the device it is most likely glanced at on. |
| **Principle** | Skill: hierarchy — "making all information the same visual weight" and "emphasising labels over values"; here the values have no room at all. `apple-design` §16.7 craft: "layouts that break … read as carelessness". |

**Recommendation.** `flex-col sm:flex-row` on the `li`; the text block takes the full
width, the action row sits under it (Open as `outline`, Dismiss as `ghost`, both 44px on a
phone), the `dl` becomes `grid grid-cols-[auto_1fr] gap-x-2` so labels and values align
in two columns instead of a wrapping flex run. On a phone the whole row can be the link
to `actionHref` — Open is the row's purpose — with Dismiss the only separate control.
The severity dot, evidence and source line all stay.

**Structure or visual?** Structure only; the fix is three class changes.

---

### M7 · Recurring row badges do not wrap, so the name truncates to eight characters — **medium conviction, small fix**

| | |
|---|---|
| **Where** | `src/components/recurring/recurring-list.tsx:124-158` — `flex items-center gap-2` holding a `truncate` name and up to three `rounded-full` pills that have no `whitespace-nowrap` |
| **Today** | "Laptop - 6 installments" renders as **"Laptop - 6…"** (80px) beside pills that have wrapped internally to three lines each (58×47 "4 / payments / left", 42×47 "Still / on / track"). The row that most needs to be read — a tracked plan and its viability verdict — is the one that breaks. |
| **Principle** | Skill: relationship-based spacing and hierarchy; the name is the primary, the pills secondary. |

**Recommendation.** Name on line 1 at full width; pills move to the start of the meta
line (line 2) with `whitespace-nowrap`, wrapping *as a group* before the frequency text.
The amount column is unchanged. Equivalent fix for the same pattern in the Inbox title
row (`insight-list.tsx:86-95`) once M6 lands.

**Structure or visual?** Structure only.

---

### M8 · The Transactions filter block is always expanded; the ledger starts 438px down a 667px screen — **medium conviction**

| | |
|---|---|
| **Where** | `src/components/transactions/transaction-filters.tsx:59-178` (two-column grid below `sm`, seven controls), rendered at `transactions/page.tsx:143-156` above the list |
| **Today** | Title + summary + three action buttons + search + four selects + two date fields, then the table begins at y = 438. After the sticky 106px header, the first screen shows two rows of the ledger. The filters are used sometimes; the ledger is why the page is opened. |
| **Principle** | Skill: F-pattern and "what's the one thing they should notice first?" — the transactions; anti-pattern "hiding key content behind banners". `apple-design` §16.6: "show the common path first, advanced options one level deeper". |

**Recommendation.** On a phone: the search field stays inline (it is the filter people
reach for), and the five other controls move behind a `Filters` button carrying a count
badge when any are active, opening in an M4 sheet with the same five controls stacked at
full width and an `Apply`/`Clear` footer. Active filters render as removable chips
between the search field and the list so state is never hidden. From `sm` up nothing
changes. The summary line ("136 records · $12,191.72 out, $22,532.00 in") stays — it is
the page's one figure.

**Structure or visual?** Structure only; the chip uses the existing `Badge`.

---

### M9 · 106px of sticky chrome on every screen, and four utility controls outrank the page — **medium conviction, mostly resolved by M1**

| | |
|---|---|
| **Where** | `src/components/shell/app-shell.tsx:62-92` — `h-14` bar plus the `md:hidden` nav strip; `:82-87` currency, language, theme and lock controls; `:65-71` `PeriodRail` hidden below `sm` |
| **Today** | 16% of a 375×667 viewport is chrome that scrolls with nothing. The period label and days-left — the app's clock — share the bar with four controls, three of which (language, theme, lock) are set once or used rarely. The `PeriodRail`, the app's own mark and the fastest read of "where am I in the period", is the one thing hidden. |
| **Principle** | Skill: information density by user stage — a returning user's header should be routine-focused; `apple-design` §16.6 simplicity, §16 wayfinding. |

**Recommendation.** With M1 the strip leaves and the header is 56px. Use the room for
the compact `PeriodRail` (64px) beside the label. Keep the currency switcher (a
two-currency ledger switches display currency often enough) and Lock (one tap to
security). Language and theme move into Settings on a phone as two rows — a relocation
of controls that already exist, not new content; they stay in the header from `md`.
Add `<meta name="theme-color">` per scheme via a `viewport` export (see M16) so Safari's
own chrome takes `--background` and the 56px reads as part of the page rather than a
bar under a different-coloured bar.

**Structure or visual?** Structural. The rail is an existing component; `theme-color`
*is* the palette.

---

### M10 · The Dashboard on a phone: the number that is the reason to open the app lands on the fold — **medium conviction**

| | |
|---|---|
| **Where** | `src/app/(app)/page.tsx:77-148` (order: alerts, check-in card, hero, monthly pace, goals + upcoming); `dashboard/payday-checkin-card.tsx:68-91` (the unconfirmed prompt: title, two-line description, two buttons ≈ 180px) |
| **Today** | Header 106 + padding 24 + prompt card ≈ 180 → the 48px `safe to spend per day` figure spans y 443–491 of 667: on the first screen, with the number's own context ("$1,768.74 left for the rest of this period") below the fold. At 430 it sits at 428 of 932 — fine. Page is 3.0 screens; the Goals heading is at 1,268 and the "Next 7 days" card at 1,804 — the list of what is about to leave the account is the last thing on the page. |
| **Principle** | Skill: "what's the one thing they should notice first?"; F-pattern; personalisation by stage ("returning users: routine-focused"). `apple-design` §16.6 hierarchy by order; `DESIGN_FINDINGS` F4 already ordered this page by state for the same reason. |

F4 was right to lead with the prompt while the check-in is unconfirmed; the prompt
carries the page's primary action. The phone problem is what the prompt *costs*, not
where it sits.

**Recommendation.**

1. **Compact the prompt on a phone**: one row — title left, `Start payday check-in`
   right, the description dropped (Step 1 says the same thing), `Not now` as an `×` on
   the row. ~64px instead of ~180. Combined with M1/M9 the hero figure moves from y 443
   to roughly 320.
2. **Order for the daily question.** After the hero, a phone reader wants "what is about
   to hit" before "how are my goals": on a phone render `Next 7 days` second, then
   Monthly pace, then Goals. Desktop keeps the two-column layout. The user has
   explicitly allowed a different layout as long as it is the same content; this is the
   same five blocks in a different order below `lg`.
3. Goals cards stack at full width already; nothing to do.

**Structure or visual?** Structure only.

---

### M11 · Afford on a phone: the verdict is 2.5 screens below the button, the decision 6 screens down — **medium conviction**

| | |
|---|---|
| **Where** | `src/components/afford/afford-calculator.tsx:161` (`lg:grid-cols-[5fr_7fr]` — form and schedule stack on a phone), `:290-294` (`Check affordability`), `afford-results.tsx:102-125` (verdict alert), `:378-385` (`Add later` / `I bought this`) |
| **Today** | Form card (≈ 620px), schedule card (≈ 450px), then the button at y ≈ 1,410; after evaluation the verdict alert appears at y 1,478, the two tables (M2), the shortfall list, the projection, and the decision buttons at the foot of a 3,889px page. Nothing scrolls the user to the verdict they just asked for. |
| **Principle** | Skill: "reduce friction to the goal", thumb-zone CTAs, "order/status tracking: open with a confident status message". `apple-design` §16 feedback: completion must be confirmed where the user is looking. |

**Recommendation.** On a phone: (a) after evaluation, scroll the verdict alert into
view and mark it `aria-live="polite"`; (b) the verdict becomes a docked strip (M5's
row) — `Viable` / `Not viable` in the status colour with `Add later` and `I bought this`
beside it — so the decision and its action share the thumb zone and stay visible while
the user reads the per-period cards above; the acknowledgement checkbox for a failing
verdict sits in the strip's expanded state; (c) the schedule card collapses to its total
line once a verdict exists (the schedule is repeated inside the verdict). Nothing about
what is computed or shown changes.

**Structure or visual?** Structure only; the strip uses `--good`/`--critical` exactly as
the alert does today.

---

### M12 · Loading and empty states: a tap that produces nothing, and an empty state that says "yet" about a filter miss — **medium conviction**

| | |
|---|---|
| **Where** | `src/app/(app)/layout.tsx:8` (`force-dynamic`), no `loading.tsx` anywhere under `src/app`, `ui/skeleton.tsx` unused; `transactions/page.tsx:168-172` + `en.ts:314-315` ("Nothing here yet" / "No transactions match these filters."); `stat.tsx:25-50` (`EmptyState`) |
| **Today** | Every route is dynamic and none has a loading boundary, so a tab tap holds the old page until the new one has been rendered on the server — on a phone connection that is a second or more of nothing, which reads as a missed tap and produces a second tap. A filtered-empty Transactions list is headed "Nothing here yet" while the summary line above it says 136 records exist, and the `Clear` control sits in the filter block above rather than with the message. |
| **Principle** | Skill, Step 5: "design error states, empty states, loading states"; "turn empty states into opportunities with guidance and a CTA"; "use delays as opportunities … instead of dead space". `apple-design` §1 response ("the moment lag appears, directness falls off a cliff"), §16 feedback: expose ongoing status. |

**Recommendation.** (a) `src/app/(app)/loading.tsx`: the page-frame skeleton — a title
bar, a description line, two card outlines — from the existing `Skeleton` primitive
(`animate-pulse bg-muted`; reduced motion already flattens it via the global rule).
Because it sits under the layout, the header and tab bar stay put and only the content
area swaps. (b) Tabs use `useLinkStatus` (`next/link`, documented in
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-link-status.md`)
for a 150ms opacity dip on the tapped tab, which is the docs' own recommendation for
dynamic routes without an instant fallback. (c) The filtered-empty state gets its own
title without "yet" and carries the `Clear filters` action inside the box; the
never-had-anything state keeps "Nothing here yet" and its `Go to accounts` action. The
`EmptyState` component itself — dashed border, one line, one button — is correct and is
not gaining an illustration (Part 2).

**Structure or visual?** Structural, plus one skeleton built from an existing primitive.

---

### M13 · 11px hint text carries real information on a phone — **medium conviction, and a named partial conflict**

| | |
|---|---|
| **Where** | `text-[0.6875rem]` at 32 sites in 20 files — Upcoming dates ("Sep 20 · in 2 days", `dashboard/upcoming-list.tsx`), "3 items due before Sep 30" (`period-hero.tsx:157`), every Recurring meta line (`recurring-list.tsx:159`), the native-currency figure (`transaction-table.tsx:73`), Inbox evidence (`insight-list.tsx:96,106`) |
| **Today** | The Dashboard uses ten distinct sizes; the Inbox renders 22 of its 27 text nodes at 11px; the eyebrow is 10px. The skill's rule is "maximum 4 font sizes and 2 weights". |
| **Principle** | Skill typography; Apple's HIG floor of 11pt for any text a user must read; `apple-design` §15 (respect the user's text size — sizes are in `rem`, so they do scale). |

**Where the skill is not followed:** Cadence's scale is a designed hierarchy —
eyebrow (10px mono caps, +0.14em), figure (14–48px mono with size-specific tracking),
body (14), hint (11–12) — and `DESIGN_FINDINGS` already defended the 10px eyebrow on
contrast and purpose. Collapsing it to four sizes would remove distinctions the app
relies on. The "4 sizes" rule is a consumer-app simplification and is not adopted
(Part 2). Weights are 400/500/600, already inside the skill's own limit.

**Where the skill is right:** at arm's length on a phone the 11px hint line is the
smallest *informational* text in the app and, on the Inbox and Recurring pages, most of
the text. Eyebrows are labels above a figure and read larger than their size (caps,
tracked, mono); hints are sentences.

**Recommendation.** A phone floor for hints only: a `text-hint` utility resolving to
`text-xs sm:text-[0.6875rem]` (12px below `sm`, unchanged above), applied at the 32
sites. `.eyebrow` and `.figure-sm` do not move. The 10px `text-[0.625rem]` badge labels
(22 sites) go to 11px on a phone by the same route.

**Structure or visual?** Visual — size only, no colour, no weight, no new face; within
the type system as designed.

---

### M14 · Budgets' period stepper wraps into two rows at 375 — **low-medium conviction, small fix**

| | |
|---|---|
| **Where** | `src/app/(app)/budgets/page.tsx:142-161` — `flex flex-wrap items-center gap-2` holding `‹ Sep 1-15`, the long label, `Oct 1-15 ›` and, off the current period, `Back to now` |
| **Today** | At 375 the previous-period button and the label share a row and the next-period button drops to a second (y 278 vs 318); at 430 they fit. The two controls that step the period are 32px and separated vertically by the label between them. |
| **Principle** | Skill: rhythm and consistent spacing; `apple-design` §16 grouping & mapping — two controls that do opposite things should sit at opposite ends of the thing they change. |

**Recommendation.** `grid grid-cols-[auto_1fr_auto] items-center`: chevron-only
`icon` buttons (44px on a phone, the neighbouring period names as `aria-label`s and
`title`s) at each end, the `longLabel` centred, `Back to now` as a ghost link under the
label when off the current period. From `sm` the labelled buttons return.

**Structure or visual?** Structure only.

---

### M15 · Reports: the trend chart's figures are hover/focus-only and its six labels wrap — **low conviction, first to drop**

| | |
|---|---|
| **Where** | `src/components/reports/trend-chart.tsx:37-60` (tooltip on `group-hover`/`group-focus`, bars `tabIndex={0}`), `:75-89` (period labels) |
| **Today** | The charts are the best-translated part of the app — `CategoryBars` is a list and the trend is CSS. But on touch there is no hover; a tap focuses a bar and shows the tooltip, with no affordance that bars are tappable and a second tap elsewhere needed to dismiss. At 375 the six labels wrap ("Aug 16-" / "31"). |
| **Principle** | Skill: "expose content directly instead of hiding behind taps"; "use monospace for large numbers". |

**Recommendation.** On a phone, print each bar's whole-dollar figure above it in
`figure figure-sm` (`$2,007` fits a 50px bar; the exact figure stays in the tooltip and
the `aria-label` — no rounding anywhere that is not visibly rounded), and shorten the
axis labels to the period's short form on a phone. Nothing else moves.

**Structure or visual?** Visual — six small labels in an existing class.

---

### M16 · Installability basics: no manifest, no home-screen icon, no `theme-color`, no safe-area handling — **low-medium conviction, cheap**

| | |
|---|---|
| **Where** | `src/app/layout.tsx:26-29` (`metadata` only; no `viewport` export, no `manifest.ts`); measured `<head>`: viewport = Next's default `width=device-width, initial-scale=1`, `theme-color` absent, `manifest` absent, `apple-touch-icon` absent; no `env(safe-area-inset-*)` anywhere in `src` |
| **Today** | "Add to Home Screen" produces a screenshot icon and opens in Safari chrome; the browser bar is white over a near-black app in dark mode; a bottom tab bar (M1) or docked row (M5) would sit under the home indicator on notched phones. `README.md:580` already states the position: no native app, the responsive web app is the mobile app — so the web app should install like one. |
| **Principle** | `apple-design` §16.4 familiarity, §16.7 craft. The skill assumes a native shell and says nothing here; this is the web-specific floor under everything above it. |

**Recommendation.** `src/app/manifest.ts` (`MetadataRoute.Manifest`, documented in
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md`)
with `display: "standalone"`, `background_color`/`theme_color` from `--background`, and
icons drawn from the `PeriodRail` mark; a `viewport` export (`generate-viewport.md`)
with `themeColor` per colour scheme and `viewportFit: "cover"`; `env(safe-area-inset-bottom)`
on whatever chrome M1/M4/M5 dock to the bottom edge. Standalone mode removes the
browser's back button, which makes M1's tab bar and the existing in-page back links the
only way out — another reason M1 comes first.

**Structure or visual?** Neither in the app itself; `theme-color` is the existing
palette applied to the browser.

---

## Part 2 — Where the skill and Cadence disagree, and Cadence wins

Named explicitly, as asked. None of these is adopted in any finding above.

| Skill guidance | Cadence's position | Why Cadence wins here |
|---|---|---|
| **Gradients, glow behind key elements, glassmorphism "where appropriate"** (Step 5, Implementation notes) | Achromatic ground, one teal for wayfinding, one `backdrop-filter` surface, no Liquid Glass — `globals.css:7-14`, `DESIGN_FINDINGS` Part 3 | A glow or gradient puts hue behind a status ramp whose colours *mean* good/warning/critical. In a money tool that is a legibility bug, not decoration. M1's tab bar reuses the header's existing material precisely so no new translucent class is introduced. |
| **60/30/10 with the accent on CTAs, 5% accent tints on secondary buttons and borders** | Teal is used "only for wayfinding and the current-day marker" (`globals.css:10-11`); primary buttons are already the one CTA use | Spreading the accent to secondary surfaces at 5% would make teal ambient rather than meaningful. Active tabs and the wizard's progress rail use `bg-primary` because both *are* wayfinding. |
| **Peak-End: celebrate the peak with sparkle, badges, bounce, "you showed up today"** (Step 4) | `ANIMATION_FINDINGS` #4 — the one licensed delight moment (a goal reached) is a 520ms meter fill and a line that lands afterwards; no confetti | The wizard's confirm is the app's most consequential commit. Its correct "ending" is the Dashboard hero and confirmed-plan card updating — the skill's own "summary card" ending, minus the sparkle. M3 keeps the toast as it is. |
| **Tinted, soft drop shadows; white inner shadows on buttons** | Cards are `ring-1 ring-foreground/10` on a flat ground; no shadow vocabulary exists | Cadence separates surfaces by a hairline, not by elevation. The docked rows in M5/M11 use the existing `border-t bg-muted/50` band for that reason. |
| **`rounded-2xl` / `rounded-3xl` for a "modern card aesthetic"** | `--radius: 0.6rem` with a fixed scale (`globals.css:50-56,61`) | The sheet in M4 keeps `rounded-t-xl` (≈ 13px). A 24–32px radius is a different product. |
| **Icons, emojis, illustrations and imagery to make information digestible; illustrated empty states** | Lucide glyphs at 16px, colour dots for categories, no imagery; `EmptyState` is a dashed box with a sentence and a button | The information here is figures; an illustration between the user and a number is noise. M12 improves the empty state's *copy and action*, not its picture. |
| **Maximum 4 font sizes, hierarchy through opacity** | A designed five-tier scale (eyebrow / figure / body / hint / display) with size-specific tracking (`globals.css:212-240`), hierarchy through weight and face | M13 adopts the *floor* the HIG and the skill agree on (11pt) and rejects the ceiling. |
| **Finance apps: blue-dominant palettes; "tactile" 3D card flips and draggable charts (Revolut)** | Cool near-black and a single desaturated teal; charts are static CSS | The palette is the identity. Draggable charts would be gesture work the Function test in `ANIMATION_FINDINGS` already rejected for these figures. |
| **"Don't hide content behind taps"** vs. M3's collapsed account blocks and M8's filter sheet | Adopted in M2 (tables), M6, M10, M15; traded away in M3 §4 and M8 | Where the alternative is seven screens inside a modal, the collapsed row keeps the *verdict* visible and folds only the controls. Filters are not content. Both are flagged inside their findings. |

Also not adopted, without conflict: "sliders/scroll wheels for one-time setup" (nothing
in Cadence is set once in a way a wheel would help), "smarter search with trending
items" (a personal ledger has no trending), the "Vanity Mirror" sharing pattern.

---

## Part 3 — Rejected candidates

Considered and deliberately left alone.

| Candidate | Where | Why rejected |
|---|---|---|
| Swipe-to-delete / swipe-to-edit on ledger rows | `transaction-table.tsx`, `recurring-list.tsx` | A swipe action needs 1:1 tracking, velocity hand-off and a threshold (`apple-design` §2–§6, §10) or it feels broken, and delete is the one action that should not be a flick away on a ledger. M2's tap-row-to-edit plus the `⋯` menu covers it. |
| A hamburger drawer for the nav | `app-shell.tsx:89-91` | Hides every destination behind a top-left tap — the opposite corner from the thumb — and removes the always-visible "where am I". Worse than the strip. |
| A floating action button | Transactions, Goals, Recurring, Accounts | The skill's default and the loudest element it would add: round, shadowed, floating over content. M5's docked row does the same job in the app's own footer band. |
| Replacing the row `⋯` menu with a bottom action sheet | `transaction-table.tsx:244-304`, `recurring-list.tsx:180-231` | The Radix menu opens anchored to its trigger (`apple-design` §7) and holds three items; a sheet for three items is more travel, not less. Only the trigger's size changes (M5). |
| Pull-to-refresh | every page | Server components re-render on navigation; there is nothing to refresh that a tab tap does not. |
| Haptics on confirm / on the goal-reached note | `payday-checkin-dialog.tsx`, `goal-achieved.tsx` | `apple-design` §13 utility: reserve feedback for meaningful moments — but the Vibration API is not on iOS Safari, so it would be Android-only feedback for a cross-platform moment. |
| Horizontal card carousels for goals or accounts | `goals/page.tsx:98`, `page.tsx:112` | Stacking is more scannable than swiping for three or four items, and carousels hide count. |
| Hiding Monthly pace or Goals from the phone Dashboard | `page.tsx:87-147` | Different density is allowed, dropping content is not; M10 reorders instead. |
| Collapsing the Recurring "Looks recurring" section on a phone | `recurring/page.tsx:94-111` | It is first because it needs action and disappears when handled — the right priority on any screen. |
| Sticky `<thead>` on the remaining tables | Afford projection, Accounts | Two tables survive M2 and both are short. |
| A separate mobile route tree or user-agent branch | — | Every finding above is a breakpoint decision inside the existing components; a second tree would fork the content the user asked to keep identical. |

---

## Part 4 — Verdict

**Is Cadence's phone experience "the desktop, shrunk"? Yes — and the parts that shrink
badly are containers, not content.** The figures, the copy, the palette, the type, the
charts and the empty/error states all hold up at 375px without change. What does not
hold up is structural: a horizontal strip standing in for a tab bar (M1), `<table>` where
a phone needs a list (M2), a centred modal where a phone needs a sheet (M3, M4), and a
32px target where a thumb needs 44 (M5). Those four are where the work is; M6–M16 are
either consequences of them (M9, M11, M16), or small breakages that a phone exposed
(M6, M7, M14) and a phone-specific floor on things the app already does well (M12, M13,
M15).

**Do it in this order:** M1 (the tab bar is the frame everything else docks to, and the
one change that makes standalone mode navigable), then M2 (the amount column is
off-screen on the ledger of a finance app — nothing else on this list matters to a user
who cannot see what they spent), then M4 (one file, every form), then M3 (the wizard is
used twice a month, but it is the most consequential screen and the worst-fitting one),
then M5. M6 and M7 are afternoon fixes and should not wait for the rest.

**Does it stay unmistakably Cadence?** Every recommendation is made of tokens, primitives
and idioms already in the codebase: the header's material, the sidebar's teal marker, the
`PeriodRail`'s blocks, the `DialogFooter` band, the `Skeleton`, the `eyebrow` and
`figure` classes, the existing radius, the existing dictionary. Nothing gains a gradient,
a glow, a shadow, a sparkle, a picture or a new colour. The skill was useful for exactly
what the brief said it would be — where the thumb is, what a table cannot do, how many
items a bar can hold, how big a target must be — and its aesthetics were declined at
every point they were offered, in Part 2, by name.
