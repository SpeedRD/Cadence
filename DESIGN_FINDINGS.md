# Cadence — Visual Design Audit

Standard: the `apple-design` skill (§12 Materials & depth, §14 reduced transparency,
§15 Typography, §16 Design foundations). Motion is explicitly out of scope — see
`ANIMATION_FINDINGS.md`, already implemented. Read-only pass; no code changed.

**Summary up front:** the type system is one class away from correct, the materials
story is already right and needs hardening rather than expansion, and full Liquid
Glass earns nothing here. Six findings proposed, thirteen candidates rejected.

---

## Part 1 — Findings

### F1 · `.figure` uses one letter-spacing across a 4.4× size range — **high conviction**

| | |
|---|---|
| **Where** | `src/app/globals.css:203` |
| **Today** | `.figure { @apply font-mono tabular-nums tracking-tight; }` — `tracking-tight` resolves to `-0.025em` (`node_modules/tailwindcss/theme.css:385`). |
| **Range it covers** | 48px (`src/components/dashboard/period-hero.tsx:70`), 30px (`src/app/(app)/goals/[id]/page.tsx:112`), 24px (`period-hero.tsx:127`), 20px (`src/components/stat.tsx:19`, `src/app/(app)/goals/page.tsx:116`), 18px (`src/components/dashboard/goal-card.tsx:34`), 16px (`period-hero.tsx:154,163`), 14px (~20 call sites), 12px (`src/components/transactions/transaction-table.tsx:113`), 11px (`transaction-table.tsx:66`, `goals/page.tsx:128`, `src/app/(app)/accounts/page.tsx:154`). |
| **Principle** | §15: "Tracking is size-specific — never one value for all sizes. Large display text wants negative tracking; small text wants slightly positive. A fixed `letter-spacing` is wrong somewhere." |

This is the app's single clearest typographic violation, and it is worse than the
generic case because `.figure` is monospace. IBM Plex Mono's advance widths are
already fixed and tuned; `-0.025em` at 11px removes ~0.28px per gap from a face
that has no room to give, closing exactly the intercharacter space that keeps
`8`/`0`/`6` apart on a figure being checked against a bank statement. At 48px the
same value is too loose — a 48px display figure wants roughly twice that.

**Recommendation** — make `.figure` neutral and let the three genuinely large call
sites opt in. Exact values:

```css
/* globals.css:202-204 */
.figure {
  @apply font-mono tabular-nums;
  letter-spacing: 0;            /* Plex Mono's own metrics, 14–20px */
}
.figure-sm  { letter-spacing:  0.01em; }  /* ≤ 12px  — the small-text bump */
.figure-lg  { letter-spacing: -0.015em; } /* 24–30px */
.figure-xl  { letter-spacing: -0.025em; } /* 36px+   */
```

Call-site changes are small: `period-hero.tsx:70` → `figure figure-xl`,
`period-hero.tsx:127` and `goals/[id]/page.tsx:112` → `figure figure-lg`, and the
11–12px sites listed above → `figure figure-sm`. Everything at 14–20px — the large
majority — just loses the tracking and needs no edit.

The `.figure-sm` positive bump is the lower-conviction half. If only one change is
made, make it `letter-spacing: 0` on the base class plus `figure-xl` on the 48px
hero figure; that captures most of the benefit.

---

### F2 · Heading treatment is keyed to the HTML tag, not the role, so card titles and dialog titles diverge — **high conviction**

| | |
|---|---|
| **Where** | `src/app/globals.css:180-187`, `src/components/ui/card.tsx:41`, `src/components/ui/dialog.tsx:139` |
| **Today** | `h1, h2, h3, h4 { font-family: var(--font-heading); font-variation-settings: "wdth" 112; letter-spacing: -0.012em; }` |
| **Principle** | §16.7 Craft: "things that look the same must behave the same"; §15: build hierarchy from weight + size + leading as a set. |

`DialogTitle` renders Radix's `Primitive.h2`
(`node_modules/@radix-ui/react-dialog/dist/index.mjs:255`), so it picks up the rule.
`CardTitle` is a `<div>` (`card.tsx:36-47`), so it does not — despite carrying the
same `font-heading text-base font-medium`. The result: two 16px Archivo titles that
render at different widths (112 vs 100) and different tracking (`-0.012em` vs `0`),
side by side on the dashboard — `CardTitle` "Next 14 days" (`src/app/(app)/page.tsx:111`)
against the `<h2>` "Goals" (`page.tsx:79`). Nobody chose this; it fell out of an
element-selector.

