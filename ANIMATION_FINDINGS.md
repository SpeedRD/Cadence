# Cadence — Animation Opportunity Audit

Read-only report. No source files were modified.
Method: `find-animation-opportunities` (the Gate, applied strictly), with `apple-design` as the house style for every recipe.

---

## Recon

**Stack.** Next.js 16.3.4 / React 19 / Tailwind v4 / `radix-ui` 1.6.7 / `tw-animate-css` / `sonner` / `next-themes`. No spring or motion library, and none is needed for anything proposed here — every recipe below is CSS.

**Existing motion vocabulary: effectively none.** `src/app/globals.css` defines colours, radii, fonts and a status ramp, but **zero easing or duration tokens**. All motion in the app currently runs on Tailwind's defaults (150ms, `cubic-bezier(0.4, 0, 0.2, 1)`) plus a hand-written `duration-100` on the Radix surfaces. There is no shared vocabulary for a recipe to extend, so one has to be established first — see *Prerequisites*.

**Personality.** Dark-first instrument panel: tabular figures, `.figure` / `.eyebrow` mono treatments, dense cards, daily use on real money. This is the profile that argues for *less* motion, and the audit is scored that way.

**The app is already better animated than the brief assumed.** The interesting result of the sweep is how much is correct today:

| Surface | Today | Assessment |
| --- | --- | --- |
| `ui/dialog.tsx:42,64` | Overlay fades; content fades + `zoom-in-95` → `zoom-out-95`, `duration-100`, symmetric open/closed | **Correct, leave alone.** Modals stay centred (correctly exempt from trigger anchoring), and 100ms is right for a surface opened many times a day. Do not lengthen this — confirm-delete especially. |
| `ui/select.tsx:72`, `ui/dropdown-menu.tsx:46,247` | Fade + `zoom-95` + 2px directional slide, anchored to `origin-(--radix-*-content-transform-origin)` | **Correct.** This is exactly the trigger-anchored spatial story `apple-design` §7 asks for, and Radix supplies the origin for free. Nothing to add — this covers the transaction filter bar and every category/account picker. |
| Toasts (`ui/sonner.tsx`) | Only colours and icons are overridden; enter/exit is sonner's own | **Correct.** Sonner already enters and exits along the same edge and supports swipe-to-dismiss. Every save path (`form-dialog.tsx:67`, `action-button.tsx:32`, `budget-amount-form.tsx:47`, `confirm-delete.tsx:53`) routes through it. Nothing to build. |
| `reports/trend-chart.tsx:49`, `monthly-trend-chart.tsx:44` | Tooltips cross-fade via `transition-opacity` (Tailwind default 150ms), reachable by `tabIndex` as well as hover | **Correct and inside the 125–200ms tooltip budget.** |
| `meter.tsx:47` | `transition-[width] duration-300` — fires when a goal/budget meter's value actually changes | Correct in kind. |
| `ui/switch.tsx:27`, `ui/tabs.tsx:69`, `auth/pin-gate.tsx:63` | All already transition | Correct. |

**A blocking constraint that must be fixed first.** `src/app/globals.css:201-207`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}
```

This is the "reduced motion means *zero* motion" antipattern (`apple-design` §14: reduced motion means a *gentler, non-vestibular* equivalent, not nothing). It also silently deletes every recipe below for users on that setting. It should be narrowed to kill `transform`-based motion while keeping short opacity cross-fades, which are the part that carries comprehension.

---

## Prerequisites

Both are one-time, and every recipe in the table depends on them.

**1. Add the shared easing vocabulary to `globals.css` (`:root`).** Recipes cite these by name rather than inlining approximations:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
```

