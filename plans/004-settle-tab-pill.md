# 004 — Settle the tab pill without overshoot

- **Status**: DONE (verified 2026-10-31)
- **Commit**: d5a91c7
- **Severity**: LOW
- **Category**: Purpose & frequency
- **Estimated scope**: 1 file (`dashboard/public/style.css`), ~10 lines removed

## Problem

Every tab activation runs a 200ms overshoot animation on the active pill (`style.css:793-804`):

```css
.nav-tab.active {
  color: var(--on-solid);
  background-color: var(--primary-solid);
  font-weight: 600;
  box-shadow: var(--shadow-primary-sm);
  animation: tabPillPop 0.2s var(--ease);
}
@keyframes tabPillPop {
  0% { transform: scale(0.96); }
  50% { transform: scale(1.02); }
  100% { transform: scale(1); }
}
```

Tab switching is a "tens of times per day" interaction, not a momentum gesture. The click has no velocity to justify overshoot, and the pill already changes background, text weight and shadow via the `--transition-fast` token. The pop also runs on top of the 240ms directional section slide (`style.css:1478-1493`), so one action produces two competing motions.

## Target

Remove the `animation` declaration and the `@keyframes tabPillPop` block. Keep everything else on `.nav-tab.active` and keep the press feedback:

```css
/* target — the pill changes state via color/background/shadow only */
.nav-tab.active {
  color: var(--on-solid);
  background-color: var(--primary-solid);
  font-weight: 600;
  box-shadow: var(--shadow-primary-sm);
}
```

` .nav-tab:active { transform: scale(0.96); }` (`style.css:790-792`) stays; that is the immediate press feedback.

No replacement animation is needed. If a future pass wants a non-overshoot settle, it must be a `0.985 → 1` transform with no value above 1; do not add that now.

## Repo conventions to follow

- The page's personality is "warm precision / instrument panel": no overshoot unless a gesture carried momentum (see the `--ease` comment at `style.css:193` and the card intro at 1306-1324).
- Tab state feedback already has a transition list via `--transition-fast` (`style.css:221-227`); do not add a second timing system.
- Keep the `@keyframes tabSlideInRight/Left` section transition untouched; it carries the direction semantics documented at `style.css:3770-3776`.

## Steps

1. In `style.css`, delete `animation: tabPillPop 0.2s var(--ease);` from `.nav-tab.active`.
2. Delete the `@keyframes tabPillPop` block immediately below it.
3. Confirm no other selector references `tabPillPop` (`grep -n "tabPillPop" dashboard/public`).
4. Run Verification.

## Boundaries

- Do NOT remove `.nav-tab:active { transform: scale(0.96); }`.
- Do NOT change `switchTab()` or the 240ms section slide.
- Do NOT change the tab colors, weights, spacing or `--transition-fast`.
- No new dependencies.
- If the code has drifted since d5a91c7, STOP and report.

## Verification

- **Mechanical**:
  - `npm run check:types`
  - `npm run lint`
  - `node tools/dev/test-ui-kit.mjs`
  - `node tools/dev/test-viewports.mjs`
  - `node tools/dev/test-ui-state.mjs` (tab state/pressed state, if it covers nav tabs)
- **Feel check**:
  - Click through all five tabs quickly. The active pill must change color/weight/shadow without any scale bounce; the section content still slides in the click direction.
  - In DevTools Console, click a tab and inspect the newly active `.nav-tab`: `getAnimations()` must not contain `tabPillPop`; color/background transitions may still be running.
  - Press and hold a tab: the `:active` 0.96 scale feedback must still appear on pointer-down.
  - Toggle reduced motion: tab switching remains instant/color-only (no movement).
- **Done when**: no `tabPillPop` animation exists; press feedback and section direction remain.