**Recommendation** — key the treatment to the role and make the tracking size-specific
while you are in there:

```css
/* globals.css:180-187 */
h1, h2, h3, h4,
[data-slot="card-title"] {
  font-family: var(--font-heading);
  font-variation-settings: "wdth" 112;
  letter-spacing: -0.005em;    /* the 14–16px case, which is most of them */
}
h1 { letter-spacing: -0.02em; } /* 24px (page-header.tsx:22), 30px (pin-gate.tsx:100) */
```

`-0.012em` was a single value doing the same double duty as F1, just over a narrower
range (30px → 14px). Splitting it costs one extra rule.

---

### F3 · The app's one translucent surface has no reduced-transparency fallback and no support guard — **medium-high conviction**

| | |
|---|---|
| **Where** | `src/components/shell/app-shell.tsx:53`; `src/app/globals.css:307-321`; compare `src/components/ui/dialog.tsx:42` |
| **Today** | Header: `sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur`. `globals.css` has a considered `prefers-reduced-motion` block and **no** `prefers-reduced-transparency` block. |
| **Principle** | §14: "`prefers-reduced-transparency: reduce` — make translucent surfaces frostier/solid: raise background opacity, drop the blur." |

Two separate gaps, both small and both real:

1. **No reduced-transparency handling exists anywhere in the codebase.** The header
   is a genuine floating layer with dense financial content scrolling under it —
   precisely the surface that setting exists for.
2. **Inconsistent support guard.** `dialog.tsx:42` correctly writes
   `supports-backdrop-filter:backdrop-blur-xs`; `app-shell.tsx:53` writes a bare
   `backdrop-blur`. Where `backdrop-filter` is unsupported the header falls back to
   85% opacity with no blur, and rows ghost through it unblurred. Same codebase, two
   answers.

**Recommendation — plain `backdrop-filter`, explicitly not Liquid Glass.** The header
is already the light-touch §12 treatment and it is the correct one: it is a thin strip
of chrome over a neutral near-black ground, with nothing behind it worth refracting.
Keep it as it is and add the two guards:

```css
/* globals.css — new block, alongside the reduced-motion one */
@media (prefers-reduced-transparency: reduce) {
  [data-slot="dialog-overlay"] { backdrop-filter: none; background: rgb(0 0 0 / 0.35); }
  .app-header { background: var(--background); backdrop-filter: none; }
}
```

…with `app-shell.tsx:53` gaining that `app-header` hook and swapping `backdrop-blur`
for `supports-backdrop-filter:backdrop-blur` (matching `dialog.tsx:42`). Behaviour
under `prefers-reduced-transparency: reduce`: header becomes fully opaque
`--background`, blur dropped; dialog overlay drops its 2px blur and compensates with
a heavier 35% scrim so "dim to focus" survives without the blur doing the work.

---

### F4 · The confirmed payday summary permanently outranks the hero on the dashboard — **medium-high conviction**

| | |
|---|---|
| **Where** | `src/app/(app)/page.tsx:62-68`; `src/components/dashboard/payday-checkin-card.tsx:36-66` |
| **Today** | `<PaydayCheckinCard>` renders above `<PeriodHero>` unconditionally. |
| **Principle** | §16.6 Simplicity: "use hierarchy — order, spacing, contrast — so the most important thing is the most obvious." |