**2. Narrow the reduced-motion block** so transforms are dropped but opacity survives:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    transition-property: opacity !important;   /* keep the cross-fade */
    transition-duration: 150ms !important;     /* gentler, not zero */
  }
}
```

---

## Part 1 — Opportunities

Four. Ordered by leverage.

| # | Location | Today | Purpose | Frequency | Suggested motion |
| --- | --- | --- | --- | --- | --- |
| 1 | `ui/button.tsx:8` | Press feedback exists (`active:not-aria-[haspopup]:translate-y-px`) but `transition-all` puts it on Tailwind's default **150ms ramp** — the nudge arrives ~150ms after the finger lands, and `transition-all` also drags width/box-shadow along | **Feedback** | Tens/day | Split transform out of the blanket transition so the press is instant and only the *release* eases: `transition: color 150ms, background-color 150ms, border-color 150ms, box-shadow 150ms; transition-property: …, transform; transition-duration: …, 140ms;` with `&:active { transform: translateY(1px); transition-duration: 0ms }`. Net effect: **0ms in on pointer-down, 140ms `var(--ease-out)` out on release.** Keep the existing 1px translate — do not add `scale()`; at tens/day this tier only tolerates near-imperceptible motion, and the app gets *faster*, not more animated. Reduced motion: transform drops out via the narrowed global rule, colour feedback remains. |
| 2 | `payday/payday-checkin-dialog.tsx:273-336` | Five bare `{step === N ? <StepX/> : null}` swaps inside one stable scroll container. Content teleports; nothing indicates whether the user moved forward or back | **Spatial consistency** (also *preventing a jarring change*) | Rare — ~2×/month, at payday | Track direction in a ref (`+1` on Next, `-1` on Back), expose it as `--step-dir: 8px | -8px`, and key the content wrapper on `step` so each step mounts fresh. Entry-only, via `@starting-style` (no JS, no library): `@starting-style { opacity: 0; transform: translateX(var(--step-dir)) }` with `transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out)`. **Deliberately no exit animation** — the outgoing step is not missed and an exit would delay the next step. 200ms sits inside the modal budget. Reduced motion: the translate drops, the 150ms opacity cross-fade survives and still marks the step change. |
| 3 | `payday/step-commitments.tsx:229`, `:274`; `payday/step-flexible.tsx:83`; `payday/step-confirm.tsx:59,70` | Four destructive/acknowledgement blocks that mount and unmount mid-interaction — a per-account below-buffer `Alert`, the zero-buffer warning, the over-allocation `Alert`, and the two acknowledgement checkboxes. Each **teleports in and shoves every row below it down** with no bridge | **Preventing a jarring change** | Rare — same payday session | One shared wrapper, `transition` (never `@keyframes` — these retarget on rapid toggles, and `step-flexible.tsx:83` fires on *keystroke* as an amount is typed): wrap in `display: grid; grid-template-rows: 0fr; transition: grid-template-rows 180ms var(--ease-out), opacity 180ms var(--ease-out); opacity: 0` → `grid-template-rows: 1fr; opacity: 1` when present, with `> *  { overflow: hidden; min-height: 0 }`. **Opacity only, no translate** — a warning that toggles mid-typing must not wobble the layout sideways. This is the one place a layout-animating property is worth it: it animates the *reflow itself*, which a plain fade would leave snapping. Small subtree, not in a scroll loop. Reduced motion: rows snap, opacity cross-fades. |
| 4 | `goals/page.tsx:137`, `dashboard/goal-card.tsx:50` | A goal crossing its target flips `achievedAt`, the meter lands on 100% and green "Fully funded" / "Reached" text replaces the pace line — **entirely flat.** The rarest, highest-emotion moment in the product, rendered as a text swap | **Delight** — the only tier where this is licensed, and it clearly qualifies | Rare — a handful of times a year | **Prerequisite:** `addContributionAction` (`server/actions/goals.ts:60-90`) returns a generic `done(t.contributionLogged)`; it must also return `justAchieved: true` when `recomputeGoalSaved` is what crossed the line. Without that flag the celebration would replay on *every page load* of an achieved goal — a frequency violation that would turn the best moment in the app into an irritation. Then, on that flag only: hold the meter's existing `transition-[width]` but stretch it to `520ms var(--ease-out)` for this one transition, and land the "Fully funded" line **after** it arrives — `transition: opacity 260ms var(--ease-out) 480ms; @starting-style { opacity: 0; transform: translateY(4px) }`. **No confetti, no bounce, no overshoot.** `apple-design` §16: delight is the result of getting the other seven right, not particles tacked on top — in a money app the restrained version reads as competence, the confetti version reads as a toy. Reduced motion: meter width snaps, the line cross-fades in at 260ms with no delay and no translate. |

---

## Part 2 — Rejected candidates

Everything below was considered and deliberately **not** suggested.

- **`reports/trend-chart.tsx:68` and `monthly-trend-chart.tsx:55` — growing bars from zero height on load.** **Rejected: Function.** This is spending data the user opened the page to read. Both are server components that render at final height; animating them means the first thing the user sees is a chart showing numbers that are *wrong*. The exact case the Function question exists for.

- **`meter.tsx:47` / the `.figure` money values — count-up animation on figures and meters.** **Rejected: Function, hardest.** A count-up displays incorrect currency amounts for 300ms in an app whose entire job is telling the user the correct amount. Non-negotiable in this product.

- **`shell/nav-links.tsx:91,99` — sliding the active-nav indicator between items ("magic line").** **Rejected: Frequency.** Core navigation, used many times a day; the existing `transition-opacity` cross-fade on the 2px marker is the right answer. Motion on the primary nav makes every page change feel slower.

- **`shell/app-shell.tsx:86` stale-rates banner and `dashboard/not-posting-alert.tsx:52`.** **Rejected: Frequency + Purpose.** Both are server-rendered and present at first paint on *every* page load while the condition holds — so an entrance would replay on each navigation, and there is no state change to bridge. (These read as conditional renders but are not client-side ones. `step-commitments.tsx` / `step-flexible.tsx` alerts qualify at #3 precisely because those *do* toggle live in response to the user.)

- **`payday-checkin-dialog.tsx:64` — animating the dialog's own height as it grows and shrinks between short step 1 and tall step 3.** **Rejected: Speed + Function.** A tall scroll-containing panel resizing under a fixed footer reads worse than an instant resize, and it cannot stay convincing inside the 300ms UI budget. Recipe #2 animates the *content*, which is the part that carries the meaning; let the frame snap.

- **`ui/dialog.tsx:64` — lengthening the dialog open/close beyond `duration-100`.** **Rejected: Frequency.** Transaction edit, recurring edit and confirm-delete are opened constantly. 100ms is correct; the temptation to make these feel "designed" is exactly what would make the app sluggish.

- **`auth/pin-gate.tsx:63` — a scale-pop as each PIN dot fills.** **Rejected: Feedback latency.** PIN entry is a fast keystroke sequence; feedback must be instant. The existing 150ms `transition-opacity` is already at the edge of acceptable and should not be built on.

- **Transaction table row enter/exit after a filter change (`transactions/transaction-table.tsx:112`, `transaction-filters.tsx:41`).** **Rejected: Function + Frequency.** Filtering is a rapid, repeated read operation; staggered rows would make each filter change feel slower and would animate the ledger the user is scanning.

---

## Part 3 — Verdict

**Cadence needs very little motion, and it is already close to right.** The Radix surfaces (dialogs, selects, dropdowns) are correctly animated and correctly *fast*; sonner handles toasts properly with no work required; the chart tooltips already cross-fade within budget. The genuine gaps are not "this app is too static" — they are three specific teleports inside the payday wizard, one mistimed press, and one emotional moment left flat. Everything else the sweep turned up was rejected, most of it on the Function question, which is the correct result for a dense finance tool used daily.

**Highest leverage is #1**, and not because it is the most interesting: `ui/button.tsx` is the single most-touched surface in the app, the press feedback is already *there* but arrives 150ms late, and the fix is a few characters of transition splitting that makes the whole product feel more responsive without adding any perceptible new motion. It is the change most consistent with the house style — `apple-design` §1 treats latency on the input path as the foundation everything else sits on. **#4 is the most valuable to get *right*** rather than merely done, and the thing that makes it right is the `justAchieved` flag; without it, skip the row entirely rather than shipping a celebration that replays.

Do the two prerequisites first — particularly narrowing the reduced-motion block, which currently deletes all four recipes for anyone on that setting.

**One adjacent, non-motion note surfaced by the sweep:** the wizard's scroll container (`payday-checkin-dialog.tsx:273`) is a single stable element across all five steps, so scroll position carries over — advance from a scrolled-down step 3 and step 4 opens part-way down. Keying that wrapper on `step` for recipe #2 fixes this as a side effect.

---

**Handoff.** Any row above can be turned into a self-contained implementation plan with `improve-animations plan <row>`.