Before the check-in is confirmed, this card is a prompt with a primary action, and
being first is right. **After** confirmation it switches to a read-only receipt
(`payday-checkin-card.tsx:39-64`: four figures in a `CardDescription` plus a "review
plan" outline button) — and it keeps that first position for the rest of the period.
So on most days of most periods, the app's single most important number — "safe to
spend per day", 48px, `period-hero.tsx:70`, the reason to open Cadence daily — is the
second thing on the page, below a summary of a decision already made.

**Recommendation** — order by state, not by component: keep the unconfirmed prompt
above `PeriodHero`; render the confirmed summary below it. One conditional in
`page.tsx`, no visual change to either card. This is a pure hierarchy fix and makes
the app more of an instrument, not less.

---

### F5 · Raw native checkboxes gate the app's most consequential commit — **medium conviction**

| | |
|---|---|
| **Where** | `src/components/payday/step-confirm.tsx:62-67` and `:75-80`; also `src/components/import/import-review.tsx:475,528` |
| **Today** | `<input type="checkbox" className="mt-0.5" />` — unstyled UA control. |
| **Principle** | §16.7 Craft: "Nothing is random — every spacing, timing and alignment value is a deliberate choice you can defend." |

`src/components/ui/` has `switch.tsx`, `select.tsx`, `input.tsx`, `textarea.tsx` — and
no `checkbox.tsx`. These two acknowledgements are what unlock a disabled
`SubmitButton` (`payday-checkin-dialog.tsx:231-232, 387-389`) when the user is
confirming a plan that overspends or leaves a zero buffer. The one control standing
between the user and a knowingly-underfunded period is the only element in the app
rendering at the operating system's defaults — it does not match the `Switch` beside
it in the same wizard (`step-commitments.tsx`), and it does not carry the app's focus
ring or 8px radius.

**Recommendation** — add a `Checkbox` primitive matching `switch.tsx`'s construction
(Radix `Checkbox`, `ring-1 ring-foreground/10`, `rounded-[min(var(--radius-md),6px)]`,
the same `focus-visible:ring-3 focus-visible:ring-ring/50` as `button.tsx:8`) and use
it at all four sites. No layout change, no new material, no size increase — the
acknowledgement stays a checkbox because a checkbox is the correct, familiar control
for "I understand" (§16.4 Familiarity). This is craft, not restyling.

---

### F6 · Nav label "Review" contradicts its own icon — **low conviction, cheap to fix**

| | |
|---|---|
| **Where** | `src/components/shell/nav-links.tsx:46`; label at `src/lib/i18n/en.ts:72` |
| **Today** | `{ href: "/review", label: t.review /* "Review" */, icon: Inbox }` |
| **Principle** | §16 tactical: "Direct, specific labels beat safe generic ones. Name nav items for their contents." |

The icon already says what the page is — an inbox of ingested transactions awaiting
approval, grouped by source (`src/app/(app)/review/page.tsx:97-116`). The label says
what you do there, which is the vaguer of the two, and the mismatch means the icon and
the word are describing different things.

**Recommendation** — "Inbox" (`en.ts:72` / `es.ts`), matching the icon and naming the
contents. Marked low conviction deliberately: "Review" is not confusing, only less
specific, and if the Spanish equivalent reads worse, leave both alone. This is the
weakest finding in the report and the first one to drop.

---

## Part 2 — Rejected candidates

Considered against apple-design and deliberately left alone.

**Materials & depth**

| Candidate | Where | Why rejected |
|---|---|---|
| Sidebar → translucent material | `app-shell.tsx:39` (`bg-sidebar`, opaque) | §12 is explicit that material weight encodes hierarchy: heavier materials separate *structural* regions, lighter ones mark *interactive/floating* elements. The sidebar is structural and permanent. Opaque is the correct answer, not a compromise. |
| Payday wizard footer → `backdrop-filter` | `dialog.tsx:116`, used at `payday-checkin-dialog.tsx:370` | Not a floating layer. It is a flex sibling inside `flex flex-col` `DialogContent`; the step div (`payday-checkin-dialog.tsx:288-292`) is the only scroller, so nothing ever passes beneath the footer. `backdrop-filter` there would blur `DialogContent`'s own flat opaque `bg-popover` — a literal no-op that costs a compositor layer. Its `bg-muted/50` tint over an opaque parent already does the separation job. |
| **Full Liquid Glass, anywhere** | — | See Part 3. Rejected on the skill's own Rule #1 precondition. |
| Header hairline → scroll edge gradient mask | `app-shell.tsx:53` (`border-b border-border/70`) | §12 prefers a fading edge to a 1px divider, but that rule optimises for calm consumer chrome. In an instrument panel the hairline *is* the statement that chrome ends and data begins; softening it makes the boundary ambiguous exactly where the user needs certainty about which numbers are live. Rejecting a stated apple-design preference on personality grounds — deliberately. |
| Vibrancy / legibility over the translucent header | `app-shell.tsx:53,64,67` | **Measured, not assumed.** Blending 85% `--background` over the busiest thing that can pass under it: over a card, `--muted-foreground` reads 6.86:1 and `--foreground` 16.79:1; over the brightest element in the dark palette (`--primary`, the teal period-rail marker) the 11px muted line still reads **5.22:1**. Above AA at every point on the scroll. §12's "don't use flat gray text over translucency" is aimed at surfaces that go far lighter than this one can. No change. |
| Light translucent surface stacked on another | swept `app-shell.tsx`, `dialog.tsx`, `dropdown-menu.tsx:46,247`, `select.tsx:72` | None exists. Every popover/menu/dialog is opaque `bg-popover` + `ring-1 ring-foreground/10`; the only two translucent layers (header, dialog overlay) never overlap. The on-sight violation both skills warn about is genuinely absent. |
| Mobile nav living inside the translucent header | `app-shell.tsx:80-82` | Looks like a material-weight inversion — nav is a heavy opaque sidebar on desktop and part of the lightest surface on mobile. But a translucent nav/tab bar is Apple's own pattern, and the active pill is a solid `bg-sidebar-accent` chip (`nav-links.tsx:68`), which is §12's "put colour on a solid layer, not the translucent foreground". Correct as built. |
| Sticky table headers as a new floating layer | `budgets/page.tsx:224-231`, `transaction-table.tsx`, `review-table.tsx` | No sticky `thead` exists today, so there is no opaque-surface-behaving-as-floating-layer to fix. Adding one is a feature request, not a materials finding, and it would spend a whole new material layer on one row of labels over the densest content in the app. |

**Typography**

| Candidate | Where | Why rejected |
|---|---|---|
| Leading does not track size inversely | `period-hero.tsx:70`, `card.tsx:41`, Tailwind scale | Already correct. Tailwind's size scale ships inverse leading (12px→1.33, 14px→1.43, 16px→1.5, 24px→1.33, 48px→1.0; `theme.css:347-364`), the 48px hero figure adds an explicit `leading-none`, and card titles use `leading-snug`. The 11px arbitrary sizes inherit 1.5 from preflight, which is *looser* than 12px's 1.33 — the right direction. Nothing to fix; §15's leading rule is satisfied by the defaults. |
| `.eyebrow` tracking | `globals.css:198-200` — 10px mono uppercase at `+0.14em` | Textbook-correct: positive tracking on small uppercase, and generous enough for a monospace caps setting. This is the app already doing size-specific tracking right, which is what makes F1 look like an oversight rather than a house style. |
| 10px eyebrow is too small for a daily money tool | `globals.css:199` | Contrast measured: `--muted-foreground` on `--card` is 6.43:1 dark / 5.86:1 light, both above AA. Sizes are in `rem` throughout, so it scales with the user's text setting (§15). It is small on purpose — it is a label on a figure, and the figure is what you read. |
| Widen the heading scale (h1 24px vs h2/CardTitle 16px) | `page-header.tsx:22`, `page.tsx:79`, `card.tsx:41` | Once F2 lands, section h2 and card title are separated by weight (semibold vs medium) and width axis, which is §15's "build hierarchy from weight + size + leading as a set, not size alone". Adding a size step would push cards apart and cost vertical rhythm in a dense grid. |
| `tracking-tight` on the wordmark | `app-shell.tsx:42` | Inconsistent with the heading value (`-0.025em` vs `-0.012em`), but it is a wordmark, not body hierarchy — a logotype is allowed its own tracking. |

**Hierarchy, grouping, labels**

| Candidate | Where | Why rejected |
|---|---|---|
| Nav item "Recurring" is an adjective without a noun | `nav-links.tsx:49` | Accurate: the page holds both subscriptions and contributions (`en.ts:62-65`). Any more specific label ("Subscriptions") would be *wrong*, and specificity that lies is worse than a correct umbrella. |
| Nav item "Dashboard" is a vague umbrella | `nav-links.tsx:44` | §16 warns against "Home"-type labels, but "Dashboard" names an instrument panel accurately, and it is the conventional term for this screen in every finance tool the user has used (§16.4 Familiarity). Renaming to "Today" or "Overview" would be novelty, not clarity. |
| Dashboard has no `<h1>` | `src/app/(app)/page.tsx` — first heading is the `<h2>` at :79 | Visually correct: the hero *is* the screen's identity, and a "Dashboard" title above it would be a label explaining what is already obvious (§16.6 — every element earns its place). Worth logging as a document-outline/a11y item separately; it is not a visual-design finding. |
| Controls placed away from what they affect | swept `budgets/page.tsx:245-273`, `goals/page.tsx:135-180`, `step-flexible.tsx:45-66`, `period-hero.tsx:117-170` | Mapping is sound everywhere checked. Budget inputs sit in the same row as the category's meter and spent figure; each goal's "Add" contribution button is inside that goal's card; each flexible-category amount input is beside its own suggestion. No control needs a label to explain what it acts on. |
| Information stripped so far the user has to guess | `period-hero.tsx:67-90`, `stat.tsx:17-22` | The opposite is true, correctly: the 48px figure is always paired with the total it derives from, and every `Stat` carries an eyebrow plus an optional hint. This is §16.6's "sometimes adding context simplifies", already applied. |
| Everything crammed with no primary path | `page.tsx:57-131` | The dashboard has one obvious focal point and a clear reading order. F4 is the one ordering defect; the layout itself is right. |
| Status ramp / series palette / `Meter` / `PeriodRail` | `globals.css:93-107,140-153`, `meter.tsx`, `period-rail.tsx` | Deliberate, documented (`globals.css:7-14`), colour-blind-safe, and status colour is kept out of the series set. Leave entirely alone. |

---

## Part 3 — Verdict

**How much visual-design change does Cadence need? Very little, and none of it structural.**
This app has already made the hard calls: the palette is documented and disciplined,
colour carries meaning and nothing else, the sidebar is correctly heavy and opaque, the
one piece of floating chrome is already a proper `backdrop-filter` layer with content
scrolling under it, no light translucent surface is stacked on another, mapping between
controls and their targets is sound throughout, and the leading is right by default.
The real work is about ten lines of CSS: `.figure` is one letter-spacing stretched
across 11px to 48px (F1), and the heading treatment is attached to an HTML tag instead
of a role so card titles silently fall out of it (F2). Everything else is hardening
(F3), one conditional reorder (F4), one missing primitive (F5) and one word (F6). If
only two things get done, do F1 and F2 — they are the difference between a type system
that was designed and one that mostly happened.

**Does full Liquid Glass — the `liquid-glass` skill, not plain `backdrop-filter` —
earn its cost anywhere in this app? No. Not on any surface, now or after the findings
above.**

Three reasons, in order of weight. First, the skill's own Rule #1 requires a coloured
ambient backdrop mesh as a precondition, and Cadence's ground is deliberately
achromatic — `--background: oklch(0.163 0.0095 248)`, chroma 0.0095, effectively
neutral (`globals.css:121`). Supplying that mesh means putting arbitrary hue behind the
fixed status ramp and the eight-hue categorical series, which directly contradicts the
contract written at `globals.css:7-14`: in this app colour *means* something —
good/warning/critical, and category identity — and nothing else is allowed to speak in
colour. A refracting surface that tints a `--critical` figure toward warm or a
`--good` figure toward cool is not a decoration here; it is a legibility bug in a tool
about real money. Second, refraction only pays off when there is something structured
worth bending — photography, artwork, a colourful map. What passes under Cadence's one
floating surface is grey-on-near-black tabular text, where refraction produces
distortion without information. Third, the two surfaces that could nominally host it
both fail on their own terms: the sidebar is a structural region that apple-design says
should read *heavier* than floating elements, and the payday wizard's footer is not a
floating layer at all — blurring there would blur the dialog's own opaque fill and
render exactly nothing.

The honest recommendation is the light-touch one: keep the single `backdrop-filter`
header the app already has, add its `prefers-reduced-transparency` fallback and support
guard (F3), and add no new translucent surfaces. Full Liquid Glass would make Cadence
look more like a consumer app and read less like a precise financial instrument —
which, by this audit's own standard, is a regression.
